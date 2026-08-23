#!/bin/sh
# Execute docs/quickstart.md's "Two minutes, nothing configured" block — the
# block itself, extracted from the document, not a transcription of it.
#
# The demo job used to spell its own steps, and the two drifted in the one way
# nothing could see: CI ran `cp .env.example .env` on its own line 690 while
# the doc's command block omitted it, so a reader following the block verbatim
# met an API crash-looping on `NACRE_JWT_SECRET is not set` — found by running
# the block from a clean directory, which nothing had ever done. Executing the
# doc is what makes that class impossible: a command the doc omits is a
# command this job does not run.
#
# Two substitutions, both stated because each is the difference between a
# reader's machine and a runner:
#
#   - the `git clone … && cd nacre` line is dropped — CI is already inside the
#     checkout it must test;
#   - with CI_BUILD_FROM_TREE=1, `-f docker-compose.images.yml` is removed and
#     `--build` is appended to the `up` line: the overlay exists so a reader
#     runs the released images, and a pull request's job exists to test the
#     tree, so the one thing CI may not take from the doc is which code runs.
#
# Everything else runs verbatim, `logs -f demo-seed` included — it follows the
# one-shot and returns when the seed exits, so the block terminates on its own.
set -eu

DOC=docs/quickstart.md
HEADING='## Two minutes, nothing configured'

[ -r "$DOC" ] || { echo "::error::$DOC is not readable from $(pwd)"; exit 1; }

BLOCK="$(awk -v h="$HEADING" '
  $0 == h { in_section = 1 }
  in_section && /^```bash$/ { in_block = 1; next }
  in_block && /^```$/ { exit }
  in_block { print }
' "$DOC")"

if [ -z "$BLOCK" ]; then
  echo "::error::$DOC has no bash block under \"$HEADING\". This job executes that block;" \
       "with nothing to execute it must not report green."
  exit 1
fi

BLOCK="$(printf '%s\n' "$BLOCK" | grep -v '^git clone ')"

if [ "${CI_BUILD_FROM_TREE:-}" = "1" ]; then
  BLOCK="$(printf '%s\n' "$BLOCK" \
    | sed 's/ -f docker-compose\.images\.yml//g; s/^\(docker compose.* up -d\)$/\1 --build/')"
fi

echo "── the block, as it will run ──"
printf '%s\n' "$BLOCK"
echo "───────────────────────────────"

printf '%s\n' "$BLOCK" | sh -eu
