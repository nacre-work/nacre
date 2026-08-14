#!/usr/bin/env bash
#
# Drive the whole loop against a running `minimal` stack: init, a layer, a grant,
# ingest to `indexed`, a search that returns the document, a revoke that removes
# it. This is the check the clean-clone runs kept doing by hand and finding
# defects a green unit suite could not — a port collision, a healthcheck loop, a
# migration that ran too late — so it belongs in CI, once, end to end.
#
# It also uploads a real PDF and asserts its extracted text comes back out of a
# search. That half needs object storage, which the CI overlay supplies: a
# binary document's bytes live in the bucket and nowhere else.
#
# It talks to the API on localhost:8080 (published by the api service) and runs
# `init` inside the api container. The token init prints is valid for an hour,
# which is all this needs, so there is no sign-in step.

set -euo pipefail

API="http://localhost:8080"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.ci.yml --profile minimal"

say() { echo "▸ $*"; }
die() { echo "::error::$*" >&2; exit 1; }

# curl that fails the step on a non-2xx, printing the body it got.
req() {
  local method="$1" path="$2" token="$3" body="${4:-}"
  local args=(-sS -X "$method" "${API}${path}" -H "authorization: Bearer ${token}" -H 'accept: application/json')
  if [ -n "$body" ]; then args+=(-H 'content-type: application/json' -d "$body"); fi
  local out status
  out=$(curl "${args[@]}" -w $'\n%{http_code}')
  status=${out##*$'\n'}
  body=${out%$'\n'*}
  if [ "${status:0:1}" != "2" ]; then die "${method} ${path} -> ${status}: ${body}"; fi
  printf '%s' "$body"
}

# ── the API is up ──────────────────────────────────────────────────────────
say "waiting for the API to answer /v1/health"
for i in $(seq 1 60); do
  if curl -fsS "${API}/v1/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then die "the API never became healthy"; fi
  sleep 2
done
say "API healthy"

# ── the admin front-door serves the UI on one origin with the API ──────────
# The `web` service serves the static admin bundle and proxies /v1 to the api
# service, so the browser makes same-origin requests and needs no CORS. Assert
# both halves: the bundle answers at /, and /v1 reaches the API through it.
WEB="http://localhost:${NACRE_WEB_HOST_PORT:-8082}"
say "waiting for the admin UI on the web front-door"
for i in $(seq 1 30); do
  if curl -fsS "${WEB}/" >/dev/null 2>&1; then break; fi
  if [ "$i" = 30 ]; then die "the admin UI never answered on the web front-door"; fi
  sleep 2
done
curl -fsS "${WEB}/" | grep -qi '<title' || die "the web front-door did not serve an HTML page at /"
curl -fsS "${WEB}/v1/health" >/dev/null || die "the API was not reachable through the web front-door at /v1"

# The rest of the origin: discovery, the authorization server, and MCP. All four
# have to be here or a client that reaches this address gets a console that works
# and an OAuth flow that dead-ends — which is what having them on three ports
# cost, three different ways.
curl -fsS "${WEB}/.well-known/oauth-protected-resource" >/dev/null \
  || die "the RFC 9728 document was not reachable through the front-door"
curl -fsS "${WEB}/.well-known/oauth-authorization-server" >/dev/null \
  || die "the RFC 8414 document was not reachable through the front-door"
# 400 rather than 2xx: an empty registration is refused, which is the endpoint
# answering. A 404 here is the proxy missing, and `-o /dev/null -w` reads the
# status rather than letting curl -f collapse both into one failure.
REG=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${WEB}/oauth/register" \
  -H 'Content-Type: application/json' -d '{}')
[ "${REG}" = "404" ] && die "/oauth is not proxied through the front-door (register answered 404)"

# MCP, and the header is the assertion rather than the status.
#
# A 401 naming a `resource_metadata` URL **with the port on it** is what proves
# the proxy forwards `Host` intact: the transport derives its RFC 9728 identifier
# from that header, and RFC 9728 has the client compare it against the URL it
# connected to. nginx's `$host` strips the port, and forwarding it produced
# `http://localhost/...` for a client that reached `:8082` — a mismatch, and a
# refusal before any token is sent. Found by starting the stack and reading one
# header; nothing else here would have caught it.
MCP_401=$(curl -s -i -X POST "${WEB}/mcp" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | tr -d '\r')
echo "${MCP_401}" | grep -qi '^HTTP/1.1 401' \
  || die "/mcp is not proxied through the front-door (no 401 from the transport)"
echo "${MCP_401}" | grep -qi "resource_metadata=\"${WEB}/.well-known/oauth-protected-resource\"" \
  || die "the front-door dropped the port from Host: $(echo "${MCP_401}" | grep -i www-authenticate)"

# And the same assertion for the **scheme**, which is the other half of that
# identifier and was wrong for every deployment terminating TLS in front of this
# container.
#
# `X-Forwarded-Proto $scheme` sent the scheme of the connection *into* nginx,
# which is plaintext behind any ingress — so the front door overwrote the outer
# proxy's correct `https` with `http`, and an HTTPS installation answered
# `resource_metadata="http://host/..."` while the document at that URL said
# `"resource":"https://host"`. One installation disagreeing with itself, and a
# client pointed at a plaintext URL for an OAuth discovery document. Found by
# reading one header on a real deployment.
#
# The stack here is plaintext, so this is the only way to exercise the header:
# claim `https` the way an outer proxy does and require it to survive. Above,
# with no such header, the assertion is that it falls back to this connection's
# scheme — so the two together pin both branches of the map.
MCP_HTTPS=$(curl -s -i -X POST "${WEB}/mcp" -H 'Content-Type: application/json' \
  -H 'X-Forwarded-Proto: https' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | tr -d '\r')
echo "${MCP_HTTPS}" | grep -qi "resource_metadata=\"https://" \
  || die "the front-door overwrote X-Forwarded-Proto, so an HTTPS installation advertises an http:// discovery URL: $(echo "${MCP_HTTPS}" | grep -i www-authenticate)"

say "console, /v1, /oauth, /.well-known and /mcp all on the web front-door, scheme and port intact"

# ── init: one organization, one admin, the collection ──────────────────────
say "init"
INIT=$(${COMPOSE} run --rm -T api node packages/api/dist/init.js \
  --org acme --email admin@example.com --name Acme)
echo "$INIT"

TOKEN=$(printf '%s\n' "$INIT" | sed -n 's/.*NACRE_TOKEN=\([A-Za-z0-9._-]*\).*/\1/p' | head -1)
WORKSPACE=$(printf '%s\n' "$INIT" | grep -oiE 'Workspace id[[:space:]]+[0-9a-f-]{36}' | grep -oiE '[0-9a-f-]{36}' | head -1)
[ -n "$TOKEN" ] || die "init printed no token"
[ -n "$WORKSPACE" ] || die "init printed no workspace id"
say "workspace ${WORKSPACE}"

# ── a layer ────────────────────────────────────────────────────────────────
say "create a layer"
LAYER=$(req POST /v1/layers "$TOKEN" \
  "{\"workspace_id\":\"${WORKSPACE}\",\"slug\":\"handbook\",\"name\":\"Handbook\"}")
LAYER_ID=$(printf '%s' "$LAYER" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
say "layer ${LAYER_ID}"

# The admin is org_admin, which resolves to every scope in the organization
# (rule 3), so it ingests and searches by role and needs no grant. That also
# means the admin is the wrong principal to test a revoke with — its access does
# not come from a grant. The grant/revoke below is against a service account,
# which has no role and resolves purely from its grants.

# ── ingest, and wait for it to reach indexed ───────────────────────────────
say "ingest a document"
JOB=$(req POST /v1/documents "$TOKEN" \
  "{\"layer\":\"handbook\",\"external_id\":\"onboarding\",\"title\":\"Onboarding\",\"content\":\"New engineers get repository access on their first day.\"}")
JOB_ID=$(printf '%s' "$JOB" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")
say "job ${JOB_ID}"

for i in $(seq 1 60); do
  STATUS=$(req GET "/v1/jobs/${JOB_ID}" "$TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  say "  job status: ${STATUS}"
  case "$STATUS" in
    indexed) break ;;
    failed) die "ingest failed" ;;
  esac
  if [ "$i" = 60 ]; then die "the job never reached indexed"; fi
  sleep 2
done

# ── a PDF, all the way through ─────────────────────────────────────────────
# The one path no unit test can prove: the edge accepts the bytes, the bucket
# holds them, the worker fetches them back and hands them to the sidecar as a
# raw body, the extractor pulls the text out, and that text comes back out of a
# search.
# Every stage of binary ingest was tested against a mock of the next one; this
# is the first time they are asked to agree with each other.
PDF_TEXT="Espresso machine refills happen every Tuesday"
say "build a real PDF"
python3 scripts/ci/make-pdf.py /tmp/coffee.pdf "$PDF_TEXT"
head -c 5 /tmp/coffee.pdf | grep -q '%PDF-' || die "the generated file is not a PDF"

# Multipart, so `req` does not fit: this is the one request in the loop that
# carries bytes rather than a JSON body.
upload_pdf() {
  local declared="$1" out status body
  out=$(curl -sS -X POST "${API}/v1/documents" \
    -H "authorization: Bearer ${TOKEN}" -H 'accept: application/json' \
    -F 'layer=handbook' -F 'external_id=coffee-policy' -F 'title=Coffee policy' \
    -F "file=@/tmp/coffee.pdf;type=${declared}" \
    -w $'\n%{http_code}')
  status=${out##*$'\n'}
  body=${out%$'\n'*}
  # Status first, body after: the body is what varies in length, so anything
  # reading this takes line 1 and then everything from line 2 on.
  printf '%s\n%s' "$status" "$body"
}

# The refusal first, because it must not depend on anything the accepted
# upload leaves behind. Same bytes, a declared type they contradict: both
# signals have to agree, and the answer names the one that is missing.
say "upload the PDF declared as text/plain — expect a refusal"
RESULT=$(upload_pdf 'text/plain')
[ "$(printf '%s' "$RESULT" | head -1)" = "400" ] || die "a PDF declared text/plain was not refused: ${RESULT}"
printf '%s' "$RESULT" | tail -n +2 | grep -q 'application/pdf' || die "the refusal did not name application/pdf: ${RESULT}"
say "  refused, naming the declaration"

say "upload the PDF properly declared"
RESULT=$(upload_pdf 'application/pdf')
[ "$(printf '%s' "$RESULT" | head -1)" = "202" ] || die "the PDF upload was not accepted: ${RESULT}"
PDF_BODY=$(printf '%s' "$RESULT" | tail -n +2)
PDF_JOB=$(printf '%s' "$PDF_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")
PDF_DOC=$(printf '%s' "$PDF_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['document_id'])")
say "pdf job ${PDF_JOB}"

for i in $(seq 1 60); do
  STATUS=$(req GET "/v1/jobs/${PDF_JOB}" "$TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  say "  pdf job status: ${STATUS}"
  case "$STATUS" in
    indexed) break ;;
    failed) die "the PDF ingest failed" ;;
  esac
  if [ "$i" = 60 ]; then die "the PDF job never reached indexed"; fi
  sleep 2
done

# The assertion that matters. The stub embedder returns a constant vector, so
# relevance decides nothing here and every permitted chunk comes back — which
# is exactly what makes this a test of *extraction* rather than of ranking:
# the text is in the response or it was never pulled out of the PDF.
say "search, and expect the PDF's own text in a hit"
hit_texts() { python3 -c "import sys,json; print('\n'.join(h.get('text','') for h in json.load(sys.stdin).get('items',[])))"; }
BODY=$(req POST /v1/search "$TOKEN" '{"query":"coffee","top_k":10}')
printf '%s' "$BODY" | hit_texts | grep -qF "$PDF_TEXT" \
  || die "the PDF's text never reached the index — search returned: ${BODY}"
say "  the extracted text came back from the index"

# Falls out for free, and says so in docs/architecture.md: the bytes are in the
# bucket, so the document carries a presigned link for a caller holding read.
say "the document carries a presigned source_url"
req GET "/v1/documents/${PDF_DOC}" "$TOKEN" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('source_url') else 1)" \
  || die "an s3-stored document carried no source_url"

# ── a scan, which must fail rather than succeed at nothing ────────────────
# The other half of extraction, and the one that used to pass silently. A PDF
# whose only content is an image extracted to `""`, chunked to nothing, wrote no
# points and reported `indexed`: accepted, returned by no search, and visible
# only as a `chunk_count` of zero that nothing reads.
#
# The whole chain has to be exercised for this, which is why it is here rather
# than in the sidecar's unit tests: the edge accepts the bytes, the bucket holds
# them, the worker fetches them back, and the refusal has to travel all the way
# to the job's status. A unit test proves the sidecar raises; only this proves
# an operator sees it.
say "upload a scan — expect the job to fail, naming the reason"
python3 scripts/ci/make-pdf.py /tmp/scan.pdf --scan
SCAN=$(curl -sS -X POST "${API}/v1/documents" \
  -H "authorization: Bearer ${TOKEN}" -H 'accept: application/json' \
  -F 'layer=handbook' -F 'external_id=a-scan' -F 'title=A scan' \
  -F 'file=@/tmp/scan.pdf;type=application/pdf')
SCAN_JOB=$(printf '%s' "$SCAN" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")

for i in $(seq 1 60); do
  SCAN_BODY=$(req GET "/v1/jobs/${SCAN_JOB}" "$TOKEN")
  STATUS=$(printf '%s' "$SCAN_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  case "$STATUS" in
    failed) break ;;
    indexed) die "a scan reported indexed; it has no text and no search will ever return it" ;;
  esac
  if [ "$i" = 60 ]; then die "the scan job never settled: ${SCAN_BODY}"; fi
  sleep 2
done
# The status alone is not enough. "failed" with an unhelpful reason sends an
# operator looking for a corrupt file; the remedy here is OCR, and only the
# message can say so.
printf '%s' "$SCAN_BODY" | grep -qi 'scan' \
  || die "the scan failed without saying it was a scan: ${SCAN_BODY}"
say "  refused, and the reason names it as a scan"

# ── a service account, a grant, and the revoke that removes it ─────────────
# The document is indexed and the admin can already see it by role. The ACL
# assertion is against a fresh service account: it sees nothing until granted,
# the document once granted, and nothing again once revoked — the last step
# being the invariant that matters.
say "create a service account"
SA=$(req POST /v1/service-accounts "$TOKEN" '{"name":"smoke-agent"}')
SA_ID=$(printf '%s' "$SA" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
SA_KEY=$(printf '%s' "$SA" | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")
say "service account ${SA_ID}"

count_hits() { python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('items',[])) if isinstance(d,dict) else len(d))"; }
search_as() {
  req POST /v1/search "$1" '{"query":"when do new hires get access","top_k":5}'
}

say "search as the service account before any grant — expect nothing"
BODY=$(search_as "$SA_KEY"); say "  response: ${BODY}"
[ "$(printf '%s' "$BODY" | count_hits)" -eq 0 ] || die "the service account saw the document with no grant"

say "grant the service account read on the layer"
GRANT=$(req POST /v1/grants "$TOKEN" \
  "{\"principal_type\":\"service_account\",\"principal_id\":\"${SA_ID}\",\"scope_type\":\"layer\",\"scope_id\":\"${LAYER_ID}\",\"permission\":\"read\"}")
GRANT_ID=$(printf '%s' "$GRANT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
say "grant ${GRANT_ID}"

say "search as the service account — expect a hit"
BODY=$(search_as "$SA_KEY"); say "  response: ${BODY}"
[ "$(printf '%s' "$BODY" | count_hits)" -ge 1 ] || die "the service account got no hit while its grant was in place"

say "revoke the grant"
req DELETE "/v1/grants/${GRANT_ID}" "$TOKEN" >/dev/null

say "search as the service account — expect nothing"
BODY=$(search_as "$SA_KEY"); say "  response: ${BODY}"
[ "$(printf '%s' "$BODY" | count_hits)" -eq 0 ] || die "the service account still saw the document after its grant was revoked — a leak"

# ── disaster recovery: lose the collection, rebuild it from Postgres ────────
# The Qdrant volume is gone — dropped here directly to stand in for it — and
# Postgres is the only record of what the collection was. `rebuild-collection`
# recreates it with the slots the layers name and requeues every document; the
# worker re-embeds them into it. The admin sees the document by role, so this
# asserts it comes back without touching a grant. The collection is `org_acme`
# because this organization has never been reindexed; after a reindex the name
# is the one in `organizations.vector_collection`, which the command reads.
say "the admin can see the document before the collection is lost"
BODY=$(search_as "$TOKEN"); say "  response: ${BODY}"
[ "$(printf '%s' "$BODY" | count_hits)" -ge 1 ] || die "the admin could not see the indexed document before the rebuild"

say "drop the Qdrant collection to stand in for a lost volume"
${COMPOSE} run --rm -T api node -e "(async () => { const r = await fetch(process.env.NACRE_QDRANT_URL + '/collections/org_acme', { method: 'DELETE' }); if (!r.ok) { console.error('drop failed:', r.status); process.exit(1); } console.log('dropped org_acme'); })()"

say "rebuild the collection from Postgres and requeue the documents"
${COMPOSE} run --rm -T api node packages/api/dist/rebuild-collection.js --org acme

say "wait for the worker to re-index into the rebuilt collection"
for i in $(seq 1 60); do
  BODY=$(search_as "$TOKEN")
  if [ "$(printf '%s' "$BODY" | count_hits)" -ge 1 ]; then break; fi
  say "  not re-indexed yet"
  if [ "$i" = 60 ]; then die "the document never came back after the rebuild"; fi
  sleep 2
done
say "the document is searchable again after the rebuild"

say "the loop ran: init, layer, ingest→indexed, grant, search-hit, revoke, search-miss, rebuild→search-hit"
