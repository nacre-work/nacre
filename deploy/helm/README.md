# The Nacre chart

Kubernetes-generic. Nothing in it names a cloud — ingress class, TLS secret and
node placement are values with empty defaults, so it renders the same on kind,
k3s, EKS, GKE and AKS.

```bash
helm install nacre ./deploy/helm/nacre -f my-values.yaml
```

Start from [`values/example.yaml`](values/example.yaml). Change every value.

## What it deploys

| Workload | Why it is its own Deployment |
|---|---|
| `api` | REST, `/metrics`, and the `.well-known` documents |
| `mcp` | Shares the authorization service and nothing else. An agent's connection is long-lived where a REST call is not, so the two scale on different signals — and a session held open for an hour should not pin an API replica through a rolling deploy |
| `worker` | `Recreate`, not `RollingUpdate`: nothing routes to it, so there is no availability to preserve, and a rolling update briefly runs two versions claiming from one queue |
| `parser` | Stateless and shared. One per API replica would be waste, and the worker needs it too. It gets no database credential — it never sees one |
| `web` | The console. nginx serving the admin bundle and proxying `/v1` on the same origin, which is what keeps the browser's requests from being cross-origin — the API sends no CORS headers, deliberately |
| `embedding-adapter` | **Off by default.** One protocol in, several hosted vendors out. See "The embedding adapter" below |
| migrations | A pre-install/pre-upgrade **Job**, not an initContainer. An initContainer runs once per pod, so three replicas would race three migrations on every rollout |

## What it does not deploy

**Postgres, Qdrant and Redis.** All three hold state a customer already has an
answer for — a managed Postgres with their backup policy, a Qdrant their
platform team runs, an existing Redis. A subchart would ship a default that is
easy to `helm install` and wrong for every deployment that matters, and the
failure mode is the worst kind: it works in a demo and loses data in production.

For trying Nacre out, the Compose stack at the root of this repository is the
shorter path: `docker compose --profile minimal up`.

## It refuses to render on defaults

Every endpoint and every secret has an empty default and a template that fails
rather than guessing:

```
$ helm template t ./deploy/helm/nacre
Error: canonicalUrl is required. It is the OAuth issuer and the well-known
base, and it goes into every token ever issued — moving it later breaks every
client at once.
```

That is the same rule `loadConfig` follows in the product. A default that
quietly points at localhost is how a production deployment talks to nothing and
reports success — and the chart catching it turns a CrashLoopBackOff an operator
has to read logs to understand into a `helm install` error that names the value.

Refusals it makes that the product also makes:

- `jwt.existingSecret` **and** `jwt.privateKeyExistingSecret` together — two
  answers to "what signs a token", with no precedence worth inventing.
- `s3.enabled` without all of endpoint, bucket and credentials — an endpoint
  with no credential parses and fails later.
- `reranker.enabled` with no endpoint.

And two the product cannot make, because they are not its business:

- `ingress.enabled` with no `className`. A wrong or absent class produces an
  Ingress nothing reconciles, and no error anywhere.
- `migrations.enabled` without `postgres.migrations`. The Job runs as the role
  that *owns* the tables, which is not the role the application connects as.
  See "Two Postgres credentials" below — including the refusal when both name
  the same secret and the same key, which would be one role wearing two names.

## Signing keys

`jwt.privateKeyExistingSecret` mounts an Ed25519 key as a **file**, because
`NACRE_JWT_PRIVATE_KEY_REF` takes `file://` and nothing else. That is also the
better shape here: the key never appears in `kubectl describe pod`.

With it, the key that verifies is not the key that signs, and the public half is
served at `/.well-known/jwks.json`. With a shared secret, every process that can
check a token can also mint one — reading a container's environment gets an
attacker from "can check tokens" to "can act as any administrator in any
organization" — and the JWKS endpoint `404`s, because a shared secret has no
publishable half.

The chart takes that separation all the way to the pod. The **API** signs, so it
mounts the private key. The **MCP** transport only verifies, so it mounts the
public key — set `jwt.publicKeyExistingSecret` and the private key never reaches
that process; leave it empty and MCP falls back to the private key, still
verifying but without the separation. The **worker** uses no JWT at all and
mounts neither. So a `publicKeyExistingSecret` is the difference between an MCP
pod whose compromise hands over the signing key and one whose compromise hands
over the ability to check tokens and nothing more.

