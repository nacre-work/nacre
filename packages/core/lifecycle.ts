import { logger } from './logging.js'

/**
 * What every process does when it is asked to stop, and when it is about to
 * die for a reason nobody wrote down.
 *
 * Three processes ship here — api, mcp, worker — and none of them had any of
 * this. The consequences were all of the same shape: a failure that produced no
 * log line, so the operator saw a container restart and had nothing to read.
 *
 * - **No `unhandledRejection` handler.** Node terminates the process on one,
 *   with a raw stack on stderr and no service name, no timestamp in the format
 *   every other line uses, and nothing to join to a request.
 * - **No `error` listener on `listen`.** `EADDRINUSE` is emitted on the server
 *   *after* `main()` has already resolved, so `main().catch` never sees it and
 *   the careful ConfigError path — which exits 2 with an explanation — is
 *   bypassed by the one startup failure an operator hits most.
 * - **No deadline on shutdown.** `server.close()` waits for in-flight requests
 *   with no upper bound. One request blocked on a slow dependency means the
 *   callback never runs, the pool is never released, and the orchestrator
 *   SIGKILLs at the end of its grace period — turning every rolling deploy into
 *   an abrupt one, silently.
 */

export interface Guards {
  /** Named in every line, so two processes in one log stream are tellable apart. */
  readonly service: string
  /**
   * Release what the process holds. Called once, with a deadline.
   *
   * Whatever it does, it must not be the only thing standing between the
   * process and exiting: if it hangs, the deadline below exits anyway.
   */
  readonly shutdown?: () => Promise<void> | void
  /** How long `shutdown` gets. Shorter than any orchestrator's grace period. */
  readonly graceMs?: number
  /** Injected in tests. Nothing else should be replacing this. */
  readonly exit?: (code: number) => void
}

/**
 * Through the process logger, so `NACRE_LOG_FORMAT` reaches these too.
 *
 * The level is a parameter rather than always `error`: a clean shutdown is not
 * a failure, and reporting it as one is how a dashboard counting errors turns
 * every deploy into an incident. What is an error stays an error.
 */
const log = (
  level: 'info' | 'error',
  service: string,
  msg: string,
  extra: Record<string, unknown> = {},
): void => {
  logger[level](msg, { service, ...extra })
}

/**
 * Install the handlers. Returns a `stop` to call from a signal handler.
 *
 * Idempotent: a second SIGTERM while shutting down is ignored rather than
 * starting a second shutdown, because an orchestrator that sends one and then
 * loses patience sends another.
 */
export function installGuards(guards: Guards): { stop: (signal: string) => void } {
  const { service, shutdown, graceMs = 10_000, exit = (code) => process.exit(code) } = guards
  let stopping = false

  process.on('unhandledRejection', (reason) => {
    // Logged and then rethrown by exiting, rather than swallowed. A promise
    // nobody awaited failing means the process is in a state its author did not
    // plan for, and continuing from there is how one bad request becomes a
    // corrupt one.
    log('error', service, 'unhandled rejection; exiting', { error: String(reason).slice(0, 500) })
    exit(1)
  })

  process.on('uncaughtException', (error) => {
    log('error', service, 'uncaught exception; exiting', {
      error: String(error).slice(0, 500),
      stack: error.stack?.split('\n').slice(1, 6).join(' | '),
    })
    exit(1)
  })

  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    log('info', service, 'shutting down', { signal })

    // The deadline runs whatever happens, and `unref` keeps it from being the
    // thing that holds the process open once everything else has let go.
    const deadline = setTimeout(() => {
      log('error', service, 'shutdown did not finish in time; exiting anyway', { grace_ms: graceMs })
      exit(1)
    }, graceMs)
    deadline.unref()

    void (async () => {
      try {
        await shutdown?.()
        clearTimeout(deadline)
        exit(0)
      } catch (error) {
        log('error', service, 'shutdown failed', { error: String(error).slice(0, 500) })
        clearTimeout(deadline)
        exit(1)
      }
    })()
  }

  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  return { stop }
}

/**
 * Fail a `listen` the way every other startup failure fails.
 *
 * `server.listen(port, cb)` reports a bound port through the callback and a
 * refusal through an `error` event — which arrives after `main()` has resolved,
 * so nothing was catching it.
 */
export function onListenError(
  server: { on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown },
  service: string,
  port: number,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  server.on('error', (error) => {
    const detail =
      error.code === 'EADDRINUSE'
        ? `port ${port} is already in use`
        : error.code === 'EACCES'
          ? `port ${port} needs privileges this process does not have`
          : String(error)
    log('error', service, 'could not listen', { port, detail })
    exit(2)
  })
}
