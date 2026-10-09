{{/*
Names, labels, and the environment every workload shares.

The env block is a helper rather than a ConfigMap reference in three templates,
because api, mcp and worker read the *same* configuration and a variable that
reaches two of them is the failure this product keeps finding: `NACRE_RATE_*`
applied to REST only, so a client out of search budget pointed at the MCP port
and carried on.
*/}}

{{- define "nacre.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nacre.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "nacre.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "nacre.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "nacre.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: nacre
{{- end -}}

{{- define "nacre.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "nacre.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "nacre.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{/*
Refuse to render on a configuration that would start and be wrong.

Every one of these is a value the product itself refuses at startup. Catching
them here turns a CrashLoopBackOff an operator has to read logs to understand
into a `helm install` error that names the value.
*/}}
{{- define "nacre.validate" -}}
{{- if not .Values.canonicalUrl -}}
{{- fail "canonicalUrl is required. It is the OAuth issuer and the well-known base, and it goes into every token ever issued — moving it later breaks every client at once." -}}
{{- end -}}

{{- if not (or .Values.postgres.url .Values.postgres.existingSecret) -}}
{{- fail "postgres.url or postgres.existingSecret is required. There is no default: one that quietly points at localhost is how a deployment talks to nothing and reports success." -}}
{{- end -}}
{{- if .Values.migrations.enabled -}}
{{- $m := .Values.postgres.migrations -}}
{{- $own := or $m.url $m.existingSecret -}}
{{- if and $own $m.reuseApplicationCredential -}}
{{- fail "postgres.migrations.reuseApplicationCredential is true and postgres.migrations.url/existingSecret is also set. Two answers to \"which role runs the migrations\", and resolving it by precedence leaves the other one configured, apparently in use, and ignored." -}}
{{- end -}}
{{- if not (or $own $m.reuseApplicationCredential) -}}
{{- fail "migrations.enabled needs postgres.migrations.url or postgres.migrations.existingSecret. The Job runs as the role that *owns* the tables and the application connects as one that must not be able to create them — row-level security applies to the owner only where forced. Set postgres.migrations.reuseApplicationCredential=true if one role genuinely does both, or migrations.enabled=false to run them out of band." -}}
{{- end -}}
{{/*
Pointing both at the same secret AND the same key is reuse without saying so —
the shape this chart refuses everywhere else. The same secret under two keys is
fine and common: one Secret holding both URLs.
*/}}
{{- if and (and $m.existingSecret (eq $m.existingSecret .Values.postgres.existingSecret)) (eq $m.existingSecretKey .Values.postgres.existingSecretKey) -}}
{{- fail "postgres.migrations.existingSecret and postgres.existingSecret name the same secret and the same key, so both roles are one role. Set postgres.migrations.reuseApplicationCredential=true if that is deliberate; a Secret holding two different keys is the other way." -}}
{{- end -}}
{{- end -}}
{{- if not .Values.qdrant.url -}}
{{- fail "qdrant.url is required." -}}
{{- end -}}
{{- if not (or .Values.redis.url .Values.redis.existingSecret) -}}
{{- fail "redis.url is required. Rate limiting, Idempotency-Key and the effective-principals cache are what it is for." -}}
{{- end -}}
{{- if not .Values.embedding.endpoint -}}
{{- fail "embedding.endpoint is required. Without it the worker accepts documents and fails every one of them against a host that does not resolve." -}}
{{- end -}}

{{/*
The mail relay is a group, and this chart refuses at render time what the
container refuses at startup — a URL with no sender parses and then fails on the
first message, which is a log line on a pod nobody is reading rather than a
refusal anybody notices.

The second factor is not a group: one key is the whole of it. What is checked is
that the key inside the Secret is named, because `secretKeyRef` with an empty
key is a pod that never starts and an event that says `CreateContainerConfigError`
without saying which value was missing.
*/}}
{{- if and .Values.mail.existingSecret (not .Values.mail.from) -}}
{{- fail "mail.existingSecret is set and mail.from is empty. They are one group: the container refuses a relay with no sender at startup, and a relay refuses a sender it does not own, so this is a message that is never delivered rather than a deployment that is nearly right." -}}
{{- end -}}
{{- if and .Values.mail.from (not .Values.mail.existingSecret) -}}
{{- fail "mail.from is set and mail.existingSecret is empty. Password recovery needs the relay URL as well, and it is a Secret because that URL carries the relay password — there is deliberately no inline alternative." -}}
{{- end -}}
{{- if and .Values.mail.existingSecret (not .Values.mail.urlSecretKey) -}}
{{- fail "mail.urlSecretKey is empty. It names the key inside mail.existingSecret that holds the smtp:// URL." -}}
{{- end -}}
{{- if and .Values.secondFactor.existingSecret (not .Values.secondFactor.secretKey) -}}
{{- fail "secondFactor.secretKey is empty. It names the key inside secondFactor.existingSecret that holds the 32 bytes a TOTP secret is sealed with." -}}
{{- end -}}

{{- if and .Values.jwt.existingSecret .Values.jwt.privateKeyExistingSecret -}}
{{- fail "jwt.existingSecret and jwt.privateKeyExistingSecret are both set. They are two answers to \"what signs a token\" and there is no precedence worth inventing — the product refuses this at startup, and so does this chart." -}}
{{- end -}}
{{- if not (or .Values.jwt.existingSecret .Values.jwt.privateKeyExistingSecret) -}}
{{- fail "one of jwt.existingSecret or jwt.privateKeyExistingSecret is required. A signing key with a default is one anybody reading the chart can forge tokens with." -}}
{{- end -}}
{{- if and .Values.jwt.existingSecret .Values.jwt.publicKeyExistingSecret -}}
{{- fail "jwt.existingSecret and jwt.publicKeyExistingSecret are both set. A shared secret has no separate public half — the same key verifies and signs — so a public key alongside it is a verify-only key nothing would use. Set publicKeyExistingSecret only in the Ed25519 mode (jwt.privateKeyExistingSecret)." -}}
{{- end -}}

{{- if and .Values.reranker.enabled (not .Values.reranker.endpoint) -}}
{{- fail "reranker.enabled is true with no reranker.endpoint." -}}
{{- end -}}

{{/*
Commercial modules need an image that contains them, and this chart's default
image does not.

`NACRE_MODULES` names packages the process imports by name at startup, and the
core's own contract is that a module which cannot be imported is a startup
failure — deliberately, because starting without one is silently a different
product. The open image carries only the open packages, so naming a module on
it is a guaranteed CrashLoopBackOff, arriving as a stack trace rather than as
anything about licensing.

This chart cannot look inside an image and does not try. It checks the one
combination that is certainly wrong: modules named while the repository is
still the open default, which is the shape of somebody who does not yet know an
enterprise image exists. An operator who has changed the repository has made
the decision, and this says nothing.

The literal below is the same string as `image.repository` in values.yaml, and
`check-open-image.mjs` holds the two together — a default that moved here and
not there would leave a refusal that never fires, which is worse than none.
*/}}
{{- if and .Values.modules (eq .Values.image.repository "ghcr.io/nacre-work/nacre") -}}
{{- fail "modules is set and image.repository is still the open default. NACRE_MODULES names packages the process imports at startup, and the open image contains only the open packages — this would CrashLoopBackOff on an import error that says nothing about modules. Commercial modules ship as their own image; point image.repository at it and set image.pullSecrets. Clear modules to run the open product." -}}
{{- end -}}

{{- if and (not .Values.parser.enabled) (not .Values.parser.externalEndpoint) -}}
{{- fail "parser.enabled is false and parser.externalEndpoint is empty. The parser is required — Parser.parse turns bytes into text on the ingest path — so a deployment that does not run the bundled one must name an external endpoint. NACRE_PARSER_ENDPOINT has no default: unset, ingest accepts documents and fails every one of them." -}}
{{- end -}}

{{/*
The embedding adapter's routing, checked here because the container checks it at
startup and a container that refuses to start is a CrashLoopBackOff rather than
an error naming a value.

Everything below is `load_routes` and `load_reranker` in the adapter, said twice
— the vendor names, the per-vendor settings, the refusal of a model routed
twice, and the refusal of half a reranker. Two copies of one table with nothing
that knows they are two is this project's most repeated defect, so it is not
left to care: `scripts/check-chart-vendors.mjs` reads the adapter's own
VENDORS and RERANKERS tables out of `services/embedding_adapter/app.py`, in the
same tree, and fails if this disagrees with either.

**Embedding and reranking are independent jobs in one container**, so
`routes` alone, a reranker alone, or both is each a working adapter — and
neither is `enabled: true` with nothing at all, which would be a Deployment
whose container refuses to start.
*/}}
{{- if .Values.embeddingAdapter.enabled -}}
{{- $ea := .Values.embeddingAdapter -}}
{{- $vendors := dict
      "openai-compatible" (dict "values" "openaiCompatible" "settings" (list "endpoint"))
      "cloudflare"        (dict "values" "cloudflare"       "settings" (list "account"))
      "google"            (dict "values" "google"           "settings" (list))
      "voyage"            (dict "values" "voyage"           "settings" (list)) -}}
{{- $rerankers := dict
      "cloudflare" (dict "values" "cloudflare" "settings" (list "account"))
      "cohere"     (dict "values" "cohere"     "settings" (list))
      "jina"       (dict "values" "jina"       "settings" (list))
      "voyage"     (dict "values" "voyage"     "settings" (list)) -}}
{{- $rr := $ea.rerank -}}
{{- if and (not $ea.routes) (not $rr.vendor) (not $rr.model) -}}
{{- fail "embeddingAdapter.enabled is true with neither embeddingAdapter.routes nor embeddingAdapter.rerank set, and the container refuses to start on that. There is deliberately no default for either — which vendor sees your documents is not a decision this chart makes. Set routes to a comma-separated list of `model=vendor` (`text-embedding-3-small=openai-compatible`; vendors: cloudflare, google, openai-compatible, voyage), or set rerank.vendor and rerank.model (vendors: cloudflare, cohere, jina, voyage), or both." -}}
{{- end -}}
{{- $seen := dict -}}
{{- range $entry := splitList "," $ea.routes -}}
{{- $e := trim $entry -}}
{{- if $e -}}
{{/*
Split on the *first* `=` and the *first* `:`, which is `partition` in the
adapter. Counting the separators instead would refuse an upstream model name
that carries one — a chart stricter than the container is the same disagreement
as a chart that is laxer, just harder to notice.
*/}}
{{- $halves := splitList "=" $e -}}
{{- if lt (len $halves) 2 -}}
{{- fail (printf "embeddingAdapter.routes entry `%s` is not `model=vendor`." $e) -}}
{{- end -}}
{{- $model := trim (first $halves) -}}
{{- $rest := trim (join "=" (rest $halves)) -}}
{{- $vendor := $rest -}}
{{- $upstream := "" -}}
{{- if contains ":" $rest -}}
{{- $colon := splitList ":" $rest -}}
{{- $vendor = trim (first $colon) -}}
{{- $upstream = trim (join ":" (rest $colon)) -}}
{{- if not $upstream -}}
{{- fail (printf "embeddingAdapter.routes entry `%s` ends in a colon with no upstream model. Write `model=vendor` or `model=vendor:upstream-model`." $e) -}}
{{- end -}}
{{- end -}}
{{- if or (not $model) (not $vendor) -}}
{{- fail (printf "embeddingAdapter.routes entry `%s` is not `model=vendor`." $e) -}}
{{- end -}}
{{- $spec := index $vendors $vendor -}}
{{- if not $spec -}}
{{- fail (printf "embeddingAdapter.routes names the vendor `%s`, which does not exist. Vendors: cloudflare, google, openai-compatible, voyage." $vendor) -}}
{{- end -}}
{{- if hasKey $seen $model -}}
{{- fail (printf "embeddingAdapter.routes routes the model `%s` twice. One model, one vendor — the second entry would be silently unreachable." $model) -}}
{{- end -}}
{{- $_ := set $seen $model true -}}
{{- $cfg := index $ea.vendors (index $spec "values") -}}
{{- if not $cfg.existingSecret -}}
{{- fail (printf "a route names the %s vendor and embeddingAdapter.vendors.%s.existingSecret is empty. The credential is a reference to a Secret and never an inline value: `--set` puts one in a shell history and `helm get values` prints it back." $vendor (index $spec "values")) -}}
{{- end -}}
{{- range $setting := index $spec "settings" -}}
{{- if not (index $cfg $setting) -}}
{{- fail (printf "a route names the %s vendor and embeddingAdapter.vendors.%s.%s is empty." $vendor (index $spec "values") $setting) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and $ea.routes (not $seen) -}}
{{- fail "embeddingAdapter.routes is set and contains no route." -}}
{{- end -}}
{{/*
Half a reranker is refused rather than half-honoured, which is the adapter's
own rule: a vendor with no model would be a guess about which cross-encoder,
and a model with no vendor has nowhere to go.
*/}}
{{- if or $rr.vendor $rr.model -}}
{{- if not $rr.vendor -}}
{{- fail "embeddingAdapter.rerank.model is set and embeddingAdapter.rerank.vendor is not. Reranking needs both — a model with no vendor has nowhere to go. Vendors: cloudflare, cohere, jina, voyage." -}}
{{- end -}}
{{- if not $rr.model -}}
{{- fail "embeddingAdapter.rerank.vendor is set and embeddingAdapter.rerank.model is not. Reranking needs both — a vendor with no model would be a guess about which cross-encoder." -}}
{{- end -}}
{{- $spec := index $rerankers $rr.vendor -}}
{{- if not $spec -}}
{{- fail (printf "embeddingAdapter.rerank.vendor names `%s`, which does not exist. Vendors: cloudflare, cohere, jina, voyage. OpenAI, Anthropic and Google publish no reranking API, so none of them can be one." $rr.vendor) -}}
{{- end -}}
{{- $cfg := index $rr.vendors (index $spec "values") -}}
{{- if not $cfg.existingSecret -}}
{{- fail (printf "embeddingAdapter.rerank.vendor is %s and embeddingAdapter.rerank.vendors.%s.existingSecret is empty. The credential is a reference to a Secret and never an inline value, and it is separate from the embedding one even where the vendor is the same: the two jobs are independent, and an adapter that only reranks must not have to set an embedding variable." $rr.vendor (index $spec "values")) -}}
{{- end -}}
{{- range $setting := index $spec "settings" -}}
{{- if not (index $cfg $setting) -}}
{{- fail (printf "embeddingAdapter.rerank.vendor is %s and embeddingAdapter.rerank.vendors.%s.%s is empty." $rr.vendor (index $spec "values") $setting) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- if .Values.s3.enabled -}}
{{- if not (and .Values.s3.endpoint .Values.s3.bucket .Values.s3.existingSecret) -}}
{{- fail "s3.enabled needs endpoint, bucket and existingSecret together. An endpoint with no credential parses and fails later." -}}
{{- end -}}
{{- end -}}

{{- if and .Values.ingress.enabled (not (include "nacre.ingressHost" .)) -}}
{{- fail "ingress.enabled is true and no host could be determined. Set ingress.host, or write a canonicalUrl this can take a hostname out of." -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.ingress.className) -}}
{{- fail "ingress.enabled is true with no ingress.className. A wrong or absent class produces an Ingress nothing reconciles, and no error anywhere." -}}
{{- end -}}
{{- end -}}

{{/*
The hostname the ingress serves, derived from `canonicalUrl` unless a
deployment has said otherwise.

It used to be a second, required value, and the two were then two answers to
"what is this installation's address" with nothing that knew there were two.
Setting them to different names is a deployment that renders, installs and comes
up, and then:

  - `/.well-known/oauth-protected-resource` names a resource on a host this
    ingress does not serve, so an MCP client's discovery walk stops one step
    after it starts;
  - the console proxies `/v1` same-origin and the API sends no CORS headers, so
    a browser reaching it under the other name is refused with nothing in a log;
  - and since core 0.19.0 a WebAuthn credential is bound to `canonicalUrl`'s
    **hostname**, so a security key enrolled under one name cannot be used under
    the other and the browser refuses the ceremony outright.

None of those is something the container can refuse at startup, which is the
usual rule here — the refusals happen in somebody else's client. So the answer
is to stop asking twice: an unset `ingress.host` is the canonical URL's host,
which is what every values file in `deploy/helm/values` already wrote by hand.

Deliberately still overridable, because one arrangement legitimately differs: an
edge — a CDN, an external load balancer — terminating `nacre.example.com` and
forwarding to an internal name this Ingress matches. That is a deployment that
has said otherwise, and `NOTES.txt` prints what it is taking on.

The host and never the origin: an Ingress rule's host is a DNS name, so a scheme
or a port in it matches nothing. Written with the string functions rather than a
URL parser because Helm has none.
*/}}
{{- define "nacre.canonicalHost" -}}
{{- if .Values.canonicalUrl -}}
{{- $authority := index (splitList "/" (regexReplaceAll "^[A-Za-z][A-Za-z0-9+.-]*://" .Values.canonicalUrl "")) 0 -}}
{{- index (splitList ":" $authority) 0 -}}
{{- end -}}
{{- end -}}

{{- define "nacre.ingressHost" -}}
{{- if .Values.ingress.host -}}
{{- .Values.ingress.host -}}
{{- else -}}
{{- include "nacre.canonicalHost" . -}}
{{- end -}}
{{- end -}}

{{/*
The migration Job's database URL, which is the owning role's and not the
application's.

Its own definition rather than a branch inside `nacre.env`, because the whole
point is that these two are different credentials — resolving both from one
place is how they end up being one again.

`reuseApplicationCredential` is the only path that reaches the application's
value, and it is reached only because someone wrote it down.
*/}}
{{- define "nacre.migrationsPgEnv" -}}
{{- $m := .Values.postgres.migrations -}}
{{- if $m.reuseApplicationCredential -}}
- name: NACRE_PG_URL
{{- if .Values.postgres.existingSecret }}
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgres.existingSecret }}
      key: {{ .Values.postgres.existingSecretKey }}
{{- else }}
  value: {{ .Values.postgres.url | quote }}
{{- end }}
{{- else -}}
- name: NACRE_PG_URL
{{- if $m.existingSecret }}
  valueFrom:
    secretKeyRef:
      name: {{ $m.existingSecret }}
      key: {{ $m.existingSecretKey }}
{{- else }}
  value: {{ $m.url | quote }}
{{- end }}
{{- end -}}
{{- end -}}

