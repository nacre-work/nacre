import { ConfigError, loadConfig } from '@nacre.work/core'

import { buildServices, jwtKey } from './services.js'
import { serveStdio } from './stdio.js'

/**
 * `npx @nacre.work/mcp` — the local transport.
 *
 * Its own entry point rather than a flag on the HTTP one, because the two
 * differ in what they must never do. This process may not write anything to
 * stdout except protocol frames, and the HTTP server logs there on purpose.
 * One file that does both would eventually log a line in the wrong mode and
 * corrupt a client's message stream for reasons nobody could see.
 */

async function main(): Promise<void> {
  const config = loadConfig()
  const key = jwtKey()

  const serviceKey = process.env.NACRE_SERVICE_KEY
  if (serviceKey === undefined || serviceKey.length === 0) {
    throw new ConfigError([
      'NACRE_SERVICE_KEY is not set. Local mode carries exactly one service ' +
        "account's permissions, so there is nobody to be without it.",
    ])
  }

  const { pool, layers, tools } = buildServices(config)

  try {
    await serveStdio({
      verify: { key, issuer: config.jwtIssuer, audience: config.jwtAudience },
      serviceKey,
      layers,
      tools,
    })
  } finally {
    // stdin closed: the client is gone. Releasing the pool here rather than on
    // a signal means a client that exits without one does not leave a
    // connection held open against the operator's database.
    await pool.end()
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  process.stderr.write(`${JSON.stringify({ msg: 'failed to start', error: String(error) })}\n`)
  process.exit(1)
})
