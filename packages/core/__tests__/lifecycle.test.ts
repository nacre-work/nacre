import { afterEach, describe, expect, it, vi } from 'vitest'

import { installGuards, onListenError } from '../lifecycle.js'

/**
 * The handlers every process was missing.
 *
 * Each of these was a real failure mode with no log line behind it, which is
 * the part that made them expensive: a container restarted and the operator had
 * nothing to read.
 */

const listeners: [string, (...args: never[]) => void][] = []

/** Registered on the real `process`, so they have to come off again. */
afterEach(() => {
  for (const [event, fn] of listeners.splice(0)) {
    process.removeListener(event, fn as never)
  }
  vi.restoreAllMocks()
})

function capture(): void {
  const on = process.on.bind(process)
  vi.spyOn(process, 'on').mockImplementation((event: string, fn: never) => {
    listeners.push([event, fn])
    return on(event as never, fn)
  })
}

describe('installGuards', () => {
  it('exits, and says so, on an unhandled rejection', async () => {
    capture()
    const exited: number[] = []
    const logged: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: string) => logged.push(line))

    installGuards({ service: 'probe', exit: (c) => exited.push(c) })

    // Node terminates on one of these by default, with a raw stack and no
    // service name — nothing an operator can join to anything else.
    process.emit('unhandledRejection', new Error('nobody awaited me'), Promise.resolve())

    expect(exited).toEqual([1])
    expect(JSON.parse(logged[0] as string)).toMatchObject({
      msg: 'unhandled rejection; exiting',
      service: 'probe',
    })
  })

  it('runs shutdown once, however many signals arrive', async () => {
    capture()
    let ran = 0
    const exited: number[] = []
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { stop } = installGuards({
      service: 'probe',
      exit: (c) => exited.push(c),
      shutdown: () => {
        ran++
      },
    })

    // An orchestrator that sends SIGTERM and then loses patience sends another.
    stop('SIGTERM')
    stop('SIGTERM')
    await new Promise((r) => setTimeout(r, 10))

    expect(ran).toBe(1)
    expect(exited).toEqual([0])
  })

  it('exits anyway when shutdown does not finish in time', async () => {
    capture()
    const exited: number[] = []
    const logged: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: string) => logged.push(line))

    const { stop } = installGuards({
      service: 'probe',
      graceMs: 20,
      exit: (c) => exited.push(c),
      // One request stuck on a slow dependency, which is what `server.close`
      // waiting without a bound actually looks like.
      shutdown: () => new Promise(() => undefined),
    })

    stop('SIGTERM')
    await new Promise((r) => setTimeout(r, 60))

    // Without the deadline the callback never runs, the pool is never released,
    // and the orchestrator SIGKILLs at the end of its grace period — so every
    // rolling deploy is an abrupt one, silently.
    expect(exited).toEqual([1])
    expect(logged.map((l) => JSON.parse(l).msg)).toContain(
      'shutdown did not finish in time; exiting anyway',
    )
  })

  it('reports a failing shutdown rather than exiting clean', async () => {
    capture()
    const exited: number[] = []
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { stop } = installGuards({
      service: 'probe',
      exit: (c) => exited.push(c),
      shutdown: () => Promise.reject(new Error('pool.end failed')),
    })

    stop('SIGTERM')
    await new Promise((r) => setTimeout(r, 10))

    expect(exited).toEqual([1])
  })
})

describe('onListenError', () => {
  it('turns EADDRINUSE into the exit code a configuration error gets', () => {
    const logged: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: string) => logged.push(line))
    const exited: number[] = []

    const handlers: ((error: NodeJS.ErrnoException) => void)[] = []
    const server = { on: (_e: 'error', fn: (error: NodeJS.ErrnoException) => void) => handlers.push(fn) }

    onListenError(server, 'api', 8080, (c) => exited.push(c))

    // It arrives after main() has resolved, so main().catch never saw it: the
    // most common startup failure bypassed the one path that explains itself.
    const error: NodeJS.ErrnoException = new Error('listen EADDRINUSE')
    error.code = 'EADDRINUSE'
    handlers[0]?.(error)

    expect(exited).toEqual([2])
    expect(JSON.parse(logged[0] as string)).toMatchObject({
      msg: 'could not listen',
      port: 8080,
      detail: 'port 8080 is already in use',
    })
  })
})