{{/*
The environment, identical for api, mcp and worker.

One definition, so a variable cannot reach one surface and not another.
*/}}
{{- define "nacre.env" -}}
- name: NACRE_ENV
  value: {{ .Values.env | quote }}
- name: NACRE_CANONICAL_URL
  value: {{ .Values.canonicalUrl | quote }}
{{- if .Values.oauth.consentUrl }}
- name: NACRE_OAUTH_CONSENT_URL
  value: {{ .Values.oauth.consentUrl | quote }}
{{- end }}
- name: NACRE_LOG_LEVEL
  value: {{ .Values.logging.level | quote }}
- name: NACRE_LOG_FORMAT
  value: {{ .Values.logging.format | quote }}

- name: NACRE_PG_URL
{{- if .Values.postgres.existingSecret }}
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgres.existingSecret }}
      key: {{ .Values.postgres.existingSecretKey }}
{{- else }}
  value: {{ .Values.postgres.url | quote }}
{{- end }}
- name: NACRE_PG_POOL_MAX
  value: {{ .Values.postgres.poolMax | quote }}

- name: NACRE_QDRANT_URL
  value: {{ .Values.qdrant.url | quote }}
{{- if .Values.qdrant.apiKeyExistingSecret }}
- name: NACRE_QDRANT_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.qdrant.apiKeyExistingSecret }}
      key: {{ .Values.qdrant.apiKeyExistingSecretKey }}
{{- else if .Values.qdrant.apiKey }}
- name: NACRE_QDRANT_API_KEY
  value: {{ .Values.qdrant.apiKey | quote }}
{{- end }}
- name: NACRE_QDRANT_SHARDS
  value: {{ .Values.qdrant.shards | default 1 | quote }}
