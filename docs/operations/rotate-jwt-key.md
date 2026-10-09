# Rotating the JWT signing key

Two restarts, zero refusals. The old key stays accepted for the lifetime of an
access token, and is then retired.

---

## What survives a rotation and what does not

| | What it is | When the key changes |
|---|---|---|
| Access token | a JWT, signed with `NACRE_JWT_SECRET` | survives while `_PREVIOUS` is set |
| Refresh token | 32 bytes from a CSPRNG, hashed in `refresh_tokens` | survives |
| Service account key | a hash in `service_accounts` | survives |
| Second factor, TOTP | a secret, sealed with **`NACRE_2FA_KEY`** | survives: that is a different key, and this runbook does not touch it |
| Second factor, WebAuthn | a public key and a counter in the database | survives: nothing of ours signs it and nothing seals it |

A refresh token and a service account key survive a rotation unconditionally,
because **neither of them is signed** with this key, and neither is a JWT at
all: both are random bytes whose hash sits in a table. The signing key plays no
part in checking them.

An access token is signed, and what happens to it depends on
`NACRE_JWT_SECRET_PREVIOUS`: with it, the token survives until it expires on its
own; without it, the token dies at the moment of the restart.

Service account keys are hashes in the database too, and agents connecting over
MCP do not notice a rotation at all.

**`NACRE_2FA_KEY` is a separate key, and it has no window.** TOTP secrets are
sealed with it in `user_second_factors`, there is no `_PREVIOUS` for it, and
changing it makes every enrolled **TOTP** authenticator in the installation
useless. That is not a rotation but a re-enrolment of everybody: what people are
left with are the recovery codes issued when they turned it on. It is named here
only so that nobody rotates it "while they are at it" — this runbook is about the
signing key and does nothing to it.

Since 0.19.0 it does not touch WebAuthn keys: those store a public key rather
than a shared secret, and there is nothing to seal. They have a binding and an
irreversibility of their own — **`NACRE_CANONICAL_URL`**. The relying party is
taken from its host, so changing the installation's name is exactly what changing
`NACRE_2FA_KEY` is for TOTP, and it has no window either.

## How the window closes

`NACRE_JWT_SECRET_PREVIOUS` **is accepted on verification and never used for
signing**. While it is set, tokens signed with the outgoing key keep passing;
everything issued after the restart is signed with the new one.

The variable is needed because a token does not say which key signed it: an
HS256 token carries no `kid`, since there is no published key for one to name,
and the verifier tries the current key and then the previous one rather than
choosing by `kid` in either mode. Changing the secret without the variable
therefore voids every issued access token at once. **The SDK can now renew itself** — a client constructed with a refresh
token exchanges it for a new pair on a 401 and repeats the request (one exchange
for a whole batch of concurrent requests, not one each: presenting a spent
refresh token again revokes the whole family). But that only saves a caller that
has a refresh token: a raw request carrying only an access token, and a client
built without a refresh token, still get a 401. The `_PREVIOUS` window covers
those too — the retired key is accepted on verification until
`NACRE_ACCESS_TOKEN_TTL` has passed, so no token already issued drops off,
whether or not its client renews itself.

One additional key, not a list. A list raises the question of which of them to
sign with, and puts an unbounded number of HMAC checks on the path every invalid
token takes. Two are enough for a rotation.

A rotation without the second key is also workable, if an outage of one
`NACRE_ACCESS_TOKEN_TTL` is acceptable: skip the `_PREVIOUS` step. But there is
no reason to do it that way by default.

## Two signing modes, and how they change the rotation

`NACRE_JWT_PRIVATE_KEY_REF` **is implemented**. This section used to say it was
not, and that is no longer true.

| | What signs | Who can issue a token |
|---|---|---|
| `NACRE_JWT_SECRET` | HS256, a shared secret | **any process that verifies with it** — `api`, `mcp`, `mcp` over STDIO |
| `NACRE_JWT_PRIVATE_KEY_REF` | EdDSA, Ed25519 | only whoever holds the private half |

Both cannot be configured at once — startup fails: they are two answers to the
question "what is the token signed with", and there is no order of precedence
worth inventing.

