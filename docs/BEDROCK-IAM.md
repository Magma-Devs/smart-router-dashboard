# Giving the api an AWS identity for Bedrock

The api signs Bedrock calls with **SigV4 from the default AWS credential
chain** (`apps/api/src/services/bedrock.ts`). It never reads an API key, and it
does not care *how* the process got an identity. The same build therefore
serves both places we run it:

| | What you configure | Where the identity comes from |
|---|---|---|
| **Local dev** | nothing | `aws configure` — if `aws sts get-caller-identity` answers, so does the dashboard |
| **Customer's dedicated server** | `BEDROCK_ROLE_ARN` | the box proves itself once (section 1), the SDK assumes that role on top |

**None of what follows is a code change.** Your job is to give the process an
identity; the api already knows what to do with one.

> Account `811430801429` region `us-east-1` model
> `global.anthropic.claude-sonnet-5`

## Local, right now

If `aws configure` is done, you are finished:

```bash
aws sts get-caller-identity     # must answer
BEDROCK_ENABLED=true AUTH_MODE=enabled pnpm --filter @sr/api dev
```

Leave `BEDROCK_ROLE_ARN` unset — the chain's own identity is used directly.
Everything below is for the customer deployment.

## Already set up — you do NOT repeat this

Provisioned in account `811430801429` on 2026-09-22 and shared by **every**
customer deployment. One role for all of them; adding a deployment adds no AWS
resources.

| | |
|---|---|
| Role | `arn:aws:iam::811430801429:role/SmartRouterDashboardBedrock` |
| Policy | `SmartRouterDashboardBedrockInvoke` — Sonnet 5 only, verified to deny every other model |
| Trust anchor | `arn:aws:rolesanywhere:us-east-1:811430801429:trust-anchor/587b3dfa-a58a-4fed-9121-72121a6cecbf` |
| Profile | `arn:aws:rolesanywhere:us-east-1:811430801429:profile/2d5a53ad-ee1f-483c-83ae-c2c78653b542` |
| CA | `~/bedrock-ca/` on Omer's machine — **`ca.key` belongs in a vault** |

Verified end to end: certificate → role session → `SMART_ROUTER_BEDROCK_OK`, and
the same role denied on `nova-micro` with `AccessDeniedException`.

## Per deployment — the only steps you repeat

### 1. Issue a certificate for the new server

On the machine holding the CA:

```bash
cd ~/bedrock-ca
HOST=<customer>-dash-01          # anything unique; it names the box in CloudTrail

openssl genrsa -out ${HOST}.key 2048
chmod 600 ${HOST}.key
openssl req -new -key ${HOST}.key -out ${HOST}.csr -subj "/CN=${HOST}/O=Magma Devs"
openssl x509 -req -in ${HOST}.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out ${HOST}.crt -days 365 -sha256 -extfile client-ext.cnf -extensions client
```

`client-ext.cnf` is already in `~/bedrock-ca`. The extensions are not optional —
Roles Anywhere rejects a client certificate without `digitalSignature`.

### 2. Copy two files to the server

`${HOST}.crt` and `${HOST}.key` → `/etc/smart-router/`, mode `0600`, owned by the
user the api runs as. **Never copy `ca.key`** — that one signs new identities.

### 3. Install the signing helper there

```bash
# x86_64. Swap X86_64→Aarch64 for arm; Linux→Darwin for macOS.
sudo curl -sSLo /usr/local/bin/aws_signing_helper \
  https://rolesanywhere.amazonaws.com/releases/1.6.0/X86_64/Linux/aws_signing_helper
sudo chmod +x /usr/local/bin/aws_signing_helper
```

### 4. Point the credential chain at it