- name: NACRE_QDRANT_REPLICATION_FACTOR
  value: {{ .Values.qdrant.replicationFactor | default 1 | quote }}

- name: NACRE_REDIS_URL
{{- if .Values.redis.existingSecret }}
  valueFrom:
    secretKeyRef:
      name: {{ .Values.redis.existingSecret }}
      key: {{ .Values.redis.existingSecretKey }}
{{- else }}
  value: {{ .Values.redis.url | quote }}
{{- end }}

- name: NACRE_DEFAULT_EMBEDDING_ENDPOINT
  value: {{ .Values.embedding.endpoint | quote }}
- name: NACRE_DEFAULT_EMBEDDING_MODEL
  value: {{ .Values.embedding.model | quote }}
- name: NACRE_DEFAULT_EMBEDDING_DIM
  value: {{ .Values.embedding.dimensions | quote }}
- name: NACRE_RERANKER_ENABLED
  value: {{ .Values.reranker.enabled | quote }}
{{- if .Values.reranker.enabled }}
- name: NACRE_RERANKER_ENDPOINT
  value: {{ .Values.reranker.endpoint | quote }}
- name: NACRE_RERANK_CANDIDATES
  value: {{ .Values.reranker.candidates | quote }}
{{- end }}
{{/*
NACRE_PARSER_ENDPOINT is required by loadConfig, so it is set whether the bundled
parser is deployed or not. With it deployed, it points at the in-cluster
Service; without it, at parser.externalEndpoint. Turning the parser off and
naming no external one is refused in nacre.validate, because loadConfig would
then fail at startup with a CrashLoopBackOff instead of a helm error.
*/}}
{{- if .Values.parser.enabled }}
- name: NACRE_PARSER_ENDPOINT
  value: {{ printf "http://%s-parser:8090" (include "nacre.fullname" .) | quote }}
{{- else }}
- name: NACRE_PARSER_ENDPOINT
  value: {{ .Values.parser.externalEndpoint | quote }}
{{- end }}