`jwt.previousKeyFile` (and `jwt.previousPublicKeyFile` on the verifier) is the
rotation overlap window. See
[`docs/operations/rotate-jwt-key.md`](../../docs/operations/rotate-jwt-key.md).

## The second factor, and the mail relay

`secondFactor.existingSecret` becomes `NACRE_2FA_KEY` and `mail.existingSecret`
plus `mail.from` become `NACRE_SMTP_URL` and `NACRE_MAIL_FROM` — all three on
the **API alone**. The MCP transport verifies tokens and issues none and the
worker signs nothing, so either on those would be a secret in a pod that never
reads it.

`existingSecret` only, with no inline alternative: `helm get values` prints an
inline value back, and these open every enrolled TOTP authenticator and the
relay account respectively.

The mail pair is a **group** and the chart refuses one without the other, which
is what the container does at startup: a URL with no sender parses and fails on
the first message, so unrefused it is a link that is never delivered and a log
line on a pod nobody is reading. Under `networkPolicy.strict` the API also needs
`extraEgress` to reach the relay, and nothing fails visibly if it cannot —
`POST /v1/auth/password-reset` answers `204` whatever happened, deliberately, so
an unreachable relay is indistinguishable from an address with no account.

**`secondFactor` is TOTP's key and not the feature's switch, since core
0.19.0.** WebAuthn is the other kind and needs no key: it stores a public key
and a counter, and its relying party is `canonicalUrl`'s hostname rather than a
value here. So an installation that sets nothing still offers the *stronger* of
the two — leaving this empty removes TOTP, and the enrolment surface does not
`404`. Losing the key makes every enrolled **TOTP** authenticator useless and
leaves a security key working, which is the reason to prefer one.

Which also means `canonicalUrl` now outlives a token. Every credential a person
enrols is bound to that hostname, and unlike an audience — which expires with
the token carrying it — a security key bound to a name you stop serving is a key
nobody can use again. See "Ingress" for what follows from that.

## The embedding adapter

`embeddingAdapter.enabled` deploys the sidecar that turns one protocol into
several hosted vendors — the answer to "this cluster has no GPU and bge-m3 under
emulation blows the worker's budget".

**It is off by default, and it is inert until you enable it twice.** Routing a
model through it means the text of your documents leaves your installation, and
that is a decision the chart never makes for anyone. So:

1. `embeddingAdapter.enabled: true` with `routes` and the vendors it names —
   this renders a Deployment and a Service and changes nothing about how
   anything embeds;
2. an `embedding_providers` row whose `endpoint` is
   `http://{release}-nacre-embedding-adapter:8091` and whose `model` is one this
   routes. That is where a document first reaches a vendor.

The second step is deliberately not the chart's. The worker and both surfaces
resolve an embedder out of Postgres per layer, so the provider row is what
decides, and deploying a container is not consent to what it can do.

```yaml
embeddingAdapter:
  enabled: true
  routes: embed-large=openai-compatible,gemini-embedding-001=google
  vendors:
    openaiCompatible:
      endpoint: https://embeddings.example.com/v1
      existingSecret: nacre-embed-openai-compatible
    google:
      existingSecret: nacre-embed-google
```

`openai-compatible` is named for the **protocol**, not for a company — Together,
DeepInfra, vLLM and a self-hosted TEI all answer there, which is exactly why its
endpoint is required rather than defaulted. `voyage` is OpenAI-shaped too and
still has its own entry, because of who asks for it: Anthropic publishes no
embeddings API and points at Voyage, so that is where "embeddings from
Anthropic" lands, and it should not require knowing a URL.

A route may also name the **vendor's own spelling** of the model:

```yaml
  routes: bge-m3=cloudflare:@cf/baai/bge-m3
```

The left-hand side stays the routing key — what a provider row says and
therefore what a layer's named vector was built from. Without this, moving an
installation onto a vendor's copy of identical weights would mean renaming the
model, and a renamed model is a different vector slot and therefore a reindex of
every layer: a collection replaced and every point copied, to move vectors that
did not need to move.

