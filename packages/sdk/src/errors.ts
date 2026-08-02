/**
 * Errors, shaped by the API's error contract rather than by HTTP.
 *
 * `docs/api.md`: every failure is `application/problem+json` (RFC 9457) with a
 * `request_id` that matches the audit log. That correspondence is the only
 * thing that makes an auditor's question answerable, so it is a field on the
 * error rather than something to dig out of a body.
 */

export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail: string
  readonly instance: string
  readonly request_id: string
}

export class NacreError extends Error {
  readonly status: number
  /** The stable error identifier, e.g. `https://nacre.work/errors/not-found`. */
  readonly type: string
  readonly title: string
  readonly detail: string
  readonly instance: string
  /**
   * Matches `request_id` in the audit log and in the server's own logs. It is
   * the first thing to quote in a bug report and the only thing that joins a
   * failure the caller saw to the record of what happened.
   */
  readonly requestId: string

  constructor(problem: Problem) {
    super(`${problem.title} (${problem.status}): ${problem.detail}`)
    this.name = 'NacreError'
    this.status = problem.status
    this.type = problem.type
    this.title = problem.title
    this.detail = problem.detail
    this.instance = problem.instance
    this.requestId = problem.request_id
  }

  /**
   * Whether this is the answer the API gives for "absent, or not yours".
   *
   * Deliberately not two predicates. Invariant I4 says no permission and no
   * such object are indistinguishable, down to the wording — an SDK offering
   * `isForbidden()` alongside this would suggest a distinction the server is
   * built never to make, and every caller who branched on it would be wrong.
   */
  get isNotFound(): boolean {
    return this.status === 404
  }

  /** Worth retrying: rate limited, or a dependency is briefly unavailable. */
  get isTransient(): boolean {
    return this.status === 429 || this.status === 503 || this.status >= 500
  }
}

/** Thrown when the server answered but not with a problem document. */
export class NacreTransportError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'NacreTransportError'
    this.status = status
  }
}