{{- if .Values.s3.enabled }}
- name: NACRE_S3_ENDPOINT
  value: {{ .Values.s3.endpoint | quote }}
- name: NACRE_S3_BUCKET
  value: {{ .Values.s3.bucket | quote }}
- name: NACRE_S3_REGION
  value: {{ .Values.s3.region | quote }}
- name: NACRE_S3_FORCE_PATH_STYLE
  value: {{ .Values.s3.forcePathStyle | quote }}
- name: NACRE_PRESIGN_TTL
  value: {{ .Values.s3.presignTtl | quote }}
- name: NACRE_S3_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.s3.existingSecret }}
      key: {{ .Values.s3.accessKeySecretKey }}
- name: NACRE_S3_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.s3.existingSecret }}
      key: {{ .Values.s3.secretKeySecretKey }}
{{- end }}

{{/*
The JWT *key* material is not here — it is per role. The API signs and gets the
private key (or the shared secret); the MCP transport only verifies and gets the
public key (nacre.jwtSigningEnv / nacre.jwtVerifyEnv below); the worker uses no
JWT at all and gets neither. What every process does need is the issuer,
audience and lifetimes, because all three call loadConfig, which requires them.
*/}}
- name: NACRE_JWT_ISSUER
  value: {{ default .Values.canonicalUrl .Values.jwt.issuer | quote }}