**Symmetric mode.** Every process that verifies tokens knows the secret, so the
rotation has to be simultaneous for both — otherwise one half of the
installation will not accept tokens issued by the other. That is the plan below,
unchanged.

**Asymmetric mode.** The public half verifies and the private half signs, and
that is the only difference that matters here: a process that only verifies does
not need the private key at all. The plan is the same, step by step, with two
substitutions:

- instead of `openssl rand -base64 48` in step 2:

  ```bash
  openssl genpkey -algorithm ed25519 -out /run/secrets/jwt_ed25519_new
  ```

  Ed25519 only — the installation refuses a key of any other type at startup and
  says which type it is. And only the `file://` scheme.

- instead of `NACRE_JWT_SECRET` / `NACRE_JWT_SECRET_PREVIOUS` —
  `NACRE_JWT_PRIVATE_KEY_REF` / `NACRE_JWT_PREVIOUS_KEY_REF`. Pointing both at the
  same file is refused at startup too: that is not a rotation, it is accepting one
  key twice.

The fingerprint in the log in step 3 looks like `ed25519:…` instead of
`sha256:…`, and `jwt_alg` beside it — printed in both modes — reads `EdDSA`
instead of `HS256`. The fingerprint is computed over the **public** half — so a
process holding the private key and a process without it print the same value,
and comparing two startup lines keeps working.

Tokens signed with an Ed25519 key do carry a `kid`: the same fingerprint, without
the `ed25519:` prefix, that the JWKS document below lists for the key. It tells
an external verifier which published key to use; this installation's own
verifier does not need it, which is why the `_PREVIOUS` window is still what
keeps old tokens valid.

**Plus one check that symmetric mode does not have.** The public key is served
at `/.well-known/jwks.json`, and anything that verifies tokens outside the
installation — an ingress, a sidecar — reads it from there. In step 5, confirm
that there are already two keys there, and in step 8 that one is left:

```bash
curl -s "$NACRE_CANONICAL_URL/.well-known/jwks.json" | jq '.keys | length, .[].kid'
```

The outgoing key stays in the JWKS for the whole window on purpose: tokens
signed with it are still in circulation, and an external verifier has to be able
to check them.

## Under the Helm chart: `mcp` verifies with the public key

Everything above is about Compose, where `api`, `mcp` and `worker` read one
`.env`, so in asymmetric mode the private key sits with all three. The chart
separates them: `api` gets `jwt.privateKeyExistingSecret` and signs, while `mcp`
gets `jwt.publicKeyExistingSecret` (`NACRE_JWT_PUBLIC_KEY_REF`, with
`NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF` for the window) and **only verifies**. The
private half never reaches the `mcp` pod at all — whoever reads its environment
gains the ability to check tokens, not to issue them.

That changes two things in the plan:

- **The processes hold different material.** Step 4 here is not "one secret
  into both processes", but the new private key into the secret `api` reads, and
  the new **public** half into the secret `mcp` reads. `NACRE_JWT_PREVIOUS_KEY_REF`
  lives on the `api` side, `NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF` on the `mcp` side.
- **The verifier goes first.** Symmetric mode requires restarting `api` and
  `mcp` in one command, because otherwise the shared secret opens a window in
  which the two disagree. Here it is the other way round: first `mcp` starts
  accepting the new public half (it goes into `_PREVIOUS_PUBLIC`), and only then
  does `api` switch to signing with the new private key. A verifier that does not
  yet know the new key would reject a fresh token — one that knows both accepts
  old tokens and new ones alike.

With `jwt.publicKeyExistingSecret` empty, `mcp` falls back to the private key and
verifies with it (the comment in
[`values.yaml`](../../deploy/helm/nacre/values.yaml) says so), and then the
rotation goes exactly like the symmetric one, in lockstep, with the private key
in both processes again. The `/.well-known/jwks.json` check from step 5 is the
same in both cases: the public half is served from there, and an external
verifier reads the window there.

---

## The plan

### 1. Find out how long to wait between the restarts

```bash
docker compose exec api printenv NACRE_ACCESS_TOKEN_TTL
```