### Reranking

The same container reranks, and the core needs no code for it. `HttpReranker`
speaks Text Embeddings Inference's `/rerank`, so a deployment with no GPU had
nowhere to point `reranker.endpoint`; the adapter answers that shape, which
means pointing it at `http://{release}-nacre-embedding-adapter:8091` instead of
at a TEI container is the whole change.

```yaml
reranker: { enabled: true, endpoint: http://nacre-nacre-embedding-adapter:8091 }

embeddingAdapter:
  enabled: true
  rerank:
    vendor: cohere
    model: rerank-v3.5
    vendors:
      cohere:
        existingSecret: nacre-rerank-cohere
```

**One reranker per adapter rather than a routing table**, and that asymmetry
with `routes` is forced rather than chosen: TEI's request carries a query and
its texts and no model name, because a TEI container is one model, so there is
no routing key in the request to dispatch on. `cloudflare`, `cohere`, `jina` and
`voyage` — OpenAI, Anthropic and Google publish no reranking API, so none of
them can be one.

Both `rerank.vendor` and `rerank.model`, or neither: a vendor with no model
would be a guess about which cross-encoder and a model with no vendor has
nowhere to go, and the chart refuses either half exactly as the container does.
The credentials are separate from the embedding ones even where the vendor is
the same, because the two jobs are independent — **an adapter that only reranks
is a supported shape**, and leaving `routes` empty is how you ask for it.

Credentials are `existingSecret` only, with no inline alternative — stricter than
`qdrant.apiKey` beside it, on purpose. This one is a third party's billing
credential: `--set` puts it in a shell history and `helm get values` prints it
back to anyone who can read the release. Only the vendors a route actually names
are put in the pod's environment, so a key nothing can reach is not a key the
container holds.

The chart refuses at render time everything the adapter refuses at startup —
`enabled` with neither routes nor a reranker, an entry that is not
`model=vendor`, a route ending in a colon with no upstream model, an unknown
vendor on either side, a model routed twice, a routed vendor with no credential
or no endpoint, and half a reranker. Those are second copies of the adapter's
own tables, so `scripts/check-chart-vendors.mjs` reads the real ones out of
`services/embedding_adapter/app.py` and fails if either disagrees — a
vendor added there and not here is a `helm install` refusing a value the
container would have served.

Under `networkPolicy.strict` it gets two rules: only api, mcp and worker may
reach it, and it may reach **443 on the public internet with every private range
excepted** — the one rule in this chart that opens outbound deliberately.
169.254.169.254 is in that exception list for the reason it always is. A vendor
on a private address is therefore not admitted, and that is not a gap: an
OpenAI-shaped endpoint inside your own cluster needs no adapter, because the
worker already speaks that protocol and can be pointed straight at it.

## Ingress

One host, two backends: `/mcp` to the MCP transport, everything else to the API.

A path rather than a second hostname, so one certificate and one
`NACRE_CANONICAL_URL` cover both. The canonical URL is baked into every token
ever issued, and a second hostname would mean a second audience nobody
configured.

`/.well-known/*` belongs on this host and **never on an apex**, where static
hosting intercepts the discovery path before the API sees it.

`ingress.host` is **empty by default and follows `canonicalUrl`**. It used to be
a second required value, and the two were then two answers to "what is this
installation's address" with nothing that knew there were two — every values
file in `values/` wrote them identical by hand, which is the shape that
goes wrong once. Two different names installs cleanly and comes up, and then:
the console proxies `/v1` same-origin and the API sends no CORS headers, so a
browser under the other name is refused with nothing in a log; the discovery
documents name the canonical host, so an MCP client's walk stops one step after
it starts; and since core 0.19.0 a WebAuthn credential is bound to
`canonicalUrl`'s **hostname**, so a security key enrolled under one name cannot
be used under the other and the browser refuses the ceremony outright.

None of those is something the container can refuse at startup, which is the
usual rule for what this chart refuses — each refusal happens in somebody else's
client. So this is not a refusal: setting `ingress.host` to something else stays
allowed, because one arrangement legitimately differs — an edge terminating the
canonical name and forwarding to an internal one this Ingress matches. `helm
install` prints what that deployment is taking on.

