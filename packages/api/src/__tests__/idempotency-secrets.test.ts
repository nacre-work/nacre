import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { carriesCredential, CREDENTIAL_FIELDS } from '../idempotency.js'

/**
 * What the idempotency cache refuses to hold, asked of the contract.
 *
 * The cache used to skip a list of routes, and five routes answering a
 * once-shown value were added after the list was written — nothing told it
 * there were five. It refuses a *body* carrying a credential field now, and
 * this file is what keeps the set of fields honest: every field
 * `docs/openapi.yaml` describes as shown once, never returned again or not
 * recoverable has to be in it, and so does the token pair. A field added to the
 * contract under that description and not to the set fails here, by name.
 */

const OPENAPI = fileURLToPath(new URL('../../../../docs/openapi.yaml', import.meta.url))

/** `name: { …description: '…Returned once…' }` and its spellings, one property per line as the contract writes them. */
function onceShownFields(): string[] {
  const found = new Set<string>()
  for (const line of readFileSync(OPENAPI, 'utf8').split('\n')) {
    const m = /^\s+([a-z_]+):\s*\{.*description:\s*['"]?(.*)$/.exec(line)
    if (m === null) continue
    if (/returned once|shown once|only on creation|never returned again|not recoverable|printed once/i.test(m[2] ?? '')) {
      found.add(m[1] as string)
    }
  }
  return [...found]
}

describe('the idempotency cache never holds a credential', () => {
  it('knows every field the contract describes as shown once', () => {
    const fields = onceShownFields()
    // A check with nothing to hold must not report green.
    expect(fields.length).toBeGreaterThanOrEqual(3)
    for (const field of fields) expect([...CREDENTIAL_FIELDS], `${field} is shown once in the contract`).toContain(field)
  })

  it('knows the token pair a session is made of', () => {
    expect(CREDENTIAL_FIELDS.has('access_token')).toBe(true)
    expect(CREDENTIAL_FIELDS.has('refresh_token')).toBe(true)
  })

  it('finds one at any depth, in objects and in arrays', () => {
    expect(carriesCredential({ id: 'u', password: 'p' })).toBe(true)
    expect(carriesCredential({ tokens: { access_token: 'a' } })).toBe(true)
    expect(carriesCredential({ items: [{ id: 'f' }, { recovery_codes: ['x'] }] })).toBe(true)
    expect(carriesCredential({ id: 'g', permission: 'read' })).toBe(false)
    expect(carriesCredential(null)).toBe(false)
    expect(carriesCredential('password')).toBe(false)
  })
})
