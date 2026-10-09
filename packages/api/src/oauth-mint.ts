import { adminAudience } from '@nacre.work/core'
import { SignJWT, type KeyObject } from 'jose'

import type { MintRequest } from './oauth-store.js'

/**
 * The access token the consent flow issues, for whatever the connection acts as.
 *
 * For an **agent**: `principal_type: 'service_account'` and `sub` is the
 * account — the same claims a service account key resolves to, so everything
 * downstream treats this exactly as it treats one and there is no second notion
 * of what an agent is. `role` is `member` because a service account has no
 * organization-wide role: everything it reaches, it reaches by grant.
 *
 * For a **delegation**: `principal_type: 'user'` and `sub` is the person, plus
 * `del` naming the connection. The permitted set is deliberately not in here —
 * a token carrying one would keep answering with the access its holder had at
 * consent, and every revocation would wait for it to expire. `role` is carried
 * for shape and is **not** what the request runs as: `authenticate` takes the
 * role from the connection's row, so a demotion applies without waiting for the
 * token to expire.
 *
 * **The audience is the connection's.** A connection approved on the
 * administrative MCP's screen mints `adminAudience(audience)`, which the API
 * and `/mcp` refuse because they compare audiences exactly, and which
 * `/mcp/admin` accepts and nothing else. Read from the connection on the first
 * exchange and on every renewal, so a renewal cannot turn one kind of token
 * into the other. docs/mcp-admin.md.
 *
 * Its own module so that the process issuing tokens and the suite holding the
 * rule call the same function: a copy of this in a test would be a test of the
 * copy.
 */
export function oauthMinter(input: {
  readonly issuer: string
  readonly audience: string
  readonly ttlSeconds: number
  readonly signing: KeyObject | Uint8Array
  readonly algorithm: string
  readonly keyId?: string
}): (approved: MintRequest) => Promise<{ accessToken: string; expiresIn: number }> {
  return async (approved) => {
    const now = Math.floor(Date.now() / 1000)
    const delegated = approved.subject.actsAs === 'user'
    const administrative = 'surface' in approved && approved.surface === 'admin'
    const accessToken = await new SignJWT({
      org: approved.orgId,
      principal_type: delegated ? 'user' : 'service_account',
      role: 'member',
      ...(delegated ? { del: approved.consentId } : {}),
    })
      .setProtectedHeader({ alg: input.algorithm, ...(input.keyId === undefined ? {} : { kid: input.keyId }) })
      .setSubject(approved.subject.actsAs === 'user' ? approved.subject.userId : approved.subject.serviceAccountId)
      .setIssuer(input.issuer)
      .setAudience(administrative ? adminAudience(input.audience) : input.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + input.ttlSeconds)
      .sign(input.signing)
    return { accessToken, expiresIn: input.ttlSeconds }
  }
}
