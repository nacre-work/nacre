import { describe, expect, it } from 'vitest'

import { catalog, onTheWire } from '../tools.js'

/**
 * Every tool says what it does to the world, in MCP's own vocabulary.
 *
 * Without `annotations` a client has to assume the specification's defaults —
 * may modify, may destroy, not idempotent, reaches the open world — for every
 * tool, `search` included. A careful client then confirms every search and a
 * careless one confirms nothing, the delete included. The table in docs/mcp.md
 * is this one; the two are held together here rather than by reading.
 */
const EXPECTED: Record<
  string,
  [readOnly: boolean, destructive: boolean, idempotent: boolean, openWorld: boolean]
> = {
  search: [true, false, true, false],
  list_layers: [true, false, true, false],
  get_document: [true, false, true, false],
  ingest_status: [true, false, true, false],
  ingest_document: [false, true, true, true],
  delete_document: [false, true, true, false],
}

describe('tool annotations', () => {
  const tools = onTheWire(catalog([]))

  it('covers exactly the catalog', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  for (const [name, [readOnly, destructive, idempotent, openWorld]] of Object.entries(EXPECTED)) {
    it(`${name} declares what it does`, () => {
      const tool = tools.find((t) => t.name === name)
      expect(tool?.annotations).toEqual({
        title: tool?.title,
        readOnlyHint: readOnly,
        destructiveHint: destructive,
        idempotentHint: idempotent,
        openWorldHint: openWorld,
      })
      expect(tool?.title.length).toBeGreaterThan(0)
    })
  }

  it('a read-only tool is never destructive, and every destructive one says so in its description', () => {
    for (const tool of tools) {
      if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false)
    }
    expect(tools.find((t) => t.name === 'delete_document')?.description).toMatch(/Destructive/)
  })

  it('puts the annotations on the wire and keeps permission off it', () => {
    for (const tool of tools) {
      expect(tool).toHaveProperty('annotations')
      expect(tool).not.toHaveProperty('permission')
    }
  })
})
