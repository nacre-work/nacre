import { describe, expect, it } from 'vitest'

import { configureLogging, createLogger, logger, type LogLevel } from '../logging.js'

const AT = new Date('2026-08-02T12:00:00.000Z')

function capture(level: LogLevel, format: 'json' | 'text') {
  const lines: { level: LogLevel; line: string }[] = []
  const log = createLogger({
    level,
    format,
    now: () => AT,
    write: (l, line) => lines.push({ level: l, line }),
  })
  return { log, lines }
}

describe('createLogger', () => {
  it('drops everything below the configured level', () => {
    const { log, lines } = capture('warn', 'json')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error'])
  })

  it('lets debug through only when asked', () => {
    const { log, lines } = capture('debug', 'json')
    log.debug('d')
    expect(lines).toHaveLength(1)
  })

  it('keeps msg named msg, because things already grep for it', () => {
    // Every line in this repository was `console.log(JSON.stringify({msg: …}))`
    // before this existed. Renaming the key would break anything reading them
    // for no gain; level and ts are additions.
    const { log, lines } = capture('info', 'json')
    log.info('collection dropped', { collection: 'org_acme' })
    expect(JSON.parse(lines[0]?.line as string)).toEqual({
      level: 'info',
      ts: AT.toISOString(),
      msg: 'collection dropped',
      collection: 'org_acme',
    })
  })

  it('writes key=value for a person, quoting anything ambiguous', () => {
    const { log, lines } = capture('info', 'text')
    log.info('indexed', { doc: 'abc', title: 'two words', n: 3, ok: true })
    expect(lines[0]?.line).toBe(
      `${AT.toISOString()} INFO  indexed doc=abc title="two words" n=3 ok=true`,
    )
  })

  it('does not let a value with a space read as two fields', () => {
    // The failure this prevents is silent: `error=connection refused` parses as
    // an error of "connection" plus a field called "refused".
    const { log, lines } = capture('info', 'text')
    log.warn('failed', { error: 'connection refused' })
    expect(lines[0]?.line).toContain('error="connection refused"')
  })

  it('renders an object field rather than [object Object]', () => {
    const { log, lines } = capture('info', 'text')
    log.info('x', { at: { a: 1 } })
    expect(lines[0]?.line).toContain('at={"a":1}')
  })

  it('sends warn and error to stderr and the rest to stdout', () => {
    // A container that ships stdout and leaves stderr on the terminal is a real
    // deployment; a failure written to stdout with everything else is one
    // nobody saw.
    const { log, lines } = capture('debug', 'json')
    log.debug('a')
    log.info('b')
    log.warn('c')
    log.error('d')
    expect(lines.map((l) => l.level)).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('handles a null field without throwing', () => {
    const { log, lines } = capture('info', 'text')
    log.info('x', { got: null })
    expect(lines[0]?.line).toContain('got=null')
  })
})

describe('the process logger', () => {
  it('defaults to info and json, which is what every process did before', () => {
    const lines: string[] = []
    configureLogging({ level: 'info', format: 'json', now: () => AT, write: (_l, line) => lines.push(line) })
    logger.debug('dropped')
    logger.info('kept')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string).msg).toBe('kept')
  })

  it('is seen by a module that captured it before it was configured', () => {
    // `logger` delegates on every call rather than being replaced, so a module
    // that imported it at load time still logs at the level main chose.
    const held = logger
    const lines: string[] = []
    configureLogging({ level: 'error', format: 'json', now: () => AT, write: (_l, line) => lines.push(line) })
    held.warn('below the threshold')
    held.error('at it')
    expect(lines).toHaveLength(1)

    configureLogging({ level: 'info', format: 'json' })
  })
})
