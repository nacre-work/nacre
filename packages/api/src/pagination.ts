import { badRequest, type Problem } from './errors.js'

/**
 * Cursor pagination, and never offset.
 *
 * `docs/api.md` forbids offset on two grounds and both are real. It breaks
 * under concurrent inserts — a row added while a client pages through shifts
 * everything after it, so the client sees an item twice or not at all. And it
 * invites enumeration: `?offset=10000` is a question about how much exists,
 * which on a permission-scoped collection is a question the caller has no right
 * to ask.
 *
 * The cursor is a position, not an index. It carries the sort key of the last
 * item returned, so the next page is "everything after this one" — which is
 * stable no matter what was inserted in between, and says nothing about size.
 *
 * ## Opaque, and only just
 *
 * It is base64url of `created_at|id`, which anyone can decode, and that is
 * fine: both values are already in the response they came from. What matters is
 * that it is *treated* as opaque — a client that parses it and constructs its
 * own has built a dependency on a format that is allowed to change, and the
 * signature check below is what tells them so before it becomes their problem.
 *
 * It is not signed. A forged cursor selects a different page of the same
 * caller's own collection, which they could reach by paging anyway; signing it
 * would defend nothing and imply a guarantee that does not exist.
 */

export const MAX_LIMIT = 200
export const DEFAULT_LIMIT = 50

export interface Position {
  /** The sort key of the last item on the previous page. */
  readonly createdAt: string
  /** Tie-breaker, because timestamps collide under a bulk insert. */
  readonly id: string
}

export interface Page {
  readonly limit: number
  readonly after: Position | undefined
}

export function encodeCursor(position: Position): string {
  return Buffer.from(`${position.createdAt}|${position.id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): Position | undefined {
  let decoded: string
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  } catch {
    return undefined
  }

  const at = decoded.lastIndexOf('|')
  if (at === -1) return undefined

  const createdAt = decoded.slice(0, at)
  const id = decoded.slice(at + 1)
  // A cursor that does not carry a timestamp and an identifier is not one this
  // API issued, whatever it decodes to.
  //
  // A uuid **or** a run of digits: every paged collection here is keyed by uuid
  // except `audit_events`, whose primary key is a bigserial — an audit log is
  // append-only and strictly ordered, and a sequence says so in a way a random
  // uuid does not.
  //
  // Widening the format does not weaken anything, and it is worth saying why
  // rather than leaving the next reader to work it out. The cursor is not a
  // security boundary: it is not signed, it is decodable by anyone, and a
  // forged one selects a different page of the caller's *own* collection —
  // which they could reach by paging. What this check is for is telling a
  // client that built its own cursor that it has taken a dependency on a format
  // allowed to change, before that becomes their problem.
  if (Number.isNaN(Date.parse(createdAt))) return undefined
  if (!/^[0-9a-f-]{36}$/i.test(id) && !/^\d{1,19}$/.test(id)) return undefined

  return { createdAt, id }
}

/**
 * Read `?limit=` and `?cursor=`, or explain what is wrong with them.
 *
 * `?offset=` is refused rather than ignored. Ignoring it gives a client the
 * first page over and over while they believe they are paging, which is the
 * failure that takes an afternoon to see.
 */
export function readPage(
  params: URLSearchParams,
  instance: string,
  requestId: string,
): Page | Problem {
  if (params.has('offset')) {
    return badRequest(
      instance,
      requestId,
      "'offset' is not supported. Use '?cursor=' — offset paging skips and repeats rows " +
        'when the collection changes underneath it.',
    )
  }

  let limit = DEFAULT_LIMIT
  const raw = params.get('limit')
  if (raw !== null) {
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
      return badRequest(instance, requestId, `'limit' must be an integer between 1 and ${MAX_LIMIT}.`)
    }
    limit = value
  }

  let after: Position | undefined
  const cursor = params.get('cursor')
  if (cursor !== null && cursor !== '') {
    const position = decodeCursor(cursor)
    if (position === undefined) {
      return badRequest(
        instance,
        requestId,
        "'cursor' is not one this API issued. Cursors are opaque — pass back the " +
          '`next_cursor` from the previous page rather than constructing one.',
      )
    }
    after = position
  }

  return { limit, after }
}

/**
 * What a paginated port returns.
 *
 * `items` and the cursor are separate because they are not always derived from
 * the same row. Where a collection is filtered in application code after the
 * database has already applied the cursor — grants are, because who may see one
 * is decided by walking the scope tree — the cursor has to come from the last
 * row **fetched** rather than the last one returned. Taking it from the last
 * returned row would skip everything the filter removed after it.
 *
 * The consequence, which callers have to know: **a page may hold fewer than
 * `limit` items, and an empty page does not mean the end.** `nextCursor` is the
 * only signal that more exist.
 */
export interface PageResult<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

/**
 * The common case: rows come back already filtered, so the cursor is the last
 * one returned and a short page means the collection is exhausted.
 */
export function pageOf<T>(
  rows: readonly T[],
  page: Page | undefined,
  positionOf: (row: T) => Position,
): PageResult<T> {
  if (page === undefined || rows.length < page.limit) return { items: rows, nextCursor: null }
  const last = rows[rows.length - 1]
  return { items: rows, nextCursor: last === undefined ? null : encodeCursor(positionOf(last)) }
}