## Metrics

`metrics.serviceMonitor.enabled` creates two ServiceMonitors, because there are
two registries. The API exports the per-tenant gauges; the MCP transport exports
its own `nacre_mcp_*` tool latency and denials. Deliberately not one: two
exporters publishing the same series would be two answers to one question.

The worker exports nothing — it serves no port. What it does is visible through
the API's gauges, and
[`docs/operations/vector-collection-backlog.md`](../../docs/operations/vector-collection-backlog.md)
says plainly that a worker stuck inside one document shows up in the log and
nowhere else.

`metrics.existingSecret` puts a bearer token on `/metrics`. Leaving it unset is
right when the port is on an internal network and wrong the moment there is a
public ingress without this path carved out.

## How this is checked

`helm lint` is **not** the gate. It exits 0 on a chart whose templates fail —
reporting `[INFO] Fail` and then "0 chart(s) failed", verified against this
chart's own defaults. CI runs:

1. `helm template` with no values, asserting it **fails**;
2. `helm template` against every file in `helm/values/`, failing if that
   directory is empty rather than passing having checked nothing;
3. `kubeconform -strict` over the rendered objects, against the real Kubernetes
   and Prometheus-operator schemas.

Two more run beside it, and both exist because a property had to hold in two
places with nothing that knew about the second:

4. `check-components.mjs` — every workload the chart creates pods for is named
   by a NetworkPolicy rule. `networkPolicy.strict` renders a default-deny that
   selects **every pod of the release**, so a workload added afterwards gets DNS
   and nothing else: it starts, it reports healthy, and it reaches nothing.
   `web` was in exactly that state, and the check is what makes the next one
   impossible rather than the fix.
5. `check-embedding-vendors.mjs` — the chart's vendor table equals the adapter's
   own, read out of the core at the release `appVersion` names.

## Two Postgres credentials, not one

`postgres` is the application's, and `postgres.migrations` is the migration
Job's. They are different **roles**, which is the whole reason they are two
values:

| | Role | Row-level security | May create tables |
|---|---|---|---|
| `postgres.*` | `nacre_app` | applies | no |
| `postgres.migrations.*` | the owner | bypassed | yes |

Row-level security does not apply to a superuser at all, and applies to a
table's owner only where the table is `FORCE`d. Connecting the application as
either turns tenant isolation into decoration.

Run this once, as a superuser, before the first install:

```sql
-- The owner: runs migrations, owns the tables. BYPASSRLS is required, not a
-- convenience — four migrations read a tenant table and every tenant table is
-- FORCEd, so without it 0006 fails and leaves the schema half-built.
CREATE ROLE nacre_owner LOGIN PASSWORD '…' BYPASSRLS;

-- The application: no BYPASSRLS, no CREATE. Every policy applies to it.
CREATE ROLE nacre_app LOGIN PASSWORD '…';

-- The worker's queue role. WITH ADMIN OPTION is required and plain membership
-- is not: migration 0008 grants nacre_worker onward to nacre_app, and only a
-- member holding ADMIN may do that.
CREATE ROLE nacre_worker NOLOGIN BYPASSRLS;
GRANT nacre_worker TO nacre_owner WITH ADMIN OPTION;

CREATE DATABASE nacre OWNER nacre_owner;
```

Then two Secrets — or one Secret with two keys, which `values/full.yaml` shows:

```bash
kubectl create secret generic nacre-postgres \
  --from-literal=url='postgres://nacre_app:…@host:5432/nacre'
kubectl create secret generic nacre-postgres-owner \
  --from-literal=url='postgres://nacre_owner:…@host:5432/nacre'
```

The chart refuses to render if `migrations.enabled` is on and
`postgres.migrations` names neither a url nor a secret. It also refuses if both
point at the same secret **and** the same key, because then it is one role
wearing two names — the same secret under two different keys is the supported
shape and not that.

Where one role genuinely does both — a laptop, a kind cluster, a managed
Postgres that hands out exactly one login — set
`postgres.migrations.reuseApplicationCredential=true`. It is an opt-in and never
a fallback: the chart will not quietly reach for the application's credential
because the other one is unset. `values/single-role.yaml` is that shape, and it
is in `helm/values/` so CI renders that branch too.

