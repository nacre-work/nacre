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
 * So `authorization_servers` is **absent unless an operator names one**. The
 * field is optional in RFC 9728, and an installation that has not put an
 * identity provider in front of Nacre has no authorization server to name.
 * Pointing the field at ourselves would be the same lie the 404 was, one
 * redirect further along: a client would fetch our metadata, learn we are our
 * own issuer, ask us for a token endpoint, and find nothing again.
 *
 * What the document is still worth without that field is the part clients
 * actually need first: the canonical resource identifier every token must be
 * audience-bound to, and where to read about the credential that does work
 * today.
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
