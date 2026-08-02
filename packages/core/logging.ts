/**
 * Logging, at the level and in the format the deployment asked for.
 *
 * `NACRE_LOG_LEVEL` and `NACRE_LOG_FORMAT` were validated at startup and read
 * by nothing: every process wrote structured JSON at one level, so an operator
 * setting `warn` still got every `info` line and one setting `text` still got
 * JSON. Both are among the first variables anyone sets.
 *
 * ─── what does not go through here ───
 *
 * **Configuration errors.** They happen before a configuration exists, so there
 * is nothing to ask about the level, and a process that cannot start must say
 * why whatever anyone configured. Those stay on `console.error`.
 *
 * **`init` and `migrate` output.** Those are commands a person runs and reads —
 * the printed org id, the applied migrations. That is program output, like
 * `--help`, and putting it behind a level would mean `NACRE_LOG_LEVEL=warn`
 * silently swallows the one line the command exists to produce.
 *
 * ─── what a field may hold ───
 *
 * The same rule as everywhere else in this repository: no document contents and
 * no full query text. This module cannot enforce that — it takes what it is
 * given — so it is stated where the fields are named rather than here.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFormat = 'json' | 'text'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface LoggerOptions {
  readonly level: LogLevel
  readonly format: LogFormat
  /** Injected so a test can assert on a line rather than on a moving timestamp. */
  readonly now?: () => Date
  /** Injected for the same reason. Defaults to the console. */
  readonly write?: (level: LogLevel, line: string) => void
}

/**
 * `warn` and `error` to stderr, the rest to stdout.
 *
 * Not a style choice: a container that pipes stdout into a log shipper and
 * leaves stderr on the terminal is a real deployment, and a failure that went
 * to stdout with everything else is a failure nobody saw at 3am.
 */
function toConsole(level: LogLevel, line: string): void {
  if (level === 'warn') console.warn(line)
  else if (level === 'error') console.error(line)
  else console.log(line)
}

/**
 * `key=value`, with anything ambiguous quoted.
 *
 * Text format is for a person reading a terminal, so it is optimised for
 * scanning rather than for parsing — but a value containing a space or a quote
 * still has to survive, or two fields read as one.
 */
function render(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') {
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = ORDER[options.level]
  const now = options.now ?? (() => new Date())
  const write = options.write ?? toConsole

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < threshold) return

    const ts = now().toISOString()
    if (options.format === 'json') {
      // `msg` first and named the same as before, because every existing line
      // was `{"msg": ...}` and anything already grepping for it should keep
      // working. The level and timestamp are additions, not a replacement.
      write(level, JSON.stringify({ level, ts, msg: message, ...fields }))
      return
    }

    const rest = Object.entries(fields ?? {})
      .map(([key, value]) => ` ${key}=${render(value)}`)
      .join('')
    write(level, `${ts} ${level.toUpperCase().padEnd(5)} ${message}${rest}`)
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  }
}

/**
 * The process-wide logger.
 *
 * A module-level default that `configureLogging` replaces once the
 * configuration is read. Deliberately the one piece of global state in this
 * repository, and it is safe to be: it carries no authorization semantics, the
 * worst a wrong one does is print at the wrong level, and the alternative —
 * threading a logger through every adapter and port — buys nothing a reader of
 * those signatures would want.
 *
 * The default is `info`/`json`, so a module that logs before `configureLogging`
 * runs behaves exactly as the whole system did before this existed.
 */
let current: Logger = createLogger({ level: 'info', format: 'json' })

export function configureLogging(options: LoggerOptions): void {
  current = createLogger(options)
}

/** Delegates on every call, so a module may hold this and still see the change. */
export const logger: Logger = {
  debug: (m, f) => current.debug(m, f),
  info: (m, f) => current.info(m, f),
  warn: (m, f) => current.warn(m, f),
  error: (m, f) => current.error(m, f),
}
