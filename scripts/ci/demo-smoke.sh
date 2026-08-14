#!/usr/bin/env bash
# The `demo` profile, started and asked its own question.
#
# This is the profile `docs/quickstart.md` points a first-time reader at, and
# until now nothing started it on a pull request — `lint:compose` pins what each
# profile *contains*, which is a different question from whether it comes up.
# The last time somebody ran it by hand it produced four defects, every one of
# them green in every suite.
#
# It is a separate job from the `minimal` e2e rather than more of it, because it
# tests something that one structurally cannot. `minimal` runs a stub embedder
# returning a constant vector, so relevance decides nothing there and the ACL
# pre-filter is the only thing under test. This runs a **real** model over a
# **real** corpus, which is the only arrangement in which "the same question
# gets three different answers" means anything: a filter that leaked would
# return the contract, and a retrieval path that was broken would return
# nothing to anybody.
#
# The assertion is the demo's own claim, in its own words:
#
#   admin       finds it — contracts, by role
#   engineer    finds nothing — no grant on contracts
#   contractor  finds nothing — handbook only
#
# and the negative half is the half that matters. Nobody is granted `contracts`;
# the administrator reaches it by role. So `NW-2026-0431` coming back for the
# engineer would be a leak, and it would be the kind no unit test sees, because
# every unit test builds the plan it then asserts on.
set -euo pipefail

