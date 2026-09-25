import { describe, expect, it } from 'vitest'

import {
  callToolResult,
  COMPLETE,
  discoverResult,
  pingResult,
  PROTOCOL_VERSION,
  toolsListResult,
} from '../results.js'

/**
 * Every result a 2026-07-28 client can receive carries `resultType`.
 *
 * The revision makes it a MUST, and the "absent means complete" bridge applies
 * only to a server of an earlier revision — which this one is not, since it
 * advertises 2026-07-28 first. `server/discover` carried the field and
 * `tools/call` did not, so a modern client refused every tool result as
 * malformed while `tools/list` and discovery looked healthy: an agent saw the
 * catalog and could call nothing in it.
 *
 * Asked of the builders rather than of one transport, because both dispatchers
 * return what these build — a transport cannot drop the field without a second
 * call site, which the parity suite already refuses.
 */
describe('resultType on every modern-era result', () => {
  it('is required because this server leads with 2026-07-28', () => {
    expect(PROTOCOL_VERSION).toBe('2026-07-28')
  })

  const cases: Array<[string, Record<string, unknown>]> = [
    ['server/discover', discoverResult('0.0.0')],
    ['tools/list', toolsListResult([])],
    ['tools/call', callToolResult({ any: 'value' })],
    ['ping', pingResult()],
  ]

  for (const [method, result] of cases) {
    it(`${method} says complete`, () => {
      expect(result.resultType).toBe(COMPLETE)
    })
  }

  it('leaves the CallToolResult shape intact', () => {
    const result = callToolResult([1, 2])
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify([1, 2], null, 2) }])
  })
})
