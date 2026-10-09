/**
 * The skill an agent gets on an installation nobody has configured.
 *
 * docs/skills.md calls this the most important artifact in the feature, and
 * that is not modesty about the rest: most agents connected to most
 * installations will read this and nothing else. It is judged by running it —
 * a fresh agent on the demo stand with no other guidance, storing and finding
 * things correctly — and not by reading it back.
 *
 * It is the organization's half — what to keep and how a document is written
 * — and deliberately carries none of the server's mechanics: those are the MCP
 * transport's built-in guide (`packages/mcp/src/instructions.ts`), because an
 * organization's own skill replaces this one entirely and would otherwise take
 * them with it.
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
description: What belongs in this organization's Nacre index and how a document is written there — what to look up before answering, what never goes in, how to name, tag and update a document. Use whenever you store to or search Nacre.
---

# Keeping this index worth searching

Treat the index as shared, long-lived memory: search it before you guess, and
store what someone will need again.

## Before you answer

- Search before answering from memory. Ask in two ways: once in plain words,
  once with the exact terms a document would contain — an error code, a
  contract number, a variable name, a surname.
- Say when an answer came from the index, and name the document's title.

## What belongs here

Knowledge someone will need again and could not quickly rebuild: a decision and
why it was made, a procedure that worked, a non-obvious fix, a reference fact
about a system, a convention.

## What never goes in, unless a layer's skill explicitly says otherwise

- Secrets of any kind: passwords, API keys, tokens, private keys, connection
  strings with credentials. Keep the *name* of a variable, never its value;
  write \`<TOKEN>\` where a value would go.
- Personal data: names of private individuals, email addresses, phone numbers,
  identity or payment numbers, customers' records.
- One-off chatter, drafts, and guesses you have not checked.

If you are unsure whether something is a secret, treat it as one.

## How a document is written

1. **Pick the layer by its purpose**, and read that layer's skill first. If no
   layer fits, say so instead of putting it somewhere it does not belong.
2. **Search first.** If a document on the subject exists, update it rather
   than adding a second one — under its own \`external_id\`, whatever it is.
3. **One subject per document**, written so a reader with no context
   understands it: a clear title, a one-line summary at the top, then the
   detail.
4. **For a new document, a readable \`external_id\` derived from the subject**,
   not from the date — such as \`deploy/rotate-signing-key\` — so the next
   update finds it.
5. **Tags in \`metadata\`**: lower-case keys, simple values. Use the keys a
   layer's skill names; otherwise \`type\` and \`updated\` (YYYY-MM-DD).
6. **Check that it arrived** before saying it is stored.

## Removing

Remove what is wrong or obsolete. Do not remove something just because you did
not write it — correct it instead, under the same \`external_id\`.
`

export const DEFAULT_SKILL: SkillFiles = { 'SKILL.md': SKILL }