```ini
# ~/.aws/config for the api's user — all one line after `credential_process =`
[default]
region = us-east-1
credential_process = /usr/local/bin/aws_signing_helper credential-process --certificate /etc/smart-router/dash.crt --private-key /etc/smart-router/dash.key --trust-anchor-arn arn:aws:rolesanywhere:us-east-1:811430801429:trust-anchor/587b3dfa-a58a-4fed-9121-72121a6cecbf --profile-arn arn:aws:rolesanywhere:us-east-1:811430801429:profile/2d5a53ad-ee1f-483c-83ae-c2c78653b542 --role-arn arn:aws:iam::811430801429:role/SmartRouterDashboardBedrock
```

Leave **`BEDROCK_ROLE_ARN` unset.** The profile already maps the certificate onto
the role; setting it too would assume a role on top of a role.

### 5. Turn it on and check

```bash
BEDROCK_ENABLED=true
AUTH_MODE=enabled
```

```bash
aws sts get-caller-identity        # expect assumed-role/SmartRouterDashboardBedrock/...
curl -s localhost:8000/api/ai/health
```

`{"ok":true,...}` and you are done.

### Revoking one server

Certificates are per host, so a compromised box is revocable on its own — delete
its `.crt`/`.key` and its credentials die within the hour. To cut **every**
deployment at once, disable the profile:

```bash
aws rolesanywhere disable-profile --region us-east-1 \
  --profile-id 2d5a53ad-ee1f-483c-83ae-c2c78653b542
```

---

# Reference — how the one-time setup was built

Only needed to rebuild it, or to audit what exists. **Skip it for a new
deployment.**

## 0. The permissions policy (both options)

Today's credential uses `AmazonBedrockLimitedAccess`, which grants
`bedrock:InvokeModel` on `Resource: "*"` — every model in the account. Scope it
to the one model the dashboard actually calls.

An inference profile needs permission on **both** the profile and the
foundation models it routes to. These ARNs are read from the live account, not
guessed:

```bash
cat > /tmp/bedrock-invoke-sonnet5.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeSonnet5ViaGlobalProfile",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:us-east-1:811430801429:inference-profile/global.anthropic.claude-sonnet-5",
        "arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5"
      ]
    }
  ]
}
JSON

aws iam create-policy \
  --policy-name SmartRouterDashboardBedrockInvoke \
  --description "Invoke Claude Sonnet 5 only — dashboard AI surfaces" \
  --policy-document file:///tmp/bedrock-invoke-sonnet5.json
```

Keep the returned `Arn`; both options attach it.

> The region-less `arn:aws:bedrock:::foundation-model/...` entry is not a typo.
> A `global.` profile may route to any commercial region, and that ARN is how
> the profile's own model list expresses it. Dropping it produces an
> `AccessDeniedException` only when traffic happens to route elsewhere — the
> worst kind of bug to debug.

---

## 1. IAM Roles Anywhere (recommended)

AWS trusts a CA you own; each server presents a certificate and exchanges it
for temporary credentials.

### 1.1 Create a CA

Skip if you already run one — use the existing root and go to 1.2.

AWS rejects a CA certificate with no **path length constraint** —
`-subj` alone produces one and fails with "Incorrect basic constraints for CA
certificate". The extensions file is required:

```bash
mkdir -p ~/bedrock-ca && chmod 700 ~/bedrock-ca && cd ~/bedrock-ca

cat > ca-ext.cnf <<'CFG'
[req]
distinguished_name = dn
x509_extensions    = v3_ca
prompt             = no

[dn]
CN = Magma Devs Bedrock CA
O  = Magma Devs

[v3_ca]
# pathlen:0 — signs server certificates only, never another CA.
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage         = critical, keyCertSign, cRLSign, digitalSignature
subjectKeyIdentifier = hash
CFG

openssl genrsa -out ca.key 4096
chmod 600 ca.key
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt -config ca-ext.cnf
```

And the client extensions used in step 1 of the per-deployment section:

```bash
cat > client-ext.cnf <<'CFG'
[client]
basicConstraints = critical, CA:FALSE
keyUsage         = critical, digitalSignature
extendedKeyUsage = clientAuth
CFG
```

`ca.key` is now the most sensitive file in this process — anyone holding it can
mint an identity AWS will trust. Keep it off the Vultr boxes.

