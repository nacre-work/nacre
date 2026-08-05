/**
 * The authorization server, and the one decision that makes it ours.
 *
 * A consent screen normally mints a token that acts **as the person who signed
 * in**. That is the wrong answer for this product, and not by a little: an
 * agent here is a principal of its own with its own grants, and "what may this
 * agent read" is a different question from "what may you read". Handing an
 * agent your authority collapses the two and throws away the thing the
 * permission model is for.
 *
 * So the code issued by this flow is exchanged for a token bound to a
 * **service account**, and the consent screen is where a person chooses or
 * creates one. The person authenticates; the agent is authorized. Revoking the
 * agent does not touch the person, and revoking the person does not silently
 * widen the agent.
 *
 * This is also why `authorization_servers` in the RFC 9728 document was
 * previously empty and is now allowed to name us. That earlier position was
 * right for what existed then — pointing a client at a token endpoint that did
 * not exist would have been a dead end one redirect further along — and it
 * changes here because the endpoint exists, not because the argument was wrong.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** RFC 8414. The document a client reads to find the two endpoints. */
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server'

export const AUTHORIZE_PATH = '/oauth/authorize'
export const TOKEN_PATH = '/oauth/token'
export const REGISTER_PATH = '/oauth/register'

/**
 * Where `/oauth/authorize` sends the browser, with the request in the fragment.
 *
 * A fragment rather than a query because a fragment is not sent to a server:
 * the parameters do not end up in the admin origin's access log on the way
 * past.
 *
 * The rule this function exists to hold is that the consent URL's fragment is
 * **a route**, not empty space. The admin UI is hash-routed and
 * `NACRE_OAUTH_CONSENT_URL` ends in `#/consent`; assigning `hash` replaced that,
 * so the browser arrived at `#client_id=…` with no route in it and the router
 * fell through to the default view — the whole request intact, on a page with
 * no way to approve it. The consent screen's parser reads `#/consent?…` and
 * strips the route before the parameters, which is exactly what this produces.
 *
 * The two halves were each written to a different assumption and nothing put
 * them side by side; the flow had never been run end to end.
 */
export function consentRedirect(consentUrl: string, request: URLSearchParams): string {
  const at = new URL(consentUrl)
  const route = at.hash.replace(/^#/, '').replace(/\?+$/, '')
  at.hash = route === '' ? request.toString() : `${route}?${request.toString()}`
  return at.toString()
}

/**
 * How long a code is worth anything.
 *
 * Ninety seconds. The exchange happens within a second of the redirect, and a
 * code is a bearer capability whose only job is to survive one hop through a
 * browser; the window exists for a slow network, not for a slow human.
 */
export const CODE_TTL_MS = 90_000

export interface AuthorizationServerMetadata {
  readonly issuer: string
  readonly authorization_endpoint: string
  readonly token_endpoint: string
  readonly registration_endpoint: string
  readonly response_types_supported: readonly string[]
  readonly grant_types_supported: readonly string[]
  readonly code_challenge_methods_supported: readonly string[]
  readonly token_endpoint_auth_methods_supported: readonly string[]
  readonly scopes_supported: readonly string[]
}

export function authorizationServerMetadata(issuer: string): AuthorizationServerMetadata {
  const at = issuer.replace(/\/+$/, '')
  return {
    issuer: at,
    authorization_endpoint: `${at}${AUTHORIZE_PATH}`,
    token_endpoint: `${at}${TOKEN_PATH}`,
    registration_endpoint: `${at}${REGISTER_PATH}`,
    response_types_supported: ['code'],
    // No implicit, no password, no client_credentials. Each of the three is a
    // way to get a token without the consent screen, and the consent screen is
    // where the service account is chosen — which is the entire mechanism.
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only. `plain` is in RFC 7636 and defeats the point of it: the
    // verifier travels in the clear and an attacker who has the code has the
    // challenge too.
    code_challenge_methods_supported: ['S256'],
    // Public clients only. An MCP client is a desktop application and cannot
    // keep a secret, so issuing one would be theatre — PKCE is what actually
    // binds the exchange to the client that started it.
    token_endpoint_auth_methods_supported: ['none'],
    // Empty for the same reason the resource metadata's is: this product does
    // not scope tokens. Permission is computed per call from the grant graph,
    // so a token carries an organization and a principal and never a list of
    // what it may reach.
    scopes_supported: [],
  }
}

/** A code, and the hash that is all the database ever sees. */
export function generateCode(): string {
  return `nacre_ac_${randomBytes(32).toString('base64url')}`
}

export const hashCode = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex')

/**
 * PKCE S256: does this verifier produce that challenge?
 *
 * Constant-time, and length-checked first because `timingSafeEqual` throws on a
 * length mismatch rather than answering false — which would turn a wrong-length
 * verifier into a 500 and a right-length one into a comparison.
 */
export function verifierMatches(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier, 'utf8').digest('base64url')
  const a = Buffer.from(computed, 'utf8')
  const b = Buffer.from(challenge, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Whether a redirect URI may receive an authorization code.
 *
 * Exact string comparison against what the client registered, and no
 * normalisation beyond that: every relaxation here — a trailing slash, a
 * case-insensitive host, a prefix match — is a way to deliver a code somewhere
 * the client did not register.
 *
 * `http` is permitted **only** on loopback, which is what RFC 8252 says for a
 * native application and is exactly the MCP client case: the client listens on
 * `http://127.0.0.1:<port>/callback`. Anything else must be `https`, because a
 * code delivered over plain HTTP to a routable address is a code on the wire.
 */
export function redirectAllowed(uri: string, registered: readonly string[]): boolean {
  if (!registered.includes(uri)) return false
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol !== 'http:') return false
  return parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === 'localhost'
}

/**
 * The client identifier.
 *
 * Random rather than derived from anything the client sent. A `client_id` a
 * caller can predict is one they can claim, and the display name on the consent
 * screen is self-asserted — so the identifier must not carry it.
 */
export function generateClientId(): string {
  return `nacre_client_${randomBytes(16).toString('base64url')}`
}
