/**
 * The skill an agent gets on an installation nobody has configured.
 *
 * docs/skills.md calls this the most important artifact in the feature, and
 * that is not modesty about the rest: most agents connected to most
 * installations will read this and nothing else. It is judged by running it —
 * a fresh agent on the demo stand with no other guidance, storing and finding
 * things correctly — and not by reading it back.
 *
 * A TypeScript module rather than a Markdown file beside it, because the build
 * emits `dist/` and nothing else, and a file the package needs at runtime that
 * the build does not copy is how `migrate()` once threw ENOENT from the
 * published package.
 *
 * It must pass `checkSkill` — a case in `skill.test.ts` holds it — so the
 * default is never a skill the format would refuse from anybody else.
 */
import type { SkillFiles } from './skill.js'

const SKILL = `---
name: nacre-index
description: How to search and store knowledge in this Nacre index — what to look up before answering, what belongs in it, how to name and tag a document, and how to tell that it arrived. Use whenever you read from or write to Nacre.
---

# Working with this Nacre index

Nacre is this organization's knowledge index. Everything you search here is
filtered to what the person or account you act for may read, and everything you
store is kept for the next agent and the next person. Treat it as shared,
long-lived memory: search it before you guess, and store what is worth finding
again.

## Before you start

- Call \`list_layers\` to see the layers you can reach. A layer is a collection
  with one purpose — a handbook, contracts, engineering notes.
- Call \`list_skills\`. A layer may carry its own skill saying what belongs in
  it and how documents there are named. **Read a layer's skill with
  \`get_skill\` before you write to that layer.** Where it disagrees with this
  page, the layer's skill wins.

## Searching

- Ask in two ways: once in plain words ("how do we rotate the signing key"),
  once with the exact terms a document would contain — an error code, a
  contract number, a variable name, a surname. The search matches meaning and
  literal terms both.
- Narrow with \`layers\` when you know where something lives, and with
  \`filters\` on metadata when a layer's skill names its keys.
- **An empty result is an answer.** It means nothing you may see matched.
  Do not rephrase the same question hoping for a different result, and do not
  report the index as broken.
- **"Not found" means not found or not permitted, deliberately the same.**
  Do not try to tell them apart.
- Say when an answer came from the index, and name the document's title.

## Storing

**What belongs here:** knowledge someone will need again and could not
quickly rebuild — a decision and why it was made, a procedure that worked, a
non-obvious fix, a reference fact about a system, a convention.

**What never goes in, unless a layer's skill explicitly says otherwise:**

- secrets of any kind: passwords, API keys, tokens, private keys, connection
  strings with credentials. Keep the *name* of a variable, never its value;
  write \`<TOKEN>\` where a value would go;
- personal data: names of private individuals, email addresses, phone numbers,
  identity or payment numbers, customers' records;
- one-off chatter, drafts, and guesses you have not checked.

If you are unsure whether something is a secret, treat it as one.

**How to store it:**

1. **Pick the layer by its purpose**, from \`list_layers\` and the layer's skill.
   If no layer fits, say so instead of putting it somewhere it does not belong.
2. **Search first.** If a document on the subject exists, update it rather
   than adding a second one.
3. **One subject per document**, written so a reader with no context
   understands it: a clear title, a one-line summary at the top, then the
   detail.
4. **Give it a stable \`external_id\`** — a readable key derived from the
   subject, not from the date, such as \`deploy/rotate-signing-key\`. Sending
   the same \`external_id\` again **replaces** the document, which is how you
   update it. A new id makes a duplicate.
5. **Tag it** with \`metadata\`: lower-case keys, simple values. Use the keys a
   layer's skill names; otherwise \`type\` and \`updated\` (YYYY-MM-DD) are a good
   default.
6. **Choose the right way in:**
   - text you wrote → \`ingest_document\` with \`content\`;
   - a public page → \`ingest_document\` with \`url\`;
   - a file you hold (PDF, Word, a spreadsheet) → \`request_upload\`, then send
     the file to the URL it returns, so the file is not retyped through your
     context;
   - a file the person wants to pick → \`upload_file\`, where it is offered.
7. **Check that it arrived.** An ingest answers \`queued\`, which is not success.
   Call \`ingest_status\` with the \`job_id\` until it says \`indexed\`. \`indexed\`
   with zero chunks means no text was found; \`failed\` comes with a reason that
   says whether sending again would help.

## Removing

\`delete_document\` takes a document out of every search at once. Remove what is
wrong or obsolete; do not remove something just because you did not write it —
correct it instead, with the same \`external_id\`.

## Permissions you will meet

- Write does not imply read. You may be able to store into a layer you cannot
  search; a write that succeeds followed by a search that finds nothing is
  correct, not a failure.
- The person who connected you may have limited this connection to some
  layers, or to reading only. A refusal to write is that limit, not an error to
  work around.
`

export const DEFAULT_SKILL: SkillFiles = { 'SKILL.md': SKILL }