Provisioning was verified against a real PostgreSQL by running the product's own
migrator: a plain owner is refused before the schema is touched, a `BYPASSRLS`
owner applies every migration, and `nacre_app` afterwards cannot create a table,
does not bypass a policy, and holds only `INSERT, SELECT` on `audit_events` — so
the append-only journal survives the split. (A count stood here and went stale
on the next migration; the sentence is about the outcome, not about how many.)

## One origin, so the MCP discovery document is right

Core 0.5.1 adds `NACRE_MCP_CANONICAL_URL`, for deployments that publish the API
and the MCP transport on different origins — the discovery document names one
resource identifier, and RFC 9728 has the client compare it against the URL it
reached.

**This chart does not need it.** The Ingress routes `/mcp` to the MCP service on
the *same host* as the API, so there is one origin and one identifier, which is
the arrangement the shared document assumes.

It becomes relevant only if the two are put on separate hosts — a second Ingress,
a service exposed on its own, a port-forward a client is pointed at. Then set it
on the MCP Deployment to the URL clients actually use, and leave
`NACRE_JWT_ISSUER` and `NACRE_JWT_AUDIENCE` identical: this transport verifies
what the API signed.

`NACRE_MCP_ALLOWED_ORIGINS` is empty by default and refuses every browser origin
and no agent. Set it only if a browser talks to `/mcp` directly.

## Upgrading

