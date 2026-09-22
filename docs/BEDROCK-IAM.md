# Giving the api an AWS identity for Bedrock

The api signs Bedrock calls with **SigV4 from the default AWS credential
chain** (`apps/api/src/services/bedrock.ts`). It never reads an API key and
does not care how the process got an identity, so one build serves both places
we run it:

| | What you configure | Where the identity comes from |
|---|---|---|
| **Local dev** | nothing | `aws configure` |
| **Customer's dedicated server** | a certificate | IAM Roles Anywhere → the shared role |

Account `811430801429` · region `us-east-1` · model
`global.anthropic.claude-sonnet-5`.

## Local

If `aws sts get-caller-identity` answers, you are done:

```bash
BEDROCK_ENABLED=true AUTH_MODE=enabled pnpm --filter @sr/api dev
```

Then, signed in, `POST /api/ai/verify`.

## Already set up — never repeated

Provisioned 2026-09-22 and shared by **every** customer deployment. Adding a
deployment adds no AWS resources, only a certificate.

| | |
|---|---|
| Role | `arn:aws:iam::811430801429:role/SmartRouterDashboardBedrock` |
| Policy | `SmartRouterDashboardBedrockInvoke` — Sonnet 5 only; verified to deny every other model |
| Trust anchor | `arn:aws:rolesanywhere:us-east-1:811430801429:trust-anchor/587b3dfa-a58a-4fed-9121-72121a6cecbf` |
| Profile | `arn:aws:rolesanywhere:us-east-1:811430801429:profile/2d5a53ad-ee1f-483c-83ae-c2c78653b542` |
| CA | `~/bedrock-ca/` on Omer's machine — **`ca.key` belongs in a vault** |

## Per deployment

### 1. Issue a certificate, on the machine holding the CA

```bash
cd ~/bedrock-ca
HOST=<customer>-dash-01          # names the box in CloudTrail

openssl genrsa -out ${HOST}.key 2048 && chmod 600 ${HOST}.key
openssl req -new -key ${HOST}.key -out ${HOST}.csr -subj "/CN=${HOST}/O=Magma Devs"
openssl x509 -req -in ${HOST}.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out ${HOST}.crt -days 365 -sha256 -extfile client-ext.cnf -extensions client
```

The extensions are not optional — Roles Anywhere rejects a client certificate
without `digitalSignature`.

### 2. Copy `${HOST}.crt` and `${HOST}.key` to the server

`/etc/smart-router/`, mode `0600`, owned by the api's user. **Never copy
`ca.key`** — that one signs new identities.

### 3. Install the signing helper there

```bash
# Swap X86_64→Aarch64 for arm, Linux→Darwin for macOS.
sudo curl -sSLo /usr/local/bin/aws_signing_helper \
  https://rolesanywhere.amazonaws.com/releases/1.6.0/X86_64/Linux/aws_signing_helper
sudo chmod +x /usr/local/bin/aws_signing_helper
```

### 4. Point the credential chain at it

```ini
# ~/.aws/config for the api's user — one line after `credential_process =`
[default]
region = us-east-1
credential_process = /usr/local/bin/aws_signing_helper credential-process --certificate /etc/smart-router/dash.crt --private-key /etc/smart-router/dash.key --trust-anchor-arn arn:aws:rolesanywhere:us-east-1:811430801429:trust-anchor/587b3dfa-a58a-4fed-9121-72121a6cecbf --profile-arn arn:aws:rolesanywhere:us-east-1:811430801429:profile/2d5a53ad-ee1f-483c-83ae-c2c78653b542 --role-arn arn:aws:iam::811430801429:role/SmartRouterDashboardBedrock
```

Leave **`BEDROCK_ROLE_ARN` unset.** The profile already maps the certificate
onto the role; setting it too assumes a role on top of a role. It exists for
the other case — a base identity that must act as some *other* role, such as
one a customer owns in their own account. Then set `BEDROCK_ROLE_EXTERNAL_ID`
too, or anyone that role trusts who learns its ARN can assume it.

### 5. Turn it on and check

```bash
BEDROCK_ENABLED=true
AUTH_MODE=enabled
```

```bash
aws sts get-caller-identity     # expect assumed-role/SmartRouterDashboardBedrock/...
```

Then, signed in, `POST /api/ai/verify` — one real ~30-token call.
`GET /api/ai/health` reports only the first two rows below; it deliberately
resolves no credentials, because that blocks for seconds on IMDS when there are
none.