### 1.2 Register the CA as a trust anchor

A PEM does not survive the CLI's shorthand syntax — build the payload as JSON:

```bash
python3 - <<'JSONGEN' > /tmp/ta.json
import json
print(json.dumps({
  "name": "magma-bedrock-ca",
  "enabled": True,
  "source": {"sourceType": "CERTIFICATE_BUNDLE",
             "sourceData": {"x509CertificateData": open("ca.crt").read()}},
}))
JSONGEN

aws rolesanywhere create-trust-anchor --region us-east-1 --cli-input-json file:///tmp/ta.json
```

Note the returned `trustAnchorArn`.

### 1.3 Create the role

The trust policy names the Roles Anywhere service, and the `aws:SourceArn`
condition pins it to **your** trust anchor — without it, the role is reachable
from any trust anchor in any account (the confused-deputy problem).

```bash
TA_ARN=<trustAnchorArn from 1.2>

cat > /tmp/trust.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "rolesanywhere.amazonaws.com" },
      "Action": ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
      "Condition": { "ArnEquals": { "aws:SourceArn": "${TA_ARN}" } }
    }
  ]
}
JSON

aws iam create-role \
  --role-name SmartRouterDashboardBedrock \
  --description "Dashboard api on Vultr — Bedrock only" \
  --assume-role-policy-document file:///tmp/trust.json

aws iam attach-role-policy \
  --role-name SmartRouterDashboardBedrock \
  --policy-arn arn:aws:iam::811430801429:policy/SmartRouterDashboardBedrockInvoke
```

### 1.4 Create the profile

A profile is what maps a presented certificate onto a role.

```bash
aws rolesanywhere create-profile \
  --region us-east-1 \
  --name smart-router-dashboard \
  --enabled \
  --duration-seconds 3600 \
  --role-arns arn:aws:iam::811430801429:role/SmartRouterDashboardBedrock
```

Note the returned `profileArn`.

### 1.5 Issue a certificate per server

One per host, so a compromised box is revocable on its own.

```bash
cd ~/bedrock-ca
HOST=dash-01
openssl genrsa -out ${HOST}.key 2048
openssl req -new -key ${HOST}.key -out ${HOST}.csr -subj "/CN=${HOST}"
openssl x509 -req -in ${HOST}.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out ${HOST}.crt -days 365 -sha256
```

Copy `${HOST}.crt` and `${HOST}.key` to the server (`0600`, owned by the api
user). **Never copy `ca.key`.**

### 1.6 Install the signing helper on the server

```bash
# x86_64 — for arm64 swap X86_64 for Aarch64
sudo curl -sSLo /usr/local/bin/aws_signing_helper \
  https://rolesanywhere.amazonaws.com/releases/1.6.0/X86_64/Linux/aws_signing_helper
sudo chmod +x /usr/local/bin/aws_signing_helper
```

### 1.7 Point the credential chain at it

The SDK runs `credential_process` and caches what it returns until it expires.
This is the whole integration — no application config.

```ini
# ~/.aws/config  (for the user the api runs as)
[default]
region = us-east-1
credential_process = /usr/local/bin/aws_signing_helper credential-process \
  --certificate /etc/smart-router/bedrock.crt \
  --private-key  /etc/smart-router/bedrock.key \
  --trust-anchor-arn arn:aws:rolesanywhere:us-east-1:811430801429:trust-anchor/587b3dfa-a58a-4fed-9121-72121a6cecbf \
  --profile-arn      arn:aws:rolesanywhere:us-east-1:811430801429:profile/2d5a53ad-ee1f-483c-83ae-c2c78653b542 \
  --role-arn         arn:aws:iam::811430801429:role/SmartRouterDashboardBedrock
```

In Docker, mount `~/.aws/config`, the two cert files and the helper binary into
the api container, or run the helper on the host and pass the credentials in as
env vars via `aws_signing_helper credential-process` in an entrypoint.

### When to set `BEDROCK_ROLE_ARN` (and when not to)

