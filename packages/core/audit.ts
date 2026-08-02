import { createHash } from 'node:crypto'

/**
 * What the journal is allowed to say about a query.
 *
 * `docs/audit.md` is normative and says two things here. Neither was true:
 *
 *   > **Never:** document contents, chunk text, and — with
 *   > `NACRE_AUDIT_QUERY_TEXT=false`, the default — full query text. A query
 *   > hash is stored instead.
 *
 * There was no hash. The `detail` written for a search carried a count and
 * nothing about the query at all, so the promise that a hash is "enough to
 * investigate an incident" was a promise about a field that did not exist —
 * and `NACRE_AUDIT_QUERY_TEXT` was validated at startup and read by nothing,
 * so the deployments that had decided otherwise got the same nothing.
 *
 * ─── why the hash is unconditional and the text is not ───
 *
 * The hash answers the question an investigation actually asks — *did this
 * agent run this query, and how often* — by comparing hashes, and it cannot
 * leak what was searched for. The text answers a different question, is a
 * decision with a compliance owner, and is the reason the flag exists.
 *
 * One function so the two surfaces cannot disagree. A search over MCP and the
 * same search over REST must leave the same record; that they did not is what
 * `nacre_acl_denials_total` and the rate limiter both had to be fixed for.
 */
export interface QueryAudit {
  /** `sha256:` and hex, the same shape as `documents.content_hash`. */
  readonly query_hash: string
  /** Present only where a deployment set `NACRE_AUDIT_QUERY_TEXT`. */
  readonly query?: string
}

/**
 * Bounded, because the journal is not a place to put an unbounded caller
 * string. A query longer than this is truncated in the record and still hashed
 * whole — the hash is of what was asked, not of what was stored, or two records
 * of the same long query would not match each other.
 */
export const MAX_AUDITED_QUERY = 1024

export function queryAudit(query: string, includeText: boolean): QueryAudit {
  const hash = `sha256:${createHash('sha256').update(query, 'utf8').digest('hex')}`
  if (!includeText) return { query_hash: hash }
  return {
    query_hash: hash,
    query: query.length > MAX_AUDITED_QUERY ? `${query.slice(0, MAX_AUDITED_QUERY)}…` : query,
  }
}
