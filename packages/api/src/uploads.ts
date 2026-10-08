import { randomBytes } from 'node:crypto'

import { BINARY_FORMATS, type Redis } from '@nacre.work/core'

import type { AuthContext } from './auth.js'

/**
 * Upload tickets: a document sent to the index without passing through a
 * model's context window.
 *
 * An agent that holds a file cannot put it into `ingest_document`: a tool
 * argument is a JSON string the model has to emit, which is the file retyped
 * through the context window — paid for twice, and for anything a model
 * cannot faithfully reproduce, not the same bytes. So the agent asks for a
 * **ticket** instead, over MCP (`request_upload`) or REST
 * (`POST /v1/uploads`), and whoever actually holds the bytes — a shell with
 * `curl`, an MCP App's file input, a script — sends them to the ticket's URL.
 * The index sees exactly the bytes that were on disk.
 *
 * The ticket is the capability, and that is what every property below is
 * about:
 *
 *   - **It is minted by a caller holding `write` on the layer**, checked at
 *     minting with the same resolve the ingest path makes, and the document is
 *     queued as that caller — the stored `AuthContext` — so the write is
 *     checked *again* when the bytes arrive. A grant revoked in between
 *     refuses the upload, which is invariant I4's "nothing waits for a cache".
 *   - **It is single-use.** `GETDEL` takes it out of the store in the same
 *     command that reads it, so two uploads racing on one ticket produce one
 *     document and one `404`.
 *   - **It expires in five minutes.** Long enough to open a terminal; short
 *     enough that a ticket in a log, a chat transcript or a screenshot is
 *     worth little. The TTL is the store's, not a field a caller sets.
 *   - **It names nothing a stranger can use.** The id is 32 random bytes; the
 *     endpoint that redeems it is the one place in the API that needs no
 *     credential, and it answers `404` for an unknown, spent or expired ticket
 *     alike — the same answer, so a probe learns nothing.
 *   - **It fails closed.** The store is Redis, and a Redis that does not
 *     answer refuses to mint and refuses to redeem. This is against the grain
 *     of the rate limiter beside it, which fails open; the difference is that
 *     this *is* an authorization control — a ticket is a bearer of somebody's
 *     `write` — and "could not check it, let it through" is the path this
 *     repository does not have.
 *
 * The descriptor the mint answers with is shaped after the one the MCP
 * specification's file-transfer proposal (SEP-2631) has a server mint for an
 * upload — `url`, `method`, `headers`, `expiresAt`, `maxSize` — so that when
 * that proposal lands, `files/authorizeUpload` is a second door onto this
 * store rather than a second implementation.
 */

/** Five minutes, and the reason is in the header above. */
export const TICKET_TTL_SECONDS = 300

/** What a ticket remembers: who asked, and what the document will be called. */
export interface UploadTicket {
  readonly auth: AuthContext
  readonly layer: string
  readonly externalId?: string
  readonly title?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  /** Unix seconds. Carried for the descriptor; the store's TTL is what enforces it. */
  readonly expiresAt: number
}

export interface UploadTicketStore {
  /** Store a ticket under a fresh id and return the id. Throws when the store cannot answer. */
  mint(ticket: UploadTicket): Promise<string>
  /** Take a ticket out of the store, or `undefined` when there is none. Throws when the store cannot answer. */
  redeem(id: string): Promise<UploadTicket | undefined>
}

const KEY = 'upload:'

/** The store, over the same Redis the rate limiter and the idempotency cache use. */
export class RedisUploadTickets implements UploadTicketStore {
  constructor(private readonly redis: Redis) {}

  async mint(ticket: UploadTicket): Promise<string> {
    const id = randomBytes(32).toString('base64url')
    // `NX` so a collision — which 256 bits makes a theoretical concern and
    // not a practical one — refuses rather than overwrites somebody else's
    // ticket.
    const reply = await this.redis.command(
      'SET',
      `${KEY}${id}`,
      JSON.stringify(ticket),
      'EX',
      String(TICKET_TTL_SECONDS),
      'NX',
    )
    if (reply !== 'OK') throw new Error('the upload ticket could not be stored')
    return id
  }

  async redeem(id: string): Promise<UploadTicket | undefined> {
    // One command: read and delete. Two would leave a window in which the
    // same ticket is read twice, which is two documents from one capability.
    const reply = await this.redis.command('GETDEL', `${KEY}${id}`)
    if (reply === null || typeof reply !== 'string') return undefined
    return JSON.parse(reply) as UploadTicket
  }
}

/** The descriptor the mint answers with, and the MCP tool hands to the model. */
export interface UploadDescriptor {
  readonly ticket: string
  readonly url: string
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly expires_at: string
  readonly max_size: number
  readonly accepts: readonly string[]
  readonly curl: string
}

/**
 * What a ticket id looks like on the wire, so a path that is not one is a
 * `404` before the store is asked.
 */
export const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/

/**
 * The descriptor, built from the ticket and the base the deployment is
 * reachable at.
 *
 * `curl` is the same request as a shell command, because the model that
 * receives this descriptor hands it to a person or to a shell tool, and a
 * line that can be pasted is the difference between an upload and a question.
 * `--data-binary @file` sends the file as it is on disk — `-d` would strip
 * newlines — and `--fail` turns a refusal into an exit code a script can read.
 */
export function uploadDescriptor(
  ticket: string,
  expiresAt: number,
  baseUrl: string,
  maxBytes: number,
): UploadDescriptor {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/uploads/${ticket}`
  return {
    ticket,
    url,
    method: 'POST',
    headers: { 'content-type': '<the file’s media type>' },
    expires_at: new Date(expiresAt * 1000).toISOString(),
    max_size: maxBytes,
    accepts: ['text/plain', 'text/markdown', ...BINARY_FORMATS.map((f) => f.contentType)],
    curl: `curl --fail --data-binary @FILE -H 'content-type: TYPE' '${url}'`,
  }
}
