# Giving the api an AWS identity for Bedrock

The api signs Bedrock calls with **SigV4 from the default AWS credential
chain** (`apps/api/src/services/bedrock.ts`). It never reads an API key and
does not care how the process got an identity, so one build serves both places
we run it:

| | What you configure | Where the identity comes from |
|---|---|---|
| **Anyone, quickest** | `AWS_BEARER_TOKEN_BEDROCK` | the Bedrock API key MAG-3702 provisioned |
| **Local dev** | nothing | `aws configure` |
| **Customer's dedicated server** | a certificate | IAM Roles Anywhere → the shared role |

The SDK resolves all three; our code reads none of them. A bearer token wins
when set, otherwise SigV4 from the chain.

Account `811430801429` · region `us-east-1` · model
`global.anthropic.claude-sonnet-5`.

## Just make it work

On a fresh clone, with no Postgres and no AWS config — **on your own machine
only**:

```bash
API_HOST=127.0.0.1 \
BEDROCK_ENABLED=true \
BEDROCK_ALLOW_UNAUTHENTICATED=true \
AWS_BEARER_TOKEN_BEDROCK=<the key> \
pnpm --filter @sr/api dev

curl -X POST localhost:8000/api/ai/verify
```

`BEDROCK_ALLOW_UNAUTHENTICATED` lets AI run under the default
`AUTH_MODE=disabled`, which installs no `/api/*` gate. It is honoured **only
while the api listens on loopback** (`API_HOST=127.0.0.1`), so nothing but this
machine can call it. On any other address — the `0.0.0.0` default, and every
container — the flag is ignored, AI answers `auth_required`, and the api logs
why at boot. Anywhere reachable, AI needs `AUTH_MODE=enabled`.

Drop `AWS_BEARER_TOKEN_BEDROCK` and it uses your own `aws configure` identity
instead. For anything other than your own machine, drop both
`API_HOST=127.0.0.1` and `BEDROCK_ALLOW_UNAUTHENTICATED`, and set
`AUTH_MODE=enabled`.

## Per-deployment API key (the simple path)

A key per customer deployment, handed over in that deployment's own YAML. No
CA, no certificates, no signing helper — and because the key is per deployment,
revoking one customer does not touch the others.

Mint it **scoped and expiring**. `create-service-specific-credential` without
`--credential-age-days` produces a credential that never expires, which is how
MAG-3702's ended up permanent:

```bash
CUST=acme
aws iam create-user --user-name sr-dash-${CUST}
aws iam attach-user-policy --user-name sr-dash-${CUST} \
  --policy-arn arn:aws:iam::811430801429:policy/SmartRouterDashboardBedrockInvoke
aws iam create-service-specific-credential --user-name sr-dash-${CUST} \
  --service-name bedrock.amazonaws.com --credential-age-days 90
```

Note the two differences from the credential the ticket provisioned: the narrow
policy instead of `AmazonBedrockLimitedAccess` on `Resource: "*"`, and an expiry.
The secret is printed **once**.

Then in that deployment's env file — never in a file that is committed:

```bash
# /etc/smart-router/.env, 0600, read by docker compose
BEDROCK_ENABLED=true
AWS_BEARER_TOKEN_BEDROCK=<the value printed once>
```

`docker-compose.yml` passes these through. The deployment must also run with
`AUTH_MODE=enabled`: the api is reachable through its published port, so AI
without sign-in is refused there, and there is no flag that turns that off.

To revoke one customer, or to rotate on expiry:

```bash
aws iam list-service-specific-credentials --user-name sr-dash-${CUST}
aws iam delete-service-specific-credential --user-name sr-dash-${CUST} \
  --service-specific-credential-id <id>
```

**Versus the certificate path below:** a key is a password sitting on a server
until it expires, and anyone who reads that env file has it. A certificate
yields credentials that expire hourly and can be tied to one host. Per-customer
keys with a 90-day life are a reasonable middle — they keep the blast radius to
one deployment and force rotation — but they are not as good, and the
difference is one you accept knowingly rather than by default.

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

### 2. Copy the certificate and key to the server

As `/etc/smart-router/dash.crt` and `/etc/smart-router/dash.key`. The key must
be readable by the user the api runs as — in the container that is `node`,
uid 1000, not root:

```bash
sudo chown 1000:1000 /etc/smart-router/dash.key && sudo chmod 400 /etc/smart-router/dash.key
```

**Never copy `ca.key`** — that one signs new identities.

### 3. Install the signing helper there

