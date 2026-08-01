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
