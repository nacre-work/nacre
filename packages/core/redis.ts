import { connect, type Socket } from 'node:net'
import { once } from 'node:events'

/**
 * A very small Redis client.
 *
 * Written rather than installed, for the same reason `metrics.ts` was: the
 * commands needed here are five, RESP2 is a text protocol that fits on a page,
 * and a dependency in a self-hosted security product is something every
 * operator inherits. The alternative was pulling a client with its own
 * transitive tree to run `INCR`.
 *
 * `NACRE_REDIS_URL` has been required configuration and Redis has been in every
 * Compose profile — with the API waiting on its healthcheck — since before
 * anything connected to it. That is what this closes: a service every
 * deployment had to run, for nothing.
 *
 * Not a general-purpose client. No pub/sub, no cluster, no pipelining beyond
 * what the callers here need, no reconnect backoff worth the name. When
 * something needs more than this, replace it rather than growing it.
 */

export interface RedisOptions {
  readonly url: string
  /** How long to wait for a reply before giving up on the connection. */
  readonly timeoutMs?: number
}

type Reply = string | number | null | Reply[]

const CRLF = '\r\n'

/** RESP2 is length-prefixed, so a command is its parts with their byte lengths. */
function encode(parts: readonly string[]): string {
  let out = `*${parts.length}${CRLF}`
  for (const p of parts) out += `$${Buffer.byteLength(p)}${CRLF}${p}${CRLF}`
  return out
}

export class RedisError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RedisError'
  }
}

export class Redis {
  readonly #url: URL
  readonly #timeoutMs: number

  #socket: Socket | undefined
  #buffer = Buffer.alloc(0)
  /** One resolver per in-flight command, in the order they were sent. */
  #pending: { resolve: (v: Reply) => void; reject: (e: unknown) => void }[] = []
  #connecting: Promise<void> | undefined

  constructor(options: RedisOptions) {
    this.#url = new URL(options.url)
    this.#timeoutMs = options.timeoutMs ?? 2000
  }

  async #connectOnce(): Promise<void> {
    const socket = connect({
      host: this.#url.hostname,
      port: Number(this.#url.port || 6379),
    })
    socket.setNoDelay(true)

    socket.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#drain()
    })

    const fail = (cause: unknown) => {
      // Everything in flight is lost with the connection. Rejecting rather than
      // hanging is what lets the callers fall back on their own terms.
      const pending = this.#pending
      this.#pending = []
      this.#socket = undefined
      this.#buffer = Buffer.alloc(0)
      for (const p of pending) p.reject(new RedisError('the redis connection closed', { cause }))
    }
    socket.on('error', fail)
    socket.on('close', () => fail(undefined))

    await once(socket, 'connect')
    this.#socket = socket

    // Auth and database come from the URL, so a deployment configures them in
    // one place rather than in three.
    const password = decodeURIComponent(this.#url.password)
    const username = decodeURIComponent(this.#url.username)
    if (password !== '') {
      await this.#send(username === '' ? ['AUTH', password] : ['AUTH', username, password])
    }
    const db = this.#url.pathname.replace(/^\//, '')
    if (db !== '' && db !== '0') await this.#send(['SELECT', db])
  }

  async #ensure(): Promise<void> {
    if (this.#socket !== undefined) return
    // One connect attempt shared by every caller that arrives while it runs.
    this.#connecting ??= this.#connectOnce().finally(() => {
      this.#connecting = undefined
    })
    await this.#connecting
  }

  /**
   * Parse whatever complete replies are in the buffer and hand them to the
   * waiting callers, in order. RESP2 answers in the order it was asked, which
   * is what makes a queue of resolvers correct without request ids.
   */
  #drain(): void {
    for (;;) {
      const parsed = parse(this.#buffer, 0)
      if (parsed === undefined) return
      this.#buffer = this.#buffer.subarray(parsed.next)

      const waiter = this.#pending.shift()
      if (waiter === undefined) continue
      if (parsed.error !== undefined) waiter.reject(new RedisError(parsed.error))
      else waiter.resolve(parsed.value)
    }
  }

  #send(parts: readonly string[]): Promise<Reply> {
    const socket = this.#socket
    if (socket === undefined) return Promise.reject(new RedisError('not connected'))

    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RedisError(`redis did not answer ${parts[0]} within ${this.#timeoutMs}ms`))
      }, this.#timeoutMs)

      this.#pending.push({
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      socket.write(encode(parts))
    })
  }

  /** One command. Reconnects once if the connection went away between calls. */
  async command(...parts: string[]): Promise<Reply> {
    await this.#ensure()
    try {
      return await this.#send(parts)
    } catch (error) {
      if (!(error instanceof RedisError) || this.#socket !== undefined) throw error
      await this.#ensure()
      return this.#send(parts)
    }
  }

  /**
   * Several commands written together, answered in order.
   *
   * Not a transaction — no MULTI. The callers here want one round trip, not
   * atomicity across commands, and saying so is better than implying more.
   */
  async pipeline(...commands: readonly (readonly string[])[]): Promise<Reply[]> {
    await this.#ensure()
    const socket = this.#socket
    if (socket === undefined) throw new RedisError('not connected')

    const replies = commands.map(
      (parts) =>
        new Promise<Reply>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new RedisError(`redis did not answer ${parts[0]} in time`)),
            this.#timeoutMs,
          )
          this.#pending.push({
            resolve: (v) => {
              clearTimeout(timer)
              resolve(v)
            },
            reject: (e) => {
              clearTimeout(timer)
              reject(e)
            },
          })
        }),
    )

    socket.write(commands.map(encode).join(''))
    return Promise.all(replies)
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.command('PING')) === 'PONG'
    } catch {
      return false
    }
  }

  close(): void {
    this.#socket?.destroy()
    this.#socket = undefined
  }
}

interface Parsed {
  readonly value: Reply
  readonly next: number
  readonly error?: string
}

/** One RESP2 value, or undefined when the buffer does not hold a whole one. */
function parse(buffer: Buffer, at: number): Parsed | undefined {
  if (at >= buffer.length) return undefined

  const end = buffer.indexOf('\r\n', at)
  if (end === -1) return undefined

  const kind = String.fromCharCode(buffer[at] as number)
  const body = buffer.toString('utf8', at + 1, end)
  const after = end + 2

  switch (kind) {
    case '+':
      return { value: body, next: after }
    case '-':
      return { value: null, next: after, error: body }
    case ':':
      return { value: Number(body), next: after }
    case '$': {
      const length = Number(body)
      if (length === -1) return { value: null, next: after }
      const stop = after + length
      if (buffer.length < stop + 2) return undefined
      return { value: buffer.toString('utf8', after, stop), next: stop + 2 }
    }
    case '*': {
      const count = Number(body)
      if (count === -1) return { value: null, next: after }
      const items: Reply[] = []
      let cursor = after
      for (let i = 0; i < count; i++) {
        const item = parse(buffer, cursor)
        if (item === undefined) return undefined
        // An error inside an array belongs to that element; the callers here
        // never send commands that can produce one, so it becomes a null.
        items.push(item.error === undefined ? item.value : null)
        cursor = item.next
      }
      return { value: items, next: cursor }
    }
    default:
      return { value: null, next: after, error: `unrecognised reply type ${kind}` }
  }
}
