import { ConfigError, installGuards, loadConfig, onListenError } from '@nacre.work/core'

import { createMcpServer } from './server.js'
import { buildServices, jwtKey } from './services.js'

/**
 * The MCP process, Streamable HTTP.
 *
 * It shares the API's authorization service rather than reimplementing it. That
 * is the whole point of the boundary in docs/mcp.md: EMA and OAuth authorize
 * the *connection*, and permission on a document is computed per call by the
 * same code the REST surface uses. Two implementations would be two places for
 * rule 6 to drift.
 *
 * The tools themselves live in services.ts, shared with the STDIO transport.
 */

async function main(): Promise<void> {
  const config = loadConfig()
  const key = jwtKey()
  const { pool, layers, tools, serviceKeys } = buildServices(config)

  const server = createMcpServer({
    // serviceKeys is not optional here in practice. An agent connecting over
    // Streamable HTTP is the case this transport exists for, and a service
    // account key is how an agent authenticates; leaving it out made every
    // `nacre_sk_` token 401 on this transport while the same key worked over
    // STDIO and REST — one credential, three surfaces, two of them agreeing.
    verify: { key, issuer: config.jwtIssuer, audience: config.jwtAudience, serviceKeys },
    layers,
    tools,
    // Discovery lives on the API host, never on the apex — static hosting there
    // intercepts /.well-known/* before the API sees it.
    resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource', config.canonicalUrl).toString(),
  })

  const port = Number(process.env.PORT ?? 8081)
  server.listen(port, () => {
    console.log(JSON.stringify({ msg: 'mcp listening', port, env: config.env }))
  })

  onListenError(server, 'mcp', port)

  installGuards({
    service: 'mcp',
    shutdown: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await pool.end()
    },
  })
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message)
    process.exit(2)
  }
  console.error(JSON.stringify({ msg: 'failed to start', error: String(error) }))
  process.exit(1)
})
