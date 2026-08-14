#!/bin/sh
# Seed the `demo` profile: one organization, three layers, three people who see
# different things, and a corpus already indexed.
#
# The point of the demo is the one claim this product makes, and it cannot be
# shown with a single login: the same query, asked by three people, has to come
# back with three different answers. So this creates the grants that make that
# true and prints the credentials to try it with.
#
# **The passwords are generated, and that is why they are printed here rather
# than written into this file.** `POST /v1/users` refuses a password — an
# argument ends up in a shell history, and a password an administrator chose is
# one they know — so the only way to have them is to catch what the API
# returned. A demo that hardcoded three logins would be demonstrating a product
# that does not exist.
#
# It never seeds twice: a second run would issue a second set of passwords and
# print them beside users whose real ones are the first set. It re-prints
# instead, from a file in a volume — which exists because `down` and `up`
# otherwise left a working stack whose logins nobody could recover. The
# container holding the only copy of that output is gone by then, and the
# database holds a scrypt hash.
#
# Resetting is `down -v`: the organization and the credentials go together,
# which is the property that makes the file safe to keep at all.
set -eu

API="${NACRE_API_URL:-http://api:8080}"
ORG="${DEMO_ORG:-demo}"
CLI="node /app/packages/cli/dist/main.js"
CORPUS="${DEMO_CORPUS:-/demo/corpus}"
# Written by the seed and read back by the next run. See the volume's note in
# docker-compose.yml: these are generated once and stored nowhere else in
# plaintext, so without this a `down` and an `up` left a working stack whose
# logins nobody could recover.
STATE="${DEMO_STATE:-/state}"
SAVED="${STATE}/credentials.txt"
# The admin password on its own, so a later run can prove the saved block still
# describes a live organization rather than print it and hope.
PROOF="${STATE}/admin-password"

say() { printf '%s\n' "$*"; }

# The corpus ships in the image. If it is not here, the image predates the demo
# profile — `latest` on a stack pulled before this shipped — and every message
# after this point would be about a symptom rather than the cause.
if [ ! -d "$CORPUS" ]; then
  say "no corpus at ${CORPUS}."
  say ""
  say "This image does not carry the demo profile's corpus, which means it is"
  say "older than the profile. Either pin NACRE_VERSION to a release that has"
  say "it — the first one is named in docs/upgrading.md — or drop the images"
  say "overlay and let Compose build from this checkout."
  exit 1
fi

