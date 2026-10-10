import { describe, expect, it } from 'vitest'

import { parseArgs, USAGE } from '../rebuild-collection.js'

/**
 * The command line of `rebuildOrganizationIndex`. The logic is the core's and is
 * held against a real PostgreSQL and Qdrant in `rebuild-live.test.ts`; what is
 * asked here is that `--replace` reaches it, and only when it is typed — the
 * flag deletes every vector in a collection, so it must never be a default.
 */
describe('rebuild-collection arguments', () => {
  it('rebuilds without replacing unless --replace is typed', () => {
    expect(parseArgs(['--org', 'acme'])).toEqual({ org: 'acme', replace: false })
    expect(parseArgs(['--org', 'acme', '--replace'])).toEqual({ org: 'acme', replace: true })
    expect(parseArgs(['--replace', '--org', 'acme'])).toEqual({ org: 'acme', replace: true })
  })

  it('refuses what it does not know, and an organization that is not named', () => {
    expect(parseArgs(['--org', 'acme', '--force'])).toMatch(/unexpected argument: --force/u)
    expect(parseArgs(['--replace'])).toMatch(/--org <slug> is required/u)
    expect(parseArgs([])).toMatch(/--org <slug> is required/u)
  })

  it('says in its usage what --replace is for', () => {
    expect(USAGE).toMatch(/--replace/u)
    expect(USAGE).toMatch(/restore/u)
  })
})
