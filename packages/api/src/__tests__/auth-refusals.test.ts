import { createSecretKey } from 'node:crypto'

import { configureLogging } from '@nacre.work/core'
import { SignJWT } from 'jose'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { authenticate, type Delegations, type VerifyOptions } from '../auth.js'
import { Problem } from '../errors.js'

/**
 * A 401 says the same thing to everybody and tells the operator why.
 *
 * Two properties that pull in opposite directions, which is why they are
 * asserted together in one file rather than assumed apart.
 *
 * **The response is one answer.** Invariant 4's argument applied to
 * credentials: distinguishing "expired" from "wrong audience" from "the
 * connection was forgotten" in the body tells whoever is guessing which guess
 * was closest. Every refusal below has to produce a byte-identical problem
 * document, and the log must not become a reason to relax that.
 *
 * **The log is not one answer.** Before this, a refusal left nothing: no audit
 * event, no distinguishable message, and a metric counting what was presented
 * rather than why it failed. An operator whose agent stopped working had
 * exactly one observable — a 401 — which is the wrong amount of information for
 * the person who runs the server, as opposed to the person holding the token.
 *
 * And the credential is never in it. A log is a place secrets get copied out
 * of, and the last assertion here is the one that would matter most if it ever
 * failed.
 */

const KEY = createSecretKey(Buffer.from('a'.repeat(48)))
const OTHER_KEY = createSecretKey(Buffer.from('b'.repeat(48)))
const ISSUER = 'https://nacre.test'
const AUDIENCE = 'https://nacre.test'
const ORG = '11111111-1111-1111-1111-111111111111'
const USER = '22222222-2222-2222-2222-222222222222'
const OTHER_USER = '44444444-4444-4444-4444-444444444444'
const DEL = '33333333-3333-3333-3333-333333333333'

interface Line {
  readonly level: string
  readonly json: Record<string, unknown>
}

let lines: Line[] = []

// `write` is the seam the logger already offers a test, and `debug` because
// half these reasons are deliberately logged there — a scanner can produce them
// at will and a log that floods is one somebody turns off.
configureLogging({
  level: 'debug',
  format: 'json',
  write: (level, line) => {
    lines.push({ level, json: JSON.parse(line) as Record<string, unknown> })
  },
})

afterAll(() => {
  configureLogging({ level: 'info', format: 'json' })
})

beforeEach(() => {
  lines = []
})

const sign = async (
  claims: Record<string, unknown>,
  sub: string,
  key: Parameters<typeof SignJWT.prototype.sign>[0] = KEY,
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(key)
}

const delegations = (answer: Awaited<ReturnType<Delegations['resolve']>>): Delegations => ({
  resolve: () => Promise.resolve(answer),
})

const options = (extra: Partial<VerifyOptions> = {}): VerifyOptions => ({
  key: KEY,
  issuer: ISSUER,
  audience: AUDIENCE,
  ...extra,
})

/** The reason the one line carries, and a failure that says so when there is none. */
const reasonOf = (): unknown => {
  const refusals = lines.filter((l) => l.json.msg === 'authentication refused')
  expect(refusals).toHaveLength(1)
  return refusals[0]?.json.reason
}

