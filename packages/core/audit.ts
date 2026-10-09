import { AsyncLocalStorage } from 'node:async_hooks'
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

/**
 * Which connection a request came through, for every audit row it writes.
 *
 * `audit_events.client` has been in the schema since 0001 and nothing ever
 * wrote it. `AuditEvent` had no field for it and fifty-nine call sites build
 * one, so an access log of a delegated request said *who* — the person — and
 * never *through what*: an approval made by an application could not be told
 * apart from one the person made in the console, which is the question
 * `docs/upgrading.md` had to answer for 0.31.1 with "look at the Connections
 * screen instead".
 *
 * A scope rather than a field at every call site, because the fact is about the
 * request and not about any one event in it. A surface enters the scope once
 * per request, sets the connection after authentication, and every write inside
 * it carries the value — a call site added next year included, which is the
 * property fifty-nine edits would not have had.
 *
 * Mutable inside the scope deliberately: the scope has to exist before
 * authentication runs, so that a refusal written during authentication is in
 * one too, and the connection is known only after it.
 */
const auditScope = new AsyncLocalStorage<{ client?: string | undefined }>()

/** Run one request inside its own audit scope. */
export function inAuditScope<T>(run: () => T): T {
  return auditScope.run({}, run)
}

/** Record the connection the current request came through. A no-op outside a scope. */
export function setAuditClient(client: string | undefined): void {
  const store = auditScope.getStore()
  if (store !== undefined) store.client = client
}

/** The connection the current request came through, if the surface set one. */
export function auditClient(): string | undefined {
  return auditScope.getStore()?.client
}

/**
 * What the `client` column records for a delegated request: the connection,
 * by id, which the Connections screen and `GET /v1/oauth/connections` name.
 * A connection id rather than the client's self-reported name, because the
 * name is whatever the application registered and the id is what can be
 * revoked.
 */
export function connectionClient(connectionId: string): string {
  return `connection:${connectionId}`
}