- name: NACRE_JWT_AUDIENCE
  value: {{ .Values.jwt.audience | quote }}
- name: NACRE_ACCESS_TOKEN_TTL
  value: {{ .Values.jwt.accessTokenTtl | quote }}
- name: NACRE_REFRESH_TOKEN_TTL
  value: {{ .Values.jwt.refreshTokenTtl | quote }}

- name: NACRE_ACL_CACHE_TTL
  value: {{ .Values.acl.cacheTtl | quote }}
- name: NACRE_GC_GRACE
  value: {{ .Values.retention.gcGrace | quote }}
- name: NACRE_INDEX_LEASE
  value: {{ .Values.retention.indexLease | quote }}
- name: NACRE_INDEX_MAX_ATTEMPTS
  value: {{ .Values.retention.indexMaxAttempts | quote }}
- name: NACRE_AUDIT_RETENTION_DAYS
  value: {{ .Values.retention.auditDays | quote }}
- name: NACRE_COLLECTION_RETENTION_DAYS
  value: {{ .Values.retention.collectionDays | quote }}
- name: NACRE_AUDIT_QUERY_TEXT
  value: {{ .Values.audit.queryText | quote }}

- name: NACRE_RATE_SEARCH_PER_MIN
  value: {{ .Values.limits.searchPerMin | quote }}