That is the interval between step 4 and step 8: within it, every token signed
with the outgoing key expires. The hour of peak traffic does not matter — there
are no refusals at any step.

The exception is a **forced** rotation. A leaked key must not stay valid for
another `NACRE_ACCESS_TOKEN_TTL`, so step 4 is done straight away with an empty
`NACRE_JWT_SECRET_PREVIOUS`, step 8 falls away, and client refusals are accepted
as the price. After that, go on to
[If the rotation was forced](#if-the-rotation-was-forced).

### 2. Generate the secret

```bash
openssl rand -base64 48
```

At least 32 bytes — the API does not start with a shorter one.

**Do not commit the secret.** A key that reaches a commit means **rotating the
key**, not deleting the commit. The value goes into the platform's secret store,
or into an `.env` on a host that is not under git.

### 3. Record the current key's fingerprint

The API prints it at startup — it is what later tells you the rotation has
landed:

```bash
# Both fingerprint schemes: sha256: for a symmetric key, ed25519: for an asymmetric one.
# A grep pinned to one of them silently finds nothing in the other mode — and step 5
# will have nothing to compare against.
docker compose logs api | grep -o '"jwt_key":"[^"]*"' | tail -1
```

The fingerprint, not the secret: an operator needs to know which key is in use
when two environments disagree, and nobody needs the key itself in a log.

### 4. First restart: the new key signs, the old one is still accepted

```bash
# in the secret store / .env
NACRE_JWT_SECRET_PREVIOUS=<what was in NACRE_JWT_SECRET>
NACRE_JWT_SECRET=<new>

docker compose up -d --force-recreate api mcp
```

**Both, and in one command.** `api` and `mcp` verify tokens with the same
secret; restarting them one after the other leaves a gap in which one accepts
tokens the other rejects — and that looks like random 401s on some requests, the
worst symptom there is.

The process refuses to start if `NACRE_JWT_SECRET_PREVIOUS` equals
`NACRE_JWT_SECRET` — that is what you get when the wrong line was copied, and the
installation would then believe it had rotated when it had not.

### 5. Confirm the key changed and the old one is still accepted

```bash
docker compose logs --no-log-prefix --since 2m api | grep '"api listening"' | tail -1 | jq -c '{jwt_alg, jwt_key, jwt_key_previous}'
docker compose logs --no-log-prefix --since 2m mcp | grep '"mcp listening"' | tail -1 | jq -c '{jwt_alg, jwt_key, jwt_key_previous}'
```

```json
{"jwt_alg":"HS256","jwt_key":"sha256:451e80dae6be","jwt_key_previous":["sha256:dfdff7afb059"]}
```

That reads the JSON line each process prints when it starts listening, which is
what the default `NACRE_LOG_FORMAT=json` produces.

Three checks in one line:

- `jwt_key` differs from what you recorded in step 3 — the new key has landed;
- `jwt_key_previous` contains **exactly what you recorded in step 3** — the
  window is open, and old tokens pass;
- the two lines, `api` and `mcp`, match each other.

If it matches the old fingerprint, the process came up with the old environment;
if the two lines differ from each other, one of the two did not reread the
secret.

> `mcp` started printing the fingerprint recently; on a build older than that
> change the second command returns nothing. There is then nothing to compare
> against — and a disagreement between `api` and `mcp` is exactly what produces
> 401s on some requests and not on others. Upgrade the image before rotating the
> key.

### 6. Check both sides of the boundary

The old access token must **work** — that is what the window is open for:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/v1/layers -H "authorization: Bearer $OLD_TOKEN"
```

200. A 401 means `NACRE_JWT_SECRET_PREVIOUS` did not land, and you must not go
further: this is the rotation with an outage, only unplanned.

The refresh token must work:

```bash
curl -s -X POST localhost:8080/v1/auth/refresh -H 'content-type: application/json' \
  -d "{\"refresh_token\":\"$REFRESH\"}" | jq -r '.access_token' | head -c 20
```

The service account key must work unchanged:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/v1/layers -H "authorization: Bearer $SERVICE_KEY"
```

If the third check returned anything but 200, stop. Service account keys have
nothing to do with JWTs, and their breaking means the restart touched something
else (most likely the Postgres connection, not the key).

### 7. Watch that there is no spike

**By the metric, not by the log: requests are not written anywhere.** The log
carries only `request failed` for exceptions; a credential refusal is not an
exception and never reaches the log.

```bash
watch -n10 'curl -s localhost:8080/metrics | grep "nacre_auth_failures_total{"'
```

```
nacre_auth_failures_total{kind="jwt"} 0
nacre_auth_failures_total{kind="service_key"} 0
nacre_auth_failures_total{kind="missing"} 2
```

The point of the window is that `kind="jwt"` **does not grow**. The counter is
cumulative, so what matters is the increase: if it goes up right after the
restart, the window did not open and clients are already getting errors. Go back
to step 5.

`kind="service_key"` must stay flat in any case: service account keys have
nothing to do with JWTs, and growth there means the restart touched something
else.

The counter is not labelled with the reason for the refusal, and that is
deliberate: the `401` itself answers with one text for every reason, so that an
expired token cannot be told apart from a forged one, and a reason label would
hand that distinction back through an endpoint that is unauthenticated by
default. What is counted here is **the kind of credential presented**, not what
is wrong with it.

### 8. After `NACRE_ACCESS_TOKEN_TTL`, retire the old key

This is the second restart, and it is mandatory. A `NACRE_JWT_SECRET_PREVIOUS`
left in place keeps the retired key valid — exactly what the rotation was done to
end.

Wait at least `NACRE_ACCESS_TOKEN_TTL` from step 4: by then every token signed
with the old key has expired on its own.

```bash
# in the secret store / .env
NACRE_JWT_SECRET_PREVIOUS=

docker compose up -d --force-recreate api mcp
```

An empty value is the same as no line at all. To check:

```bash
docker compose logs --no-log-prefix --since 1m api | grep '"api listening"' | tail -1 | jq -c '{jwt_alg, jwt_key, jwt_key_previous}'
```

```json
{"jwt_alg":"HS256","jwt_key":"sha256:451e80dae6be","jwt_key_previous":null}
```

`jwt_key_previous` is gone from the line — `null` is `jq` reporting a field that
is not there — so the old key is retired. And the same old token that
answered 200 in step 6 must now answer 401:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/v1/layers -H "authorization: Bearer $OLD_TOKEN"
```

If it is still 200, the variable was not removed, and the rotation is not
finished.

---

## If the rotation was forced

The leaked secret allowed a token to be issued for any organization and any role
(`org` and `role` are fields inside the JWT). Changing the key closes off the
future, not the past:

1. **Revoke every sign-in refresh token**, not only change the key. Did the
   leaked key allow signing an access token, and calling `/v1/auth/refresh` with
   it? No: refresh takes a random value, not a JWT. But it is worth checking
   whether refresh tokens were issued through a forged sign-in. Both statements
   run as the owning role (`psql "$NACRE_PG_URL_OWNER"`): `refresh_tokens` is
   under `FORCE ROW LEVEL SECURITY`, and a query across organizations as
   `nacre_app` raises rather than answers.

   ```sql
   SELECT user_id, count(*), min(issued_at), max(issued_at)
     FROM refresh_tokens WHERE revoked_at IS NULL GROUP BY user_id;
   ```

   Revoking every family:

   ```sql
   UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL;
   ```

   This signs everybody out — deliberately, because the rotation is forced.

   Connections an application holds through OAuth have refresh tokens of their
   own, in `oauth_refresh_tokens`, and this statement does not touch them. A
   connection ends when its consent is revoked — `oauth_consents.revoked_at`,
   which every delegated request checks — so review the consents approved during
   the window of compromise as well.

2. **Read the access log** for the window of compromise. `GET /v1/audit` as an
   `org_admin` shows which documents were read; as a `platform_admin`,
   administrative actions. Reading the log is itself recorded in the log as
   `audit.read`.

3. **Leave service account keys alone** — they are not signed with the JWT key.
   If more than that key leaked, that is a different incident.
