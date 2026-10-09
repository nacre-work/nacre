import { DEFAULT_SKILL, readFrontmatter } from '@nacre.work/core'
import { describe, expect, it } from 'vitest'

import { INSTRUCTIONS, instructionsFor } from '../instructions.js'
import { catalog, onTheWire } from '../tools.js'

/**
 * The built-in guide — what `initialize` tells every agent about this server.
 *
 * Two properties, and each is a way the guide has already been, or would have
 * been, wrong.
 *
 * **It names every tool.** A tool added to the catalog without a sentence here
 * is a tool an agent learns about only from its schema, and the schema says
 * what a tool takes, never when to reach for it. The tool tables in the docs
 * are held the same way, by `tool-annotations.test.ts`; this is the third
 * place the catalog is described and the one an agent actually reads.
 *
 * **The mechanics survive an organization's own skill.** They used to live in
 * the default skill, which an organization's skill replaces entirely — so the
 * first organization to write "contracts are signed PDFs only" would have taken
 * `queued` versus `indexed`, `request_upload` and the replace-by-`external_id`
 * rule away from every agent it has. The case below writes exactly such a skill
 * and asks the result.
 */

const body = (text: string): string => {
  const read = readFrontmatter(text)
  return 'body' in read ? read.body.trim() : text
}

describe('the built-in guide', () => {
  it('names every tool in the catalog', () => {
    const missing = onTheWire(catalog([]))
      .map((t) => t.name)
      .filter((name) => !INSTRUCTIONS.includes(`\`${name}\``))
    expect(missing, `the guide never names ${missing.join(', ')} — say when to reach for it`).toEqual([])
  })

  it('keeps the mechanics when an organization replaces the default skill with its own', () => {
    const own = {
      name: 'acme-index',
      description: 'How ACME keeps its index.',
      files: { 'SKILL.md': '---\nname: acme-index\ndescription: How ACME keeps its index.\n---\n\nContracts are signed PDFs only.\n' },
    }
    const text = instructionsFor(own, body)
    for (const fact of ['`queued`', '`ingest_status`', '`request_upload`', '`external_id`', '`get_skill`']) {
      expect(text, `an organization's skill took ${fact} away`).toContain(fact)
    }
    expect(text).toContain('Contracts are signed PDFs only.')
  })

  it('comes first, and the skill follows it rather than replacing it', () => {
    const text = instructionsFor({ name: 'nacre-index', description: 'd', files: DEFAULT_SKILL }, body)
    expect(text.startsWith(INSTRUCTIONS)).toBe(true)
    expect(text.indexOf('## Permissions')).toBeLessThan(text.indexOf("## This organization's conventions"))
  })

  it('leaves the server’s mechanics out of the default skill, which is the half an organization replaces', () => {
    // A fact restated in the skill is a fact that reads as the organization's
    // to drop. The skill keeps what to store and how a document is written.
    const skill = DEFAULT_SKILL['SKILL.md'] ?? ''
    for (const mechanic of ['ingest_status', 'request_upload', 'upload_file', 'queued']) {
      expect(skill, `the default skill restates ${mechanic}`).not.toContain(mechanic)
    }
  })
})