- name: NACRE_RATE_INGEST_PER_HOUR
  value: {{ .Values.limits.ingestPerHour | quote }}
- name: NACRE_RATE_LOGIN_PER_15MIN
  value: {{ .Values.limits.loginPer15Min | quote }}
- name: NACRE_RATE_LOGIN_SOURCE_PER_15MIN
  value: {{ .Values.limits.loginSourcePer15Min | quote }}
- name: NACRE_TRUST_PROXY
  value: {{ .Values.limits.trustProxy | quote }}
- name: NACRE_MAX_DOCUMENT_BYTES
  value: {{ .Values.limits.maxDocumentBytes | quote }}
{{- if .Values.metrics.existingSecret }}
- name: NACRE_METRICS_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.metrics.existingSecret }}
      key: {{ .Values.metrics.secretKey }}
{{- end }}

{{- if .Values.modules }}
- name: NACRE_MODULES
  value: {{ .Values.modules | quote }}
{{- end }}

{{/*
The escape hatch, last so it can override nothing above it by accident — a
duplicate env name is a render error in Kubernetes, which is the safe failure.

Not every NACRE_ variable earns a named value: NACRE_REINDEX_MIN_RECALL, the
recall gate's threshold; NACRE_OAUTH_AUTHORIZATION_SERVER, the IdP in front of
an installation; NACRE_PARSER_ALLOW_PRIVATE_URLS; and every variable a
commercial module in NACRE_MODULES reads (NACRE_SSO_*, NACRE_EMA_*,
NACRE_AUDIT_SIEM_*, NACRE_TENANCY_REFRESH) are all read by the product and
modelled by nothing here. Without this an operator could name the modules and
then have no way to configure them. `extraEnv` is a raw list of env entries, so
`valueFrom` a Secret works for the ones that carry credentials.
*/}}
{{- with .Values.extraEnv }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- end -}}

{{/*
The second factor's sealing key, and the mail relay. Both are the **API's
alone**: the MCP transport verifies tokens and issues none, and the worker signs
nothing, so a key on either would be a secret sitting in a pod that never reads
it. Both are optional, and unset is a supported deployment rather than a
degraded one — the mail surfaces answer 404 and sign-in is what it was.

**Since core 0.19.0 that sentence stops short of the second factor.** TOTP needs
this key, because its secret is shared and therefore has to be kept and sealed;
WebAuthn stores a public key and a counter and needs nothing sealing them, so an
installation with no key here still offers the *stronger* of the two and the
enrolment surface does not 404. What unset now means is "TOTP is absent", not
"there is no second factor".

`secretKeyRef` in both cases and no inline alternative, which is stricter than
`qdrant.apiKey` beside it and matches the vendor-credential rule: `helm get
values` prints an inline value back, and these two open every enrolled TOTP
authenticator and the relay account respectively. A WebAuthn credential is not
among them — there is no secret of its holder's here to hand over.
*/}}
{{- define "nacre.secondFactorEnv" -}}
{{- if .Values.secondFactor.existingSecret }}
- name: NACRE_2FA_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secondFactor.existingSecret }}
      key: {{ .Values.secondFactor.secretKey }}
{{- end }}
{{- end -}}

{{- define "nacre.mailEnv" -}}
{{- if .Values.mail.existingSecret }}
- name: NACRE_SMTP_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.mail.existingSecret }}
      key: {{ .Values.mail.urlSecretKey }}
- name: NACRE_MAIL_FROM
  value: {{ .Values.mail.from | quote }}
{{- end }}
{{- end -}}

