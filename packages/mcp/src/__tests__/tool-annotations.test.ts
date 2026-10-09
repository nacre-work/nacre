import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { catalog, onTheWire } from '../tools.js'

/**
 * Every tool says what it does to the world, in MCP's own vocabulary.
 *
 * Without `annotations` a client has to assume the specification's defaults —
 * may modify, may destroy, not idempotent, reaches the open world — for every
 * tool, `search` included. A careful client then confirms every search and a
 * careless one confirms nothing, the delete included. The table in docs/mcp.md
 * is this one, and the cases at the bottom read it: this comment said so for
 * two releases while nothing did, and the table went two tools behind.
 */
const EXPECTED: Record<
  string,
  [readOnly: boolean, destructive: boolean, idempotent: boolean, openWorld: boolean]
> = {
  search: [true, false, true, false],
  list_layers: [true, false, true, false],
  get_document: [true, false, true, false],
  ingest_status: [true, false, true, false],
  request_upload: [false, false, false, false],
  upload_file: [true, false, true, false],
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

/**
 * The two documents that list the tools, held against the catalog by reading
 * them. `docs/mcp.md` is the specification and `packages/mcp/README.md` is the
 * npm landing page — the second one said "Five tools" while the server served
 * eight, and a reader comparing the two had no way to know which was right.
 */
describe('the documents that list the tools', () => {
  const names = onTheWire(catalog([])).map((t) => t.name).sort()
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

  /** The rows of the first table whose header line contains `marker`. */
  const tableAfter = (text: string, marker: string): string[][] => {
    const lines = text.split('\n')
    const start = lines.findIndex((l) => l.startsWith('|') && l.includes(marker))
    expect(start, `no table headed by ${marker}`).toBeGreaterThanOrEqual(0)
    const rows: string[][] = []
    for (const line of lines.slice(start + 2)) {
      if (!line.startsWith('|')) break
      rows.push(line.split('|').slice(1, -1).map((c) => c.trim()))
    }
    return rows
  }
  const toolsIn = (cell: string): string[] => [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] ?? '')

  it('docs/mcp.md: every tool in the annotation table once, with the values the catalog declares', () => {
    const rows = tableAfter(read('../../../../docs/mcp.md'), '`readOnlyHint`')
    const seen: string[] = []
    for (const [first = '', ...cells] of rows) {
      const values = cells.map((c) => /\btrue\b/.test(c.split(/\s—\s/)[0] ?? ''))
      for (const name of toolsIn(first)) {
        seen.push(name)
        expect(values, `docs/mcp.md row for ${name}`).toEqual(EXPECTED[name])
      }
    }
    expect(seen.sort()).toEqual(names)
  })

  it('packages/mcp/README.md: the table names the catalog, and the count says how many', () => {
    const readme = read('../../README.md')
    const listed = tableAfter(readme, '| | |').flatMap(([first = '']) => toolsIn(first))
    expect(listed.sort()).toEqual(names)
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
    const said = /\b([A-Z][a-z]+) tools\b/.exec(readme)?.[1]?.toLowerCase()
    expect(said, 'the README says "<Number> tools" somewhere').toBeDefined()
    expect(words.indexOf(said ?? '')).toBe(names.length)
  })
})