```bash
# Swap X86_64→Aarch64 for arm, Linux→Darwin for macOS.
sudo curl -sSLo /usr/local/bin/aws_signing_helper \
  https://rolesanywhere.amazonaws.com/releases/1.6.0/X86_64/Linux/aws_signing_helper
sudo chmod +x /usr/local/bin/aws_signing_helper
```

### 4. Point the credential chain at it

```ini
# /etc/smart-router/aws-config — one line after `credential_process =`
[default]
region = us-east-1
credential_process = /usr/local/bin/aws_signing_helper credential-process --certificate /etc/smart-router/dash.crt --private-key /etc/smart-router/dash.key --trust-anchor-arn arn:aws:rolesanywhere:us-east-1:811430801429:trust-anchor/587b3dfa-a58a-4fed-9121-72121a6cecbf --profile-arn arn:aws:rolesanywhere:us-east-1:811430801429:profile/2d5a53ad-ee1f-483c-83ae-c2c78653b542 --role-arn arn:aws:iam::811430801429:role/SmartRouterDashboardBedrock
```

Leave **`BEDROCK_ROLE_ARN` unset.** The profile already maps the certificate
onto the role; setting it too assumes a role on top of a role. It exists for
the other case — a base identity that must act as some *other* role, such as
one a customer owns in their own account. Then set `BEDROCK_ROLE_EXTERNAL_ID`
too, or anyone that role trusts who learns its ARN can assume it.

### 5. Run the api container with it

```bash
docker compose -f docker-compose.yml -f docker-compose.bedrock-cert.yml up -d
```

[`docker-compose.bedrock-cert.yml`](../docker-compose.bedrock-cert.yml) mounts
the three files above and the signing helper into the api container, read-only,
and points the SDK at `aws-config`. Different paths on the host:
`SR_BEDROCK_DIR` (default `/etc/smart-router`) and `AWS_SIGNING_HELPER`
(default `/usr/local/bin/aws_signing_helper`).

**Tested** on 27 Sep 2026 in the api container, through this override: the
api's own Bedrock call answered with credentials signed by the certificate, and
the same call with a revoked certificate was refused. Two things had to change
for that — the image carries `gcompat`, because AWS builds the helper against
glibc and the image is Alpine (without it: `aws_signing_helper: not found`), and
an empty `AWS_BEARER_TOKEN_BEDROCK` is no longer passed or honoured (it made the
SDK try an API key that did not exist).

### 6. Turn it on and check

```bash
BEDROCK_ENABLED=true     # the override sets this
AUTH_MODE=enabled        # required: this api is reachable
```

```bash
AWS_CONFIG_FILE=/etc/smart-router/aws-config aws sts get-caller-identity
# expect assumed-role/SmartRouterDashboardBedrock/...
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
| `Could not load credentials from any providers` | The helper was refused. Run the `credential_process` line by hand on the host to see why — `Certificate revoked`, an expired certificate, or the wrong trust anchor |
| `aws_signing_helper: not found` | The api image predates `gcompat` — rebuild it |
| `ok: true` | Done |

### Revoking one server

**Revocation is in place.** A revocation list (CRL) signed by our CA is on the
trust anchor: `magma-bedrock-crl` (`f2980e7e-4088-4678-ab8a-d872f3c3c46a`). The
CA keeps its record of what it revoked next to `ca.key` — `ca.cnf`,
`index.txt` and `crlnumber` in `~/bedrock-ca` — and the four move to the vault
together.

To revoke one server's certificate:

```bash
cd ~/bedrock-ca
openssl ca -config ca.cnf -revoke ${HOST}.crt -crl_reason keyCompromise
openssl ca -config ca.cnf -gencrl -out crl.pem
openssl crl -in crl.pem -outform DER -out crl.der
aws rolesanywhere update-crl --region us-east-1 \
  --crl-id f2980e7e-4088-4678-ab8a-d872f3c3c46a --crl-data fileb://crl.der
```

**It takes effect at once.** Tested on 27 Sep 2026: a certificate that was
getting credentials was refused with `AccessDeniedException: Certificate
revoked` within a second of the import, while another certificate from the same
CA kept working. Only the listed certificates are affected — the list's first
entry is the throwaway certificate that test used.

Roles Anywhere never fetches a CRL; it uses the one imported. So re-sign and
re-import after every revocation. The list is valid for ten years, so its own
date is never why a sign-in fails.

Deleting a server's `.crt`/`.key` is **not** revocation: it stops that machine
getting fresh credentials, but a copy keeps working until the certificate
expires.

To cut **every** deployment at once — an emergency, such as `ca.key` itself
being exposed:

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