{{/*
The JWT key material, per role.

The API signs, so it gets the private key (or, in symmetric mode, the shared
secret). The MCP transport only verifies, so it gets the *public* key where one
is configured — the signing key never reaches it, which is the whole point of
the asymmetric mode. The worker uses no JWT and calls neither helper. The key is
a mounted file rather than an env var because NACRE_JWT_*_KEY_REF take file://
and nothing else — which also keeps the key out of `kubectl describe pod`.
*/}}
{{- define "nacre.jwtSigningEnv" -}}
{{- if .Values.jwt.existingSecret }}
- name: NACRE_JWT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.jwt.existingSecret }}
      key: {{ .Values.jwt.secretKey }}
{{- if .Values.jwt.previousSecretKey }}
- name: NACRE_JWT_SECRET_PREVIOUS
  valueFrom:
    secretKeyRef:
      name: {{ .Values.jwt.existingSecret }}
      key: {{ .Values.jwt.previousSecretKey }}
{{- end }}
{{- else }}
- name: NACRE_JWT_PRIVATE_KEY_REF
  value: {{ printf "file:///run/secrets/nacre-jwt/%s" .Values.jwt.privateKeyFile | quote }}
{{- if .Values.jwt.previousKeyFile }}
- name: NACRE_JWT_PREVIOUS_KEY_REF
  value: {{ printf "file:///run/secrets/nacre-jwt/%s" .Values.jwt.previousKeyFile | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
The verifier's key. A shared secret has no separate half, so symmetric mode
gives it the same NACRE_JWT_SECRET the signer has. In Ed25519 mode it gets the
public key when one is configured — and falls back to the private key if not, so
an existing single-secret Ed25519 deployment still verifies, it just does not
get the separation until it supplies the public half.
*/}}
{{- define "nacre.jwtVerifyEnv" -}}
{{- if .Values.jwt.existingSecret }}
- name: NACRE_JWT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.jwt.existingSecret }}
      key: {{ .Values.jwt.secretKey }}
{{- if .Values.jwt.previousSecretKey }}
- name: NACRE_JWT_SECRET_PREVIOUS
  valueFrom:
    secretKeyRef:
      name: {{ .Values.jwt.existingSecret }}
      key: {{ .Values.jwt.previousSecretKey }}
{{- end }}
{{- else if .Values.jwt.publicKeyExistingSecret }}
- name: NACRE_JWT_PUBLIC_KEY_REF
  value: {{ printf "file:///run/secrets/nacre-jwt/%s" .Values.jwt.publicKeyFile | quote }}
{{- if .Values.jwt.previousPublicKeyFile }}
- name: NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF
  value: {{ printf "file:///run/secrets/nacre-jwt/%s" .Values.jwt.previousPublicKeyFile | quote }}
{{- end }}
{{- else }}
- name: NACRE_JWT_PRIVATE_KEY_REF
  value: {{ printf "file:///run/secrets/nacre-jwt/%s" .Values.jwt.privateKeyFile | quote }}
{{- if .Values.jwt.previousKeyFile }}
- name: NACRE_JWT_PREVIOUS_KEY_REF
  value: {{ printf "file:///run/secrets/nacre-jwt/%s" .Values.jwt.previousKeyFile | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/* The API's key volume: the private key (Ed25519 mode). */}}
{{- define "nacre.jwtSigningVolume" -}}
{{- if .Values.jwt.privateKeyExistingSecret }}
- name: jwt
  secret:
    secretName: {{ .Values.jwt.privateKeyExistingSecret }}
    defaultMode: 0400
{{- end }}
{{- end -}}

{{/* The MCP verifier's key volume: the public key if set, else the private one. */}}
{{- define "nacre.jwtVerifyVolume" -}}
{{- if .Values.jwt.publicKeyExistingSecret }}
- name: jwt
  secret:
    secretName: {{ .Values.jwt.publicKeyExistingSecret }}
    defaultMode: 0444
{{- else if .Values.jwt.privateKeyExistingSecret }}
- name: jwt
  secret:
    secretName: {{ .Values.jwt.privateKeyExistingSecret }}
    defaultMode: 0400
{{- end }}
{{- end -}}

{{- define "nacre.jwtSigningVolumeMount" -}}
{{- if .Values.jwt.privateKeyExistingSecret }}
- name: jwt
  mountPath: /run/secrets/nacre-jwt
  readOnly: true
{{- end }}
{{- end -}}

{{- define "nacre.jwtVerifyVolumeMount" -}}
{{- if or .Values.jwt.publicKeyExistingSecret .Values.jwt.privateKeyExistingSecret }}
- name: jwt
  mountPath: /run/secrets/nacre-jwt
  readOnly: true
{{- end }}
{{- end -}}

{{/*
`readOnlyRootFilesystem: true` means Node has nowhere to write. It wants one
place, and an emptyDir is the whole of it.
*/}}
{{- define "nacre.tmpVolume" -}}
- name: tmp
  emptyDir: {}
{{- end -}}

{{- define "nacre.tmpVolumeMount" -}}
- name: tmp
  mountPath: /tmp
{{- end -}}