# `/v1/ready` and not `/v1/health`: health is liveness and answers before the
# schema is there. Ready refuses while the migrator is behind, which is exactly
# the window this script must not start in.
say "waiting for the API to be ready"
i=0
until node -e "
  fetch('${API}/v1/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))
" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    say "the API never became ready. \`docker compose logs api\` says why."
    exit 1
  fi
  sleep 2
done

# Has this stack been seeded?
#
# **Not by asking the API**, and the first version of this did. It posted a
# wrong password to `/v1/auth/login` and read `401` as "the organization is
# there". But that endpoint answers `401` to an unknown organization, an unknown
# address, a wrong password and a disabled account with one status and one
# message — deliberately, so nobody can discover what exists by probing it. So
# the probe reported "already seeded" against a database created thirty seconds
# earlier, and the seed refused to run on an empty stack.
#
# The product's own refusal to leak existence is what defeated it, which is the
# right outcome for the product and a lesson about the probe.
#
# The state volume is the signal instead. It is created and destroyed with the
# database — both go on `down -v` — so its presence is the same fact. And it is
# *verified* rather than trusted: signing in with the password it saved proves
# the organization behind it is still there.
if [ -r "$PROOF" ]; then
  if node -e "
    fetch('${API}/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@${ORG}.local',
        password: require('node:fs').readFileSync('${PROOF}', 'utf8').trim(),
        organization: '${ORG}',
      }),
    }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))
  " 2>/dev/null; then
    if [ -r "$SAVED" ]; then
      say "organization ${ORG} is already seeded, and these still work:"
      say ""
      cat "$SAVED"
      exit 0
    fi
    # The organization exists and the summary does not, so a previous run died
    # between creating it and finishing. Seeding again would fail on a duplicate
    # layer slug; saying so beats that.
    say "organization ${ORG} exists but the seed did not finish."
    say ""
    say "Start over: docker compose --profile demo down -v"
    exit 1
  fi

  say "there is saved state for ${ORG} and its administrator cannot sign in."
  say ""
  say "The database and this volume have come apart — one was removed without"
  say "the other. Start over: docker compose --profile demo down -v"
  exit 1
fi

say "creating the organization"
INIT="$(node /app/packages/api/dist/init.js --org "$ORG" --email "admin@${ORG}.local" --name "Nacre Demo")"
say "$INIT"

# init prints a token good for an hour, which is more than a seed needs. Taking
# it from the output rather than signing in keeps the admin's generated password
# out of this script entirely.
NACRE_TOKEN="$(printf '%s' "$INIT" | sed -n 's/.*export NACRE_TOKEN=\([A-Za-z0-9._-]*\).*/\1/p' | head -1)"
if [ -z "$NACRE_TOKEN" ]; then
  say "could not read a token out of init's output; it may have changed shape."
  exit 1
fi
export NACRE_TOKEN
export NACRE_API_URL="$API"

ADMIN_PASSWORD="$(printf '%s' "$INIT" | sed -n 's/^  \([a-z][a-z-]*-[0-9][0-9]*\)$/\1/p' | head -1)"
if [ -z "$ADMIN_PASSWORD" ]; then
  say "could not read the administrator's password out of init's output."
  exit 1
fi

# Written here rather than with the rest, because from this line on the
# organization exists: a failure between now and the summary would otherwise
# leave a stack nobody can sign in to and no record that it happened.
#
# **Not fatal when it fails, and that is deliberate.** A named volume created
# before the image owned `/state` belongs to root, and this process is not root
# — so the write is refused on exactly the stacks that have been running
# longest. Dying there would take a working demo down over a place to put a
# note, so it degrades to the behaviour it had before the volume existed and
# says which one you are getting.
umask 077
STATEFUL=yes
mkdir -p "$STATE" 2>/dev/null || true
if ! printf '%s\n' "$ADMIN_PASSWORD" > "$PROOF" 2>/dev/null; then
  STATEFUL=no
  say ""
  say "cannot write to ${STATE} — the credentials below will be in this log and"
  say "nowhere else, and a restart will not be able to print them again."
  say ""
  say "The volume predates the image that owns ${STATE}. To fix it for good:"
  say "  docker compose --profile demo down -v"
  say ""
fi

say "creating layers"
for layer in handbook engineering contracts; do
  $CLI layers create "$layer" --name "$(printf '%s' "$layer" | cut -c1 | tr 'a-z' 'A-Z')$(printf '%s' "$layer" | cut -c2-)" >/dev/null
done

# Three identities, and the grants are the demonstration.
#
#   engineer    handbook + engineering        — the ordinary employee
#   contractor  handbook only                 — the outside party
#   admin       everything, by role           — including contracts
#
# Nobody is granted `contracts`: the administrator reaches it through their
# role, which is what makes "sign in as the contractor and search for the
# contract number" return nothing rather than an error.
CREDENTIALS=""
for person in engineer contractor; do
  created="$($CLI users create "${person}@${ORG}.local" --json)"
  id="$(printf '%s' "$created" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).id))")"
  password="$(printf '%s' "$created" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).password))")"
  CREDENTIALS="${CREDENTIALS}$(printf '  %-24s %s\n' "${person}@${ORG}.local" "$password")\n"

  $CLI grant read layer:handbook --to "user:${id}" >/dev/null
  # An explicit `if` rather than `[ … ] && …`: under `set -e` the AND-OR list is
  # exempt in dash and in busybox ash, and I could only test one of the two here.
  # The container runs the other.
  if [ "$person" = "engineer" ]; then
    $CLI grant read layer:engineering --to "user:${id}" >/dev/null
  fi
  say "created ${person}"
done

say "indexing the corpus"
for layer in handbook engineering contracts; do
  $CLI ingest "${CORPUS}/${layer}" --layer "$layer"
done

# Written before it is printed. A crash between the two would otherwise lose
# the only copy of three passwords that exist nowhere else — except where the
# volume is not writable, in which case this goes to a temporary file and the
# warning above already said so.
SUMMARY="$SAVED"
if [ "$STATEFUL" = no ]; then SUMMARY="$(mktemp)"; fi
{
  printf '%s\n' "────────────────────────────────────────────────────────────────"
  printf '%s\n' " The demo is seeded. Three people, three different answers."
  printf '%s\n' ""
  printf '  %-24s %s\n' "admin@${ORG}.local" "$ADMIN_PASSWORD"
  printf '%b' "$CREDENTIALS"
  printf '%s\n' ""
  printf '%s\n' " Organization: ${ORG}"
  printf '%s\n' ""
  printf '%s\n' " Try the same query as each of them:"
  printf '%s\n' ""
  printf '%s\n' "   \"what is the contract number for Northwind\""
  printf '%s\n' ""
  printf '%s\n' "  admin       finds it — contracts, by role"
  printf '%s\n' "  engineer    finds nothing — no grant on contracts"
  printf '%s\n' "  contractor  finds nothing — handbook only"
  printf '%s\n' ""
  printf '%s\n' " Not filtered out of a longer list. The permission filter runs inside"
  printf '%s\n' " the index traversal, so those searches never reached the document."
  printf '%s\n' ""
  printf '%s\n' " Printed again by any later run of this container, and gone for good"
  printf '%s\n' " on \`down -v\` — which is also when the organization goes."
  printf '%s\n' "────────────────────────────────────────────────────────────────"
} > "$SUMMARY"

say ""
cat "$SUMMARY"