describe('a refusal is one answer out and a named reason in the log', () => {
  /**
   * Every refusal this file can reach, as (name, token, options).
   *
   * A table because the property is about the *set*: a new refusal added
   * without a row here still has to produce the same document as the others,
   * and the way that gets noticed is somebody adding the row.
   */
  const cases: readonly {
    name: string
    reason: string
    token: () => Promise<string | undefined>
    options: () => VerifyOptions
  }[] = [
    {
      name: 'no credential at all',
      reason: 'no_bearer',
      token: () => Promise.resolve(undefined),
      options: () => options(),
    },
    {
      name: 'a service account key where nothing resolves one',
      reason: 'service_keys_unavailable',
      token: () => Promise.resolve('nacre_sk_whatever'),
      options: () => options(),
    },
    {
      name: 'a service account key that does not resolve',
      reason: 'service_key_rejected',
      token: () => Promise.resolve('nacre_sk_whatever'),
      options: () => options({ serviceKeys: { resolve: () => Promise.resolve(undefined) } }),
    },
    {
      name: 'a token signed with another key',
      reason: 'unverifiable',
      token: () => sign({ org: ORG, principal_type: 'user', role: 'member' }, USER, OTHER_KEY),
      options: () => options(),
    },
    {
      name: 'a token that verifies and says nothing about who it is',
      reason: 'claims_incomplete',
      token: () => sign({ principal_type: 'user', role: 'member' }, USER),
      options: () => options(),
    },
    {
      name: 'a delegation claim that is not a string',
      reason: 'delegation_claim_malformed',
      token: () => sign({ org: ORG, principal_type: 'user', role: 'member', del: 7 }, USER),
      options: () => options({ delegations: delegations(undefined) }),
    },
    {
      name: 'a delegated token where nothing can check the connection',
      reason: 'delegations_unavailable',
      token: () => sign({ org: ORG, principal_type: 'user', role: 'member', del: DEL }, USER),
      options: () => options(),
    },
    {
      name: 'a connection that no longer resolves',
      reason: 'delegation_unresolved',
      token: () => sign({ org: ORG, principal_type: 'user', role: 'member', del: DEL }, USER),
      options: () => options({ delegations: delegations(undefined) }),
    },
    {
      name: 'a token and a connection naming different people',
      reason: 'delegation_subject_mismatch',
      token: () => sign({ org: ORG, principal_type: 'user', role: 'member', del: DEL }, USER),
      options: () =>
        options({ delegations: delegations({ userId: OTHER_USER, role: 'member' }) }),
    },
  ]

  for (const c of cases) {
    it(`${c.name} — logs ${c.reason}`, async () => {
      const token = await c.token()
      const refused = await authenticate(
        token === undefined ? undefined : `Bearer ${token}`,
        c.options(),
        '/v1/search',
        'req-1',
      )

      expect(refused).toBeInstanceOf(Problem)
      expect((refused as Problem).status).toBe(401)
      expect(reasonOf()).toBe(c.reason)

      const line = lines.find((l) => l.json.msg === 'authentication refused')
      expect(line?.json.request_id).toBe('req-1')
      expect(line?.json.instance).toBe('/v1/search')

      // The one that would matter most if it ever failed. A bearer token in a
      // log is a bearer token in every downstream that ships logs.
      if (token !== undefined) {
        expect(JSON.stringify(lines)).not.toContain(token)
      }
    })
  }

  it('answers the same document whatever the reason', async () => {
    const bodies = new Set<string>()
    for (const c of cases) {
      const token = await c.token()
      const refused = await authenticate(
        token === undefined ? undefined : `Bearer ${token}`,
        c.options(),
        '/v1/search',
        'req-1',
      )
      bodies.add(JSON.stringify((refused as Problem).toJSON()))
    }

    // One entry, and the two that are allowed to differ are allowed to because
    // "a bearer token is required" is addressed to a caller that presented
    // none — it distinguishes nothing about a credential, because there was
    // not one.
    expect(bodies.size).toBe(2)
    expect([...bodies].filter((b) => b.includes('A bearer token is required.'))).toHaveLength(1)
    expect([...bodies].filter((b) => b.includes('The token is not valid.'))).toHaveLength(1)
  })

  it('says nothing at all when the credential is good', async () => {
    const token = await sign({ org: ORG, principal_type: 'user', role: 'member' }, USER)
    const auth = await authenticate(`Bearer ${token}`, options(), '/v1/search', 'req-1')

    expect(auth).not.toBeInstanceOf(Problem)
    expect(lines.filter((l) => l.json.msg === 'authentication refused')).toHaveLength(0)
  })

  /**
   * The split that keeps the log readable, asserted rather than left to a
   * comment: anything an anonymous caller can produce at will is `debug`, and
   * everything reachable only with a token this deployment signed is `info`.
   */
  it('logs the floodable reasons quietly and the rest where an operator looks', async () => {
    const quiet = new Set(['no_bearer', 'unverifiable'])
    for (const c of cases) {
      lines = []
      const token = await c.token()
      await authenticate(
        token === undefined ? undefined : `Bearer ${token}`,
        c.options(),
        '/v1/search',
        'req-1',
      )
      const line = lines.find((l) => l.json.msg === 'authentication refused')
      expect(line?.level, c.reason).toBe(quiet.has(c.reason) ? 'debug' : 'info')
    }
  })
})