Two different things can hand the process a role, and setting both assumes a
role on top of a role — which fails unless you meant it.

| Situation | `BEDROCK_ROLE_ARN` |
|---|---|
| Roles Anywhere as set up above — the profile already maps the certificate onto the role | **leave unset** |
| The box has some other base identity (an instance profile, a key) and should act as a role | **set it** |
| The customer gives us a role in **their** AWS account | **set it**, plus `BEDROCK_ROLE_EXTERNAL_ID` |

The last row is the cross-account case. The customer creates the role and the
policy from section 0 in their own account, trusts our identity in its trust
policy, and gives us the ARN and an external id. Their Bedrock bill, their
CloudTrail, their revocation — and nothing of theirs is stored here beyond two
non-secret strings and the external id.

Set the external id whenever the role is not ours. Without it, anyone the role
trusts who also learns the ARN can assume it; that is the confused-deputy
problem, and `sts:ExternalId` is the standard guard.

### 1.8 Verify

```bash
aws sts get-caller-identity     # expect assumed-role/SmartRouterDashboardBedrock/...
curl -s localhost:8000/api/ai/health
```

`{"ok":true,...}` means done. See the reasons table at the bottom otherwise.

---

## 2. Scoped IAM user key (fallback)

Only if you need it working today. It puts a long-lived credential on the box —
the thing section 1 exists to avoid — but scoped to one model rather than `*`.

```bash
aws iam create-user --user-name smart-router-dashboard-vultr
aws iam attach-user-policy \
  --user-name smart-router-dashboard-vultr \
  --policy-arn arn:aws:iam::811430801429:policy/SmartRouterDashboardBedrockInvoke
aws iam create-access-key --user-name smart-router-dashboard-vultr
```

The output contains the only copy of the secret. Put it straight into the
server's secret store — never into a terminal that logs, a chat window, or this
repo.

```ini
# ~/.aws/credentials on the server, 0600, owned by the api user
[default]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
```

Then set a calendar reminder to rotate it. That reminder is the part everyone
skips, which is why section 1 is the recommendation.

---

## Enabling it

Identity is only half the gate. The api also needs:

```bash
BEDROCK_ENABLED=true     # off by default — model calls cost money
AUTH_MODE=enabled        # refused while auth is off; see below
```

`bedrockGate()` refuses to serve AI while `AUTH_MODE=disabled`, because that
mode installs no `/api/*` gate at all — an open api would let anyone who can
reach it spend the account's Bedrock budget under this identity.

`GET /api/ai/health` reports exactly which check failed:

| `reason` | Fix |
|---|---|
| `disabled` | `BEDROCK_ENABLED=true` |
| `auth_required` | `AUTH_MODE=enabled` (and its `AUTH_SECRET` / `DATABASE_URL`) |
| `no_credentials` | The chain resolved nothing — check `aws sts get-caller-identity` as the api's user |

An `AccessDeniedException` on an actual call, with credentials resolving fine,
means the policy or the model access, not the identity — check that Sonnet 5 is
enabled in the region and that the policy from section 0 is attached.

## Afterwards

Delete the MAG-3702 credential. Once the api has an identity of its own, the
IAM user `smart-router-dashboard-dev` and its **non-expiring** key on
`Resource: "*"` have no consumer, and the safest credential is one that does
not exist:

```bash
aws iam list-access-keys --user-name smart-router-dashboard-dev
aws iam delete-access-key --user-name smart-router-dashboard-dev --access-key-id <id>
```

The GitHub repo secret `SMART_ROUTER_DASHBOARD_BEDROCK_API_KEY` can go with it
unless a workflow starts using it — nothing does today.

Bedrock has no per-key budget, so set an **AWS Budget alarm** on the account
before this is reachable from anywhere.

## Related

- [`CLAUDE.md`](../CLAUDE.md) — the `BEDROCK_*` env table
- `apps/api/src/services/bedrock.ts` — the client, and why it holds no credential
- [IAM Roles Anywhere](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/introduction.html)
