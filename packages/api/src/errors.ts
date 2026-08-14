/**
 * RFC 9457 problem details, and the status-code discipline that goes with them.
 *
 * The whole file exists for one distinction. `403` says "this exists and you
 * may not touch it". `404` says nothing at all. Using the first where the
 * caller cannot already see the object turns identifier enumeration into a
 * directory of what exists, which is invariant I6.
 */

export interface ProblemInit {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail: string
  readonly instance: string
  readonly requestId: string
}

export class Problem extends Error {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail: string
  readonly instance: string
  readonly requestId: string

  constructor(init: ProblemInit) {
    super(`${init.status} ${init.title}`)
    this.name = 'Problem'
    this.type = init.type
    this.title = init.title
    this.status = init.status
    this.detail = init.detail
    this.instance = init.instance
    this.requestId = init.requestId
  }

  toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.detail,
      instance: this.instance,
      request_id: this.requestId,
    }
  }
}

const uri = (slug: string) => `https://nacre.work/errors/${slug}`

/**
 * The response for anything the caller may not see.
 *
 * One function, one wording, for both "absent" and "invisible". Two call sites
 * with two different messages is how the distinction leaks back in — the
 * status matching while the body differs is still an oracle.
 */
export function notFound(instance: string, requestId: string): Problem {
  return new Problem({
    type: uri('not-found'),
    title: 'Not found',
    status: 404,
    detail: 'The requested resource does not exist or is not accessible.',
    instance,
    requestId,
  })
}

export function unauthorized(instance: string, requestId: string, detail: string): Problem {
  return new Problem({
    type: uri('unauthorized'),
    title: 'Unauthorized',
    status: 401,
    detail,
    instance,
    requestId,
  })
}

/**
 * Only for an operation refused on an object the caller can already see — and
 * for a request that tries to name its own organization, which is T2.
 */
export function forbidden(instance: string, requestId: string, detail: string): Problem {
  return new Problem({
    type: uri('forbidden'),
    title: 'Forbidden',
    status: 403,
    detail,
    instance,
    requestId,
  })
}

/**
 * The refusal every path under `/v1/users/{id}` gives for a `platform_admin`.
 *
 * `403` and not `404`, which is the narrow case `forbidden` above exists for:
 * the caller is an `org_admin`, `GET /v1/users` lists this person with their
 * role, and the request names an id they just read off it. Invariant 4 is about
 * invisibility and nothing here is invisible — answering `404` would be lying
 * to somebody looking straight at the row.
 *
 * Not `409` either, which is what the last-administrator guard beside it
 * returns. That refusal is about the organization's state and goes away once
 * there is a second administrator; this one never does. No state makes an
 * endpoint scoped to one organization the right place to change a role that
 * spans all of them.
 *
 * One wording for all four spellings — demote, disable, delete, reset the
 * password — because they are one refusal.
 */
export function notAdministeredHere(instance: string, requestId: string): Problem {
  return forbidden(
    instance,
    requestId,
    "This user is a 'platform_admin'. That role administers the installation rather than " +
      'this organization, so it is not issued, revoked, disabled or reset through an endpoint ' +
      'scoped to one — in either direction.',
  )
}

export function badRequest(instance: string, requestId: string, detail: string): Problem {
  return new Problem({
    type: uri('bad-request'),
    title: 'Bad request',
    status: 400,
    detail,
    instance,
    requestId,
  })
}

export function internal(instance: string, requestId: string): Problem {
  return new Problem({
    type: uri('internal'),
    title: 'Internal error',
    status: 500,
    // No cause, no stack, no internal service name. Whatever went wrong is in
    // the journal under this request_id.
    detail: 'The request could not be completed.',
    instance,
    requestId,
  })
}
