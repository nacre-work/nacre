#!/usr/bin/env bash
#
# Drive the whole loop against a running `minimal` stack: init, a layer, a grant,
# ingest to `indexed`, a search that returns the document, a revoke that removes
# it. This is the check the clean-clone runs kept doing by hand and finding
# defects a green unit suite could not — a port collision, a healthcheck loop, a
# migration that ran too late — so it belongs in CI, once, end to end.
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

say "the loop ran: init, layer, ingest→indexed, grant, search-hit, revoke, search-miss"