| Response | Meaning |
|---|---|
| `reason: disabled` | `BEDROCK_ENABLED` is not `true` |
| `reason: auth_required` | `AUTH_MODE=enabled` missing (with `AUTH_SECRET` / `DATABASE_URL`) |
| `awsErrorName: AccessDeniedException` | Credentials work; this identity may not invoke this model — the policy, the model access, or a role it cannot assume |
| `awsErrorName: ThrottlingException` | Quota. Check `maxTokens` is set before asking for an increase |
| `ok: true` | Done |

### Revoking

Certificates are per host, so one box is revocable on its own — delete its
`.crt`/`.key` and its credentials die within the hour. To cut **every**
deployment at once:

```bash
aws rolesanywhere disable-profile --region us-east-1 \
  --profile-id 2d5a53ad-ee1f-483c-83ae-c2c78653b542
```

## Rebuilding the one-time setup

Only if it is ever lost. `CERTIFICATE_BUNDLE` takes our own CA, so no AWS
Private CA and no monthly charge.

```bash
# 1. The CA. A cert built from -subj alone carries no path length constraint
#    and CreateTrustAnchor rejects it: "Incorrect basic constraints".
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
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage         = critical, keyCertSign, cRLSign, digitalSignature
subjectKeyIdentifier = hash
CFG
cat > client-ext.cnf <<'CFG'
[client]
basicConstraints = critical, CA:FALSE
keyUsage         = critical, digitalSignature
extendedKeyUsage = clientAuth
CFG
openssl genrsa -out ca.key 4096 && chmod 600 ca.key
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt -config ca-ext.cnf

# 2. Trust anchor. A PEM does not survive the CLI's shorthand syntax.
python3 -c "import json;print(json.dumps({'name':'magma-bedrock-ca','enabled':True,'source':{'sourceType':'CERTIFICATE_BUNDLE','sourceData':{'x509CertificateData':open('ca.crt').read()}}}))" > /tmp/ta.json
aws rolesanywhere create-trust-anchor --region us-east-1 --cli-input-json file:///tmp/ta.json

# 3. Policy. An inference profile needs BOTH the profile and the foundation
#    models it routes to. The region-less ARN is not a typo — a global. profile
#    may route anywhere, and omitting it denies only some of the time.
aws iam create-policy --policy-name SmartRouterDashboardBedrockInvoke --policy-document '{
  "Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],
  "Resource":["arn:aws:bedrock:us-east-1:811430801429:inference-profile/global.anthropic.claude-sonnet-5",
              "arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5",
              "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5"]}]}'

# 4. Role. The aws:SourceArn condition pins it to OUR trust anchor — without it
#    the role is reachable from any trust anchor in any account.
aws iam create-role --role-name SmartRouterDashboardBedrock --assume-role-policy-document '{
  "Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"Service":"rolesanywhere.amazonaws.com"},
  "Action":["sts:AssumeRole","sts:TagSession","sts:SetSourceIdentity"],
  "Condition":{"ArnEquals":{"aws:SourceArn":"<trust-anchor-arn>"}}}]}'
aws iam attach-role-policy --role-name SmartRouterDashboardBedrock \
  --policy-arn arn:aws:iam::811430801429:policy/SmartRouterDashboardBedrockInvoke

# 5. Profile.
aws rolesanywhere create-profile --region us-east-1 --name smart-router-dashboard \
  --enabled --duration-seconds 3600 \
  --role-arns arn:aws:iam::811430801429:role/SmartRouterDashboardBedrock
```

## Revoking the MAG-3702 credential

A Bedrock API key is a **service-specific credential**, not an access key, so
`list-access-keys` reports nothing and looks reassuring. It is not:

```bash
aws iam list-service-specific-credentials --user-name smart-router-dashboard-dev
aws iam delete-service-specific-credential --user-name smart-router-dashboard-dev \
  --service-specific-credential-id ACCA3Z3ILOAKXPXISEJUD
aws iam detach-user-policy --user-name smart-router-dashboard-dev \
  --policy-arn arn:aws:iam::aws:policy/AmazonBedrockLimitedAccess
aws iam delete-user --user-name smart-router-dashboard-dev
gh secret delete SMART_ROUTER_DASHBOARD_BEDROCK_API_KEY
```

Bedrock has no per-key budget, so set an **AWS Budget alarm** on the account.
