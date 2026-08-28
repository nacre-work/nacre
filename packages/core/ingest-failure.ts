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

/**
 * Whether the worker should try this document again.
 *
 * The reasons already say the answer in their own documentation — `unavailable`
 * is "re-sending later may work", `too_long` is "re-sending will not help" —
 * and this is that sentence made executable, in the file that defines them, so
 * the two cannot drift.
 *
 * `internal` retries, and that is the one judgement call here. It is the
 * unmatched case: something went wrong that this classifier has never seen, and
 * the honest prior for an unknown error in a distributed system is that it
 * might not happen twice. The bound is what makes the guess safe — a permanent
 * unknown costs `NACRE_INDEX_MAX_ATTEMPTS` attempts spaced by backoff and then
 * fails exactly as it would have, while a transient unknown recovers by itself.
 * Guessing the other way costs a document that would have indexed.
 *
 * `quota` deliberately does **not** retry. It is the one failure whose remedy
 * is an administrator raising a limit, and retrying against a quota that is
 * still full is load with no chance of success — the caller is told, and a
 * re-send after the limit moves is a re-send somebody meant.
 */
export function isRetryable(reason: IngestFailureReason): boolean {
  return reason === 'unavailable' || reason === 'internal'
}

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
 * Whatever is safe to repeat from a stored failure.
 *
 * ## Redacted by context, not by the shape of a token
 *
 * The first version matched anything with a dot and a two-letter tail, and that
 * is wrong in both directions.
 *
 * It **missed** every hostname this product actually deploys with. Service
 * names in `docker-compose.yml` and in the chart are single-label — `embedder`,
 * `qdrant`, `parser`, `minio` — so a rule needing a dot held for the example in
 * the paragraph above (`embedder.internal`) and for nothing that ships. The way
 * the name survived is worth keeping: the URL was removed, and then undici
 * appended its cause verbatim, so `getaddrinfo ENOTFOUND embedder` sat at the
 * end of an otherwise redacted sentence. IPv6 was untouched entirely.
 *
 * So a host is now recognised where a host can *be*: after a scheme, inside
 * brackets, as `name:port`, after a DNS or socket error code, and after the
 * handful of phrases this repository writes itself. Those are the positions a
 * machine puts one in, and unlike a token's shape they are not shared with
 * anything a person wrote.
 *
 * ## What it still over-redacts, and why that is the direction to fail in
 *
 * The dotted-name rule stays, last, and it cannot tell `contract.pdf` from
 * `example.com` — nothing can, they are the same string with a different tail,
 * and a list of file extensions is a list that goes stale. So a filename in a
 * parser's message becomes `[host]`, which costs the sender the name of their
 * own document.
 *
 * That is the trade taken deliberately: over-redacting a filename is a
 * usability cost on one message, and under-redacting a hostname is the thing
 * this function exists to prevent, on a surface a third party reaches through
 * a delegation. It is stated here and in `docs/openapi.yaml` rather than left
 * for somebody to discover.
 *
 * Not a general redactor and does not pretend to be one: a credential that is
 * not inside a URL passes through, because there is no shape to match it on.
 */
export function withoutHosts(raw: string): string {
  return (
    raw
      // A URL, whatever the scheme. Everything after `://` goes, which is what
      // takes the userinfo with it: `postgres://user:hunter2@db:5432/x`.
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, '[endpoint]')
      // IPv6 in brackets, with or without a port: `[fd00:ec2::23]:8080`.
      .replace(/\[[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}\](?::\d{1,5})?/gi, '[host]')
      // Bare IPv6. Three colons at least, so a clock (`12:30:45`) is not one
      // and `::1:8080` is — the lookbehind rather than `\b` because a leading
      // `::` has no word boundary in front of it, which is how that one
      // survived the first attempt at this rule.
      .replace(/(?<![\w:.])(?:[0-9a-f]{0,4}:){3,}[0-9a-f]{0,4}/gi, '[host]')
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[host]')
      // `host:port`, which is the shape that makes a bare label a host rather
      // than a word. This is what catches `embedder:8080` — every service name
      // this product ships with is single-label.
      .replace(/\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*:\d{2,5}\b/gi, '[host]')
      // Node names the host straight after the code, and undici appends the
      // cause verbatim to a message whose URL has already been taken out — so
      // `getaddrinfo ENOTFOUND embedder` is where the name actually survived.
      //
      // Case-sensitive, and the lookahead skips a second code, because the
      // real string is `getaddrinfo ENOTFOUND embedder` and the naive rule
      // redacts `ENOTFOUND` and keeps the host.
      .replace(
        /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\s+(?![A-Z_]{3,}\b)[A-Za-z0-9_.[\]-]*[A-Za-z0-9\]]/g,
        '$1 [host]',
      )
      // And our own wording says it in prose, where there is no port and no
      // code to anchor on.
      .replace(
        /\b(could not reach|could not connect to|connection to|connecting to|connect to|no route to)\s+[A-Za-z0-9_.[\]-]*[A-Za-z0-9\]]/gi,
        '$1 [host]',
      )
      // A dotted name. Last, and deliberately kept even though it is the rule
      // that cannot tell `contract.pdf` from `example.com` — see the note in
      // this function's header about which way that trade goes.
      .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\b/gi, '[host]')
  )
}