The rules are the core's and are written down once, in
[docs/upgrading.md](https://github.com/nacre-work/nacre/blob/main/docs/upgrading.md):
forward-only migrations with no down path, the `BYPASSRLS` requirement, what is
safe to roll back, and what each version asked of an operator. Read that first.
What follows is only what is specific to this chart.

```bash
helm upgrade nacre nacre/nacre -f values.yaml --set image.tag=0.4.0
```

**The migration Job runs before any pod is replaced.** It is a Helm hook —
`pre-install,pre-upgrade` at `hook-weight: "-5"`, ahead of everything else — so
`helm upgrade` blocks on it and the workloads are only updated if it succeeded.
That is the ordering the core's documentation says nothing enforces at runtime:
here the chart enforces it, and outside Kubernetes it is the operator's to keep.

`hook-delete-policy` is `before-hook-creation`, which removes the *previous*
Job so an upgrade is not blocked by an immutable object. There is deliberately
no `hook-failed` policy: a failed Job is kept, because

```bash
kubectl logs job/nacre-migrate
```

is the entire diagnosis and deleting it throws that away. `backoffLimit` is 3.
There is no `activeDeadlineSeconds` — a migration that legitimately takes
minutes should not be killed for taking them; the only time bound is the
migrator's own ten-second `lock_timeout` per migration, which is about waiting
for a lock rather than about doing work.

The Job carries **only** `NACRE_PG_URL`, from `postgres.migrations` — the owner
credential, not the application's. `migrations.enabled=false` is for a
deployment that migrates out of band; it does not make the schema optional.

**The readiness probe now covers the schema.** Since core 0.5.0 `/v1/ready`
reports `schema: false` while the database is behind the migrations the image
ships, so a pod that starts before the migrator has run never enters rotation
instead of taking traffic and failing every request. The probe here already
points at that path, and `startupProbe` deliberately points at `/v1/health`
instead — the pod stays alive and simply does not take traffic, which is what
lets `helm upgrade` converge rather than restart-loop.

That changes what `migrations.enabled=false` means in practice. It was "I
migrate out of band"; it is now also "my pods will not go ready until I have".
That is the honest behaviour and it is the reason the flag exists, but a
deployment that sets it and forgets now sees a rollout that waits rather than an
API that answers wrongly.

**Two versions of the API answer at once during the rollout.** `api` and `mcp`
roll normally, so for the length of the upgrade a client can reach either
version. That is fine for an additive release and is the thing to think about
for one that changes a response shape. The worker does not: it is
`strategy: Recreate` on purpose, because a rolling update would briefly run two
versions claiming from one queue.

Rolling back with `helm rollback` puts the **workloads** back. It does not
migrate the schema back — nothing does; that is a restore. So a `helm rollback`
across a release whose migrations dropped a column or tightened a constraint
gets you pods that fail against the schema they find. The core's per-version
notes say which releases those are.

## Architectures, and one node that is a laptop

**Both images carry `linux/amd64` and `linux/arm64` from core 0.5.2.** Every tag
up to and including 0.5.1 carried one — read off the registry, not inferred —
so an arm64 node ran them emulated: Docker pulls the amd64 manifest and starts
it, which is a slow pod rather than an error. Nothing in this chart caused it
and nothing here can fix it for an old tag; a multi-architecture image is a
property of the tag, so the action is `image.tag` forward.

There is no `nodeSelector` for architecture in any values file here, and that is
deliberate rather than an omission: a multi-architecture tag resolves per node,
so a mixed cluster schedules the right image wherever the pod lands. Set
`nodeSelector: {kubernetes.io/arch: arm64}` when something *else* about the node
matters — an amd64-only sidecar in the same pod, or a node pool whose hardware
you are choosing between — never to select the image.

If you pin digests, pin the **index** digest. A multi-architecture tag resolves
to an image index rather than to an image, and the node picks its own manifest
out of it; pinning one child digest pins one architecture.

`helm/values/apple-silicon.yaml` is the laptop shape — Docker Desktop's
Kubernetes, k3d, kind or minikube on an M-series Mac. Single replicas, no
autoscaling, no PodDisruptionBudget, no ingress, and small enough requests to
schedule beside a browser. The one line worth reading before you install it is
`embedding.endpoint`: Text Embeddings Inference publishes no arm64 image at all,
so the embedder is a native process on macOS rather than a pod, and how a pod
reaches the host differs by cluster — `host.docker.internal` on Docker Desktop,
`host.k3d.internal` on k3d, the host's LAN address on kind and minikube. The
core's
[docs/apple-silicon.md](https://github.com/nacre-work/nacre/blob/main/docs/apple-silicon.md)
has the rest, including the Compose arrangement it mirrors.

## The OAuth consent screen, and the one thing this chart does not deploy

Core 0.5.3 added an authorization server, so an MCP client discovers this
installation, registers itself and completes the authorization code flow instead
of being handed a service account key by hand. The token it receives acts as a
**service account** and never as the person who approved it — an agent is a
principal with its own grants, and that separation is the product.

The screen where a person picks the agent is `packages/admin`, and **this chart
deploys it** from core 0.5.5 — `web.enabled`, on by default. The ingress routes
`/` at that pod, which serves the bundle and proxies `/v1`, `/.well-known` and
`/oauth/` to the API and `/mcp` to the MCP transport; that is what makes the
browser's requests same-origin, and the API sends no CORS headers deliberately,
so same-origin is not a convenience.

The last two arrived in core 0.5.6, and this chart went three releases without
them because `appVersion` stayed at 0.5.5 while the templates moved on. The
console image was the one that noticed: the chart passed it `NACRE_MCP_UPSTREAM`,
0.5.5 does not list that variable in its `NGINX_ENVSUBST_FILTER` and has no
`/mcp` block, so the variable was set and dropped. Through this chart's ingress
an MCP client reached nginx's 404 rather than the transport, and
`/oauth/authorize` — the first hop of the flow this very section describes —
404'd with it. That is why the chart lives in the same repository as the image
now, versioned with it, and `scripts/check-chart-version.mjs` holds the two equal.

**This section previously said the chart deliberately did not deploy it**, on
the grounds that a deployment might reasonably front the console itself. That is
true of the API too, which this chart has always deployed. The real reason was
that nothing published the image: the `web` stage existed in the Dockerfile,
Compose built it locally, and the release workflow built that file with no
target — so `ghcr.io/nacre-work/nacre-web` did not exist and there was nothing
to deploy. An omission wearing a rationale, corrected here rather than left
standing.

`web.enabled=false` is still supported and routes `/` at the API exactly as
before, for a deployment that serves the bundle itself. Set `oauth.consentUrl`
in that case: the consent flow sends a browser to a screen in the bundle, so
with neither the chart's console nor a URL naming yours, connecting an
application ends in a redirect to nothing.
