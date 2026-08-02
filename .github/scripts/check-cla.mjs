#!/usr/bin/env node
/**
 * Has everyone who wrote this pull request signed the CLA?
 *
 * `CONTRIBUTING.md` used to declare a DCO that nothing checked, which is a
 * requirement stated and not in force — a pull request with no sign-off merged
 * exactly as easily as one with it, so the legal value of the declaration was
 * zero. Replacing the declaration without also building the gate would have
 * reproduced that.
 *
 * ## Where the signature list comes from
 *
 * The **base branch**, never the pull request. This is the whole security of the
 * scheme: read it from the merge ref and a contribution adds itself to the list
 * and passes its own check. Read it from the base and the only way in is a
 * maintainer merging a signature pull request.
 *
 * ## The exemption, and why it is not a hole
 *
 * A pull request that changes only `.github/cla/signatures.json` is exempt,
 * because otherwise signing is impossible — the first pull request anyone opens
 * would be blocked by the check it is trying to satisfy. It is safe for the
 * reason above: that pull request can add a name to a list and do nothing else,
 * and a human merges it.
 *
 * ## What it compares
 *
 * Every author and committer email on every commit in the pull request, against
 * the emails of owners, signers, and known machine identities. Emails rather
 * than GitHub logins, because the commit is the artefact that carries copyright
 * and its author field is what a court would read — a pull request opened by one
 * account can carry commits written by several people, and `Co-authored-by`
 * makes that ordinary rather than exotic.
 *
 * Consequence worth stating: a signer who commits from an address they did not
 * list will fail this check. That is deliberate. The fix is one line in their
 * entry, and the alternative — matching on name, or on the pull request author
 * alone — accepts contributions from people who never agreed to anything.
 */

import { execFileSync } from 'node:child_process'

const SIGNATURES_PATH = '.github/cla/signatures.json'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

/**
 * The signature list as the base branch has it, or `undefined` if it has none.
 *
 * Absent and unreadable are different answers, and collapsing them is how this
 * check quietly stops checking.
 *
 * **Absent** means the agreement is not in force on that branch yet. That is a
 * real state and not an error: the pull request that introduces the CLA cannot
 * satisfy a check that reads a file only that pull request creates, and the
 * same applies to any branch cut from before it landed. Passing is correct —
 * one merge later the file exists on the base and every pull request after it
 * is gated, with no way back to this state.
 *
 * **Unreadable** means the file is there and is not JSON, which is corruption or
 * tampering. That fails.
 */
function signaturesFromBase(baseRef) {
  let raw
  try {
    // stderr swallowed: git says "exists on disk, but not in <ref>", which is
    // the expected answer here and reads as a failure in a build log.
    raw = execFileSync('git', ['show', `${baseRef}:${SIGNATURES_PATH}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }

  try {
    return JSON.parse(raw)
  } catch (cause) {
    console.error(
      `${SIGNATURES_PATH} exists on ${baseRef} and is not valid JSON. Refusing to ` +
        'treat an unparseable signature list as an empty one.',
    )
    console.error(String(cause))
    process.exit(1)
  }
}

function summarise(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY
  const text = `${lines.join('\n')}\n`
  if (path !== undefined) {
    execFileSync('tee', ['-a', path], { input: text, stdio: ['pipe', 'ignore', 'inherit'] })
  }
  process.stdout.write(text)
}

function main() {
  const base = process.argv[2]
  const head = process.argv[3]
  if (base === undefined || head === undefined) {
    console.error('usage: check-cla.mjs <base-ref> <head-ref>')
    process.exit(2)
  }

  const changed = git('diff', '--name-only', `${base}...${head}`).split('\n').filter(Boolean)

  // Nothing changed at all is not a CLA question.
  if (changed.length === 0) {
    summarise(['## CLA', '', 'No files changed.'])
    return
  }

  if (changed.every((f) => f === SIGNATURES_PATH)) {
    summarise([
      '## CLA — signature pull request',
      '',
      `This pull request changes only \`${SIGNATURES_PATH}\`, so the check is skipped:`,
      'signing would otherwise be blocked by the check it is meant to satisfy.',
      '',
      'A maintainer merging it is what records the agreement.',
    ])
    return
  }

  const list = signaturesFromBase(base)

  if (list === undefined) {
    summarise([
      '## CLA — not in force on this branch yet',
      '',
      `\`${SIGNATURES_PATH}\` does not exist on \`${base}\`, so there is no signature`,
      'list to check against and nothing to enforce.',
      '',
      'This is the bootstrap case: the pull request that introduces the agreement',
      'creates that file, and a check reading it from the base branch cannot see it',
      'until that pull request merges. One merge later the file is on the base and',
      'every pull request after it is gated — there is no path back to this state.',
    ])
    return
  }

  const known = new Map()
  const remember = (email, who) => {
    if (typeof email === 'string' && email.trim() !== '') {
      known.set(email.trim().toLowerCase(), who)
    }
  }

  for (const owner of list.owners ?? []) {
    for (const email of owner.emails ?? []) remember(email, `${owner.name} (owner)`)
  }
  for (const machine of list.machines ?? []) {
    remember(machine.email, `${machine.email} (machine)`)
  }
  for (const signer of list.signatures ?? []) {
    // A signature against an older version of the agreement is not a signature
    // against this one. Saying so beats silently accepting it.
    const stale = signer.version !== list.claVersion
    for (const email of signer.emails ?? []) {
      if (!stale) remember(email, `${signer.name} (signed v${signer.version})`)
    }
    if (stale) {
      console.error(
        `note: ${signer.name} signed version ${signer.version}, the current version is ${list.claVersion}`,
      )
    }
  }

  // Author and committer both. A commit applied by someone else still carries
  // its author's copyright, and a committer who rewrote it carries their own.
  const identities = git('log', '--format=%ae%n%ce', `${base}..${head}`)
    .split('\n')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

  const unknown = [...new Set(identities)].filter((email) => !known.has(email))

  if (unknown.length === 0) {
    const who = [...new Set(identities.map((e) => known.get(e)))].sort()
    summarise([
      '## CLA — signed',
      '',
      ...who.map((w) => `- ${w}`),
    ])
    return
  }

  summarise([
    '## CLA — not signed',
    '',
    'These commit identities are not on the signature list:',
    '',
    ...unknown.map((e) => `- \`${e}\``),
    '',
    '### What to do',
    '',
    'If one of these is you and you have not signed: read [`CLA.md`](../blob/HEAD/CLA.md)',
    `and open a separate pull request adding yourself to \`${SIGNATURES_PATH}\`.`,
    'It must contain that change and nothing else — such a pull request skips this',
    'check, which is the only way signing is possible at all.',
    '',
    'If you have signed but an address above is missing, add it to the `emails`',
    'list in your entry. The check reads commit metadata, so every address you',
    'author from has to be listed.',
    '',
    'If the address belongs to tooling rather than a person, it belongs in',
    '`machines` — with a line saying whose behalf it commits on.',
  ])
  process.exit(1)
}

main()
