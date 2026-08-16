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
 * beside the message itself with anything shaped like a host or a URL taken
 * out. Relaying the real wording matters: a scanned PDF fails with a message
 * naming the scan and pointing at OCR, and a sentence invented here would
 * send an operator looking for a corrupt file. The unredacted text stays in
 * Postgres and in the worker's log, where the operator is.
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

  // The message is the real one with hosts removed, not a sentence written
  // here. Replacing it looked safer and threw away the only thing that made
  // some failures actionable: a scanned PDF fails with a message naming the
  // scan and pointing at OCR, and "This document could not be read" sends an
  // operator hunting for a corrupt file instead. The compose smoke asserts
  // that specific wording survives, and caught exactly this.
  //
  // What the caller must not receive is the *infrastructure* in it, which is
  // what `withoutHosts` takes out. The advice that used to be canned here —
  // whether re-sending helps — is what `reason` is for, and it is documented
  // against the reason rather than repeated into every message.
  const message = withoutHosts(raw).slice(0, 300)
  return { reason, message }
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
