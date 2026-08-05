#!/usr/bin/env node
import {
  configureLogging,
  ConfigError,
  loadConfig,
  loadModules,
  loadJwtVerification,
  logger,
} from '@nacre.work/core'

import { buildServices } from './services.js'
import { serveStdio } from './stdio.js'
import { packageVersion } from './version.js'

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

  // Every line to stderr, including the ones that are `info` everywhere else.
  //
  // stdout carries the protocol and nothing else. The default writer sends
  // info and debug to stdout, which is correct for a server whose stdout is a
  // log stream and would put a log line in the middle of a JSON-RPC frame
  // here — the client then fails to parse a message it never asked for. This
  // is the same rule `stdio.ts` states for its own diagnostics, applied to the
  // logger that arrived after it.
  configureLogging({
    level: config.logLevel,
    format: config.logFormat,
    write: (_level, line) => process.stderr.write(`${line}\n`),
  })

  // After the logger is pointed at stderr, which matters more here than
  // anywhere else: a module that logs on import would otherwise put a line in
  // the middle of a JSON-RPC frame. This transport answers through the same
  // authorization service as the other two, so it loads the same modules —
  // dropping them here would be one surface deciding access differently.
  await loadModules(config.modules)

  const jwt = loadJwtVerification()

  const serviceKey = process.env.NACRE_SERVICE_KEY
  if (serviceKey === undefined || serviceKey.length === 0) {
    throw new ConfigError([
      'NACRE_SERVICE_KEY is not set. Local mode carries exactly one service ' +
        "account's permissions, so there is nobody to be without it.",
    ])
  }

  const { pool, layers, tools, serviceKeys } = buildServices(config)

  try {
    await serveStdio({
      // Both credential types work here. A service account key is the one
      // meant to outlive a session — a token from `init` expires in an hour,
      // which is not a credential for an agent that runs for a week.
      verify: {
        key: jwt.verification,
        ...(jwt.alsoAccept.length === 0 ? {} : { alsoAccept: jwt.alsoAccept }),
        algorithms: [jwt.algorithm],
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
        serviceKeys,
      },
      serviceKey,
      layers,
      tools,
      serverVersion: packageVersion(),
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
  // Through the logger, which is already pointed at stderr — and still stderr
  // if the failure happened before it was configured, because `error` goes
  // there by default.
  logger.error('failed to start', { error: String(error) })
  process.exit(1)
})