COMPOSE=${COMPOSE:-docker compose -f docker-compose.yml -f docker-compose.ci.yml}
API=${API:-http://localhost:8080}
QUERY='what is the contract number for Northwind'
SECRET='NW-2026-0431'
DOMAIN=${NACRE_DEMO_EMAIL_DOMAIN:-demo.local}

say() { printf '\n▸ %s\n' "$*"; }
die() { printf '\n::error::%s\n' "$*" >&2; exit 1; }

# ── wait for the seed to finish ────────────────────────────────────────────
# `demo-seed` runs once and exits 0. Waiting on the container rather than
# polling the API: the seed is what creates the people this asks questions as,
# so "the API answers" is not the condition — "the seed finished" is.
say "wait for demo-seed"
for i in $(seq 1 150); do
  state=$(${COMPOSE} ps -a --format json demo-seed 2>/dev/null \
    | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('missing'); raise SystemExit
# One object per line, or a single array, depending on the Compose version.
rows = []
for line in raw.splitlines():
    line = line.strip()
    if not line: continue
    v = json.loads(line)
    rows.extend(v if isinstance(v, list) else [v])
row = next((r for r in rows if r.get('Service') == 'demo-seed'), rows[0] if rows else None)
print('missing' if row is None else f\"{row.get('State','?')}:{row.get('ExitCode','?')}\")
" 2>/dev/null || echo missing)
  case "$state" in
    exited:0) say "  seeded"; break ;;
    exited:*) ${COMPOSE} logs --no-color --tail 60 demo-seed || true
              die "demo-seed exited ${state#exited:}" ;;
  esac
  if [ "$i" = 150 ]; then
    ${COMPOSE} logs --no-color --tail 60 demo-seed demo-embedder worker || true
    die "demo-seed did not finish (last state: ${state})"
  fi
  sleep 4
done

# ── the credentials the seed generated ─────────────────────────────────────
# Read out of the volume rather than out of the log. The seed writes them
# before it prints them, deliberately, and a log is a stream this script would
# have to have been watching.
say "read the generated credentials"
CREDS=$(${COMPOSE} run --rm --no-deps -T --entrypoint sh demo-seed \
  -c 'cat /state/credentials.txt' 2>/dev/null) || die "could not read /state/credentials.txt"

password_for() {
  printf '%s' "$CREDS" | python3 -c "
import re, sys
who = sys.argv[1]
for line in sys.stdin.read().splitlines():
    parts = line.split()
    if len(parts) == 2 and parts[0] == who:
        print(parts[1]); break
" "$1"
}

token_for() {
  local email=$1 password=$2
  python3 - "$API" "$email" "$password" <<'PYEOF'
import json, sys, urllib.request, urllib.error
api, email, password = sys.argv[1], sys.argv[2], sys.argv[3]
body = json.dumps({"email": email, "password": password}).encode()
req = urllib.request.Request(f"{api}/v1/auth/login", data=body, method="POST",
    headers={"content-type": "application/json"})
try:
    print(json.load(urllib.request.urlopen(req, timeout=30))["access_token"])
except urllib.error.HTTPError as e:
    print("", end="")
    sys.stderr.write(f"login failed for {email}: {e.code} {e.read().decode()[:200]}\n")
PYEOF
}

# Returns the number of hits, and whether the secret was among them.
search_as() {
  local token=$1
  python3 - "$API" "$token" "$QUERY" "$SECRET" <<'PYEOF'
import json, sys, urllib.request
api, token, query, secret = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
body = json.dumps({"query": query, "top_k": 10}).encode()
req = urllib.request.Request(f"{api}/v1/search", data=body, method="POST",
    headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
items = json.load(urllib.request.urlopen(req, timeout=60))["items"]
leaked = any(secret in (h.get("text") or "") for h in items)
layers = sorted({h.get("layer") for h in items})
print(f"{len(items)} {'yes' if leaked else 'no'} {','.join(layers) if layers else '-'}")
PYEOF
}

for person in admin engineer contractor; do
  pw=$(password_for "${person}@${DOMAIN}")
  [ -n "$pw" ] || die "the seed printed no password for ${person}@${DOMAIN}: ${CREDS}"
  tok=$(token_for "${person}@${DOMAIN}" "$pw")
  [ -n "$tok" ] || die "${person} could not sign in with the password the seed generated"
  eval "TOKEN_${person}=\$tok"
  say "${person} signed in"
done

# ── the demonstration ──────────────────────────────────────────────────────
say "the same query, as each of the three"

# shellcheck disable=SC2154
read -r A_HITS A_LEAK A_LAYERS <<<"$(search_as "$TOKEN_admin")"
read -r E_HITS E_LEAK E_LAYERS <<<"$(search_as "$TOKEN_engineer")"
read -r C_HITS C_LEAK C_LAYERS <<<"$(search_as "$TOKEN_contractor")"

printf '  %-12s %s hit(s), contract number: %s, layers: %s\n' admin "$A_HITS" "$A_LEAK" "$A_LAYERS"
printf '  %-12s %s hit(s), contract number: %s, layers: %s\n' engineer "$E_HITS" "$E_LEAK" "$E_LAYERS"
printf '  %-12s %s hit(s), contract number: %s, layers: %s\n' contractor "$C_HITS" "$C_LEAK" "$C_LAYERS"

# The administrator reaches `contracts` by role and by no grant at all, so this
# is also the check that the corpus indexed and that retrieval works — without
# it, three empty answers would look like three correct ones.
[ "$A_LEAK" = yes ] \
  || die "the administrator did not find ${SECRET}. Either the corpus did not index or retrieval is broken — and with this failing, the two refusals below prove nothing."

# The two that matter. A leak here is invisible to every unit test, because a
# unit test builds the permission plan it then asserts against.
[ "$E_LEAK" = no ] \
  || die "the engineer reached ${SECRET}, which is in \`contracts\` and granted to nobody — a leak"
[ "$C_LEAK" = no ] \
  || die "the contractor reached ${SECRET}, which is in \`contracts\` and granted to nobody — a leak"

# And the contractor holds `handbook` alone, so anything else in their results
# is a scope the grant does not name.
case "$C_LAYERS" in
  handbook|-) ;;
  *) die "the contractor's results came from ${C_LAYERS}; the only grant they hold is handbook" ;;
esac

# Non-empty for everybody, or the refusals above are just an empty index.
[ "$E_HITS" -ge 1 ] || die "the engineer got no hits at all; they hold handbook and engineering"
[ "$C_HITS" -ge 1 ] || die "the contractor got no hits at all; they hold handbook"

say "three people, one query, three different answers — on a real model"
