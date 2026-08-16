/**
 * What a caller is told about a document that failed to index.
 *
 * ## Why this is not just the error string
 *
 * The worker stores whatever went wrong verbatim, which is right for the
 * operator reading a log and wrong for the caller reading an API. That string
 * carries the embedding endpoint's URL, the parser's, and whatever a sidecar
 * put in its message — infrastructure names, on an internal network, written
 * by somebody who was not thinking about who reads them.
 *
 * The caller who most needs this is the one who should see it least: an agent
 * over MCP, possibly acting through a delegation somebody granted to a third
 * party. It needs to know its document failed and whether re-sending would
 * help. It does not need `http://embedder.internal:8080/embeddings`.
 *
 * So a failure becomes a **reason** — a stable string a program can branch on —
 * and a sentence written for the person who sent the document. The raw text
 * stays in Postgres and in the worker's log, where the operator is.
 *
 * ## The reasons
 *
 * Deliberately few. Each one answers "what should the caller do now", because
 * that is the only question the answer is for; two failures with the same
 * answer do not need two reasons.
 */

export type IngestFailureReason =
  /** The text was too long for the embedding model, and re-sending will not help. */
  | 'too_long'
  /** The document could not be read: a format the parser refuses, or bytes that are not what they said. */
  | 'unreadable'
  /** Something the deployment runs was unreachable or refused. Re-sending later may work. */
  | 'unavailable'
  /** A limit the organization is under. */
  | 'quota'
  /** Anything else. The operator has the detail. */
  | 'internal'

export interface IngestFailure {
  readonly reason: IngestFailureReason
  /** Safe to show a caller: no host, no URL, no credential, no document text. */
  readonly message: string
}

const MESSAGES: Record<IngestFailureReason, string> = {
  too_long:
    'A chunk of this document was too long for the embedding model even after being split. ' +
    'Re-sending it unchanged will fail the same way.',
  unreadable:
    'This document could not be read. The format may not be supported, or the bytes may not ' +
    'match the type they were sent as.',
  unavailable:
    'A service this installation depends on did not answer. Nothing is wrong with the document ' +
    'and sending it again later may work.',
  quota: 'This organization is at a limit that stopped the document being indexed.',
  internal: 'Indexing failed for a reason the operator has to look at.',
}

/**
 * Classify a stored failure.
 *
 * Matched on wording, which is unavoidable: what arrives here is a string built
 * from somebody else's error. The mapping is deliberately loose — an unmatched
 * failure is `internal`, which is honest, rather than a guess that sends the
 * caller to re-send a document that will never index.
 */
export function classifyIngestFailure(raw: string): IngestFailure {
  const text = raw.toLowerCase()

  const reason: IngestFailureReason =
    /must have less than \d+ tokens|too long|maximum (?:input )?length|context length/.test(text)
      ? 'too_long'
      : /quota|max_documents|limit reached|too many documents/.test(text)
        ? 'quota'
        : /parse|unsupported|not a pdf|%pdf|decode|extract/.test(text)
          ? 'unreadable'
          : /econnrefused|enotfound|etimedout|timeout|fetch failed|socket|answered 5\d\d|unavailable|network/.test(
                text,
              )
            ? 'unavailable'
            : 'internal'

  return { reason, message: MESSAGES[reason] }
}

/**
 * Whatever is safe to repeat from a stored failure, for a surface that wants to
 * say more than the sentence above.
 *
 * Strips anything shaped like a URL or a host:port, which is what the endpoint
 * errors carry. Not a general redactor and does not pretend to be one — the
 * classified message is the thing meant for callers, and this exists for the
 * one surface that has an operator on the other end.
 */
export function withoutHosts(raw: string): string {
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, '[endpoint]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\b/gi, '[host]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[host]')
}
