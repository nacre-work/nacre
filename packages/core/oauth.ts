/**
 * Protected resource metadata — RFC 9728.
 *
 * Every `401` from the MCP transport carries
 * `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`,
 * and for as long as that header existed nothing served the path it named. A
 * client doing exactly what the header told it to got a `404`, which is the
 * same failure as a search parameter read by nothing: the server described a
 * capability and did not have it.
 *
 * ## This is a resource server, not an authorization server
 *
 * `docs/mcp.md` says so and the code agrees: tokens are verified locally
 * against a key, and nothing here issues one through an OAuth flow.
 * `/v1/auth/login` is email and password, and a service account key is a random
 * string matched against a hash — neither is an OAuth grant.
 *
 * `authorization_servers` names one, and which one is a deployment's choice:
 * an identity provider if it has configured one, and otherwise this
 * installation's own API, which since the consent flow landed *is* an
 * authorization server.
 *
 * This field used to be absent by default, on the argument that pointing a
 * client at a token endpoint that did not exist would be the same dead end the
 * missing document was, one redirect further along. That argument was correct
 * and it is not what changed — the endpoint changed. It exists now, and it
 * mints a token bound to a **service account** rather than to the person who
 * approved it, which is the part worth knowing before reading the flow.
 *
 * A deployment that wants neither sets `NACRE_OAUTH_AUTHORIZATION_SERVER` to
 * its own provider; the field then names that and nothing here is consulted.
 */

export interface ProtectedResourceMetadata {
  readonly resource: string
  readonly authorization_servers?: readonly string[]
  readonly bearer_methods_supported: readonly string[]
  readonly resource_documentation: string
  readonly scopes_supported: readonly string[]
}

/** The path RFC 9728 fixes, and the one the `WWW-Authenticate` header names. */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'

/**
 * Where the public signing key is published — RFC 7517, and the conventional
 * path every JWT library looks at first.
 *
 * Served only by a deployment that signs asymmetrically. With
 * `NACRE_JWT_SECRET` there is nothing to publish and this answers `404`: a
 * shared secret has no public half, and an endpoint that produced one anyway
 * would be handing out the key that mints tokens.
 */
export const JWKS_PATH = '/.well-known/jwks.json'

export function protectedResourceMetadata(input: {
  /** `NACRE_CANONICAL_URL`. Baked into the issuer of every token ever minted. */
  readonly canonicalUrl: string
  /** `NACRE_OAUTH_AUTHORIZATION_SERVER`, when a deployment has one. */
  readonly authorizationServer?: string
}): ProtectedResourceMetadata {
  return {
    // Without a trailing slash, because this is the audience value a token is
    // bound to and `https://api.example.com` and `https://api.example.com/` are
    // different strings to every audience check ever written.
    resource: input.canonicalUrl.replace(/\/+$/, ''),
    ...(input.authorizationServer === undefined
      ? {}
      : { authorization_servers: [input.authorizationServer.replace(/\/+$/, '')] }),
    // Header only. A bearer token in a query string ends up in access logs,
    // proxy logs and browser history, and RFC 6750 has deprecated that form for
    // long enough that offering it is a liability rather than a courtesy.
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/nacre-work/nacre/blob/main/docs/mcp.md',
    // Nacre does not scope tokens. Permission is computed per call against the
    // grant graph, so a token carries an organization and a role and never a
    // list of what it may reach — which is why this is empty rather than
    // inventing names no code reads. See docs/authz.md.
    scopes_supported: [],
  }
}

// ── the administrative MCP ──────────────────────────────────────────────────

/**
 * Where the administrative MCP is served, beside `/mcp` on the same process.
 *
 * A resource of its own — docs/mcp-admin.md — so that `admin` can be on its
 * consent screen without the token reaching REST.
 */
export const ADMIN_MCP_PATH = '/mcp/admin'

/**
 * Its RFC 9728 document. The RFC inserts the well-known segment between the
 * origin and the resource's path, so the document for `…/mcp/admin` lives at
 * `…/.well-known/oauth-protected-resource/mcp/admin` — and a client that is
 * pointed at the administrative endpoint and falls back to the root document
 * would be told the *ordinary* resource, ask for an ordinary token, and be
 * refused here forever. The `401` from `/mcp/admin` names this path, so a
 * client never has to guess.
 */
export const ADMIN_PROTECTED_RESOURCE_PATH = `${PROTECTED_RESOURCE_PATH}${ADMIN_MCP_PATH}`

/**
 * The audience a token for the administrative MCP carries.
 *
 * Derived from the installation's own rather than configured, on the shape the
 * second-factor challenge already uses: one value an operator sets, and every
 * audience that must be refused everywhere else derived from it. The API and
 * `/mcp` compare audiences exactly, so they refuse this one with no code of
 * their own; `/mcp/admin` accepts this one and nothing else.
 */
export const adminAudience = (audience: string): string => `${audience}/admin`

/**
 * Whether an RFC 8707 resource indicator names the administrative MCP.
 *
 * By path rather than by the whole URL, because the MCP origin may be derived
 * from the request a client made rather than pinned, and the API cannot know
 * every name it is reached by. That is not a trust decision: the indicator is
 * the client's to send, and what it buys a client that sends this one is the
 * administrative consent screen — which only an organization administrator can
 * approve, and which says what it is.
 */
export function namesAdminResource(resource: string | undefined): boolean {
  if (resource === undefined) return false
  try {
    return new URL(resource).pathname.replace(/\/+$/, '') === ADMIN_MCP_PATH
  } catch {
    return false
  }
}

/** The administrative MCP's RFC 9728 document: the ordinary one, naming its own resource. */
export function adminResourceMetadata(base: ProtectedResourceMetadata): ProtectedResourceMetadata {
  return {
    ...base,
    resource: `${base.resource}${ADMIN_MCP_PATH}`,
    resource_documentation: 'https://github.com/nacre-work/nacre/blob/main/docs/mcp-admin.md',
  }
}