{{/*
The embedding adapter's environment.

**Only the vendors a route actually names are configured.** A credential no
route can reach is a third party's billing key sitting in a container's
environment for nothing, and this service is the one that holds several — so the
set it is given is the set its routes make reachable, and adding a vendor to
`values.yaml` without routing a model to it changes nothing about what the pod
holds.

It gets no database URL, no Qdrant URL and no JWT material, the same way the
parser gets no database credential: it embeds a batch of text and has no
business with any of them.
*/}}
{{- define "nacre.embeddingAdapterEnv" -}}
{{- $ea := .Values.embeddingAdapter -}}
{{- $routed := dict -}}
{{- range $entry := splitList "," $ea.routes -}}
{{- $halves := splitList "=" (trim $entry) -}}
{{- if ge (len $halves) 2 -}}
{{/*
The vendor is what is left of the first colon, because a route may name the
vendor's own spelling of the model — `bge-m3=cloudflare:@cf/baai/bge-m3`. Taking
the whole right-hand side, which this did, means the key `cloudflare:@cf/…`
matches no vendor and the credential for a routed vendor is never set: the
container starts, and the first document gets a 401 from somebody else's API.
*/}}
{{- $vendor := trim (first (splitList ":" (trim (join "=" (rest $halves))))) -}}
{{- if $vendor -}}
{{- $_ := set $routed $vendor true -}}
{{- end -}}
{{- end -}}
{{- end -}}
- name: PORT
  value: "8091"
{{- /*
Verbatim, including whitespace the operator wrote: the adapter parses this
string and its refusals quote it back, so a chart that tidied it would be
answering about a value nobody set. It trims each entry itself.
*/}}
- name: NACRE_EMBED_ROUTES
  value: {{ $ea.routes | quote }}
{{- if hasKey $routed "openai-compatible" }}
- name: NACRE_EMBED_OPENAI_COMPATIBLE_ENDPOINT
  value: {{ $ea.vendors.openaiCompatible.endpoint | quote }}
- name: NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $ea.vendors.openaiCompatible.existingSecret }}
      key: {{ $ea.vendors.openaiCompatible.secretKey }}
{{- end }}
{{- if hasKey $routed "cloudflare" }}
- name: NACRE_EMBED_CLOUDFLARE_ACCOUNT
  value: {{ $ea.vendors.cloudflare.account | quote }}
- name: NACRE_EMBED_CLOUDFLARE_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $ea.vendors.cloudflare.existingSecret }}
      key: {{ $ea.vendors.cloudflare.secretKey }}
{{- end }}
{{- if hasKey $routed "google" }}
- name: NACRE_EMBED_GOOGLE_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $ea.vendors.google.existingSecret }}
      key: {{ $ea.vendors.google.secretKey }}
{{- end }}
{{- if hasKey $routed "voyage" }}
- name: NACRE_EMBED_VOYAGE_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $ea.vendors.voyage.existingSecret }}
      key: {{ $ea.vendors.voyage.secretKey }}
{{- end }}
{{- $rr := $ea.rerank }}
{{- if $rr.vendor }}
- name: NACRE_RERANK_VENDOR
  value: {{ $rr.vendor | quote }}
- name: NACRE_RERANK_MODEL
  value: {{ $rr.model | quote }}
{{- end }}
{{/*
One branch per vendor with the variable name written out, rather than one branch
composing `NACRE_RERANK_{{ upper .vendor }}_API_KEY`. The composed form is
shorter and it would put this file out of reach of
`scripts/check-chart-vendors.mjs`, which compares the literal variable names
here against the adapter's tables — the same reason the adapter itself spells
every name out instead of building it from the vendor's. A check that cannot see
the string it is checking is the shape being avoided, not a style preference.
*/}}
{{- if eq $rr.vendor "cloudflare" }}
- name: NACRE_RERANK_CLOUDFLARE_ACCOUNT
  value: {{ $rr.vendors.cloudflare.account | quote }}
- name: NACRE_RERANK_CLOUDFLARE_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $rr.vendors.cloudflare.existingSecret }}
      key: {{ $rr.vendors.cloudflare.secretKey }}
{{- end }}
{{- if eq $rr.vendor "cohere" }}
- name: NACRE_RERANK_COHERE_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $rr.vendors.cohere.existingSecret }}
      key: {{ $rr.vendors.cohere.secretKey }}
{{- end }}
{{- if eq $rr.vendor "jina" }}
- name: NACRE_RERANK_JINA_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $rr.vendors.jina.existingSecret }}
      key: {{ $rr.vendors.jina.secretKey }}
{{- end }}
{{- if eq $rr.vendor "voyage" }}
- name: NACRE_RERANK_VOYAGE_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $rr.vendors.voyage.existingSecret }}
      key: {{ $rr.vendors.voyage.secretKey }}
{{- end }}
{{- end -}}
