/**
 * What a piece of text will cost an embedding model, in tokens.
 *
 * ## Why this exists
 *
 * A chunk size in **characters** says nothing about whether the embedder will
 * accept it. Every embedding model has a hard ceiling on input length measured
 * in tokens — 512 for the BGE and E5 families, which is what these Compose
 * profiles start and what most self-hosted deployments run — and a character
 * is not a token. Under an English tokenizer a Cyrillic or Korean character
 * costs several.
 *
 * Measured against a real `BAAI/bge-small-en-v1.5` through Text Embeddings
 * Inference's `/tokenize`, at the 800-character chunk this repository shipped:
 *
 * | script  | chars | tokens | over 512? |
 * |---------|-------|--------|-----------|
 * | English |   800 |    149 | no        |
 * | Hindi   |   800 |    471 | no        |
 * | Greek   |   800 |    642 | **yes**   |
 * | Russian |   800 |    655 | **yes**   |
 * | Hebrew  |   800 |    664 | **yes**   |
 * | Arabic  |   800 |    676 | **yes**   |
 * | Chinese |   800 |    802 | **yes**   |
 * | Japanese|   800 |    802 | **yes**   |
 * | Korean  |   800 |   1094 | **yes**   |
 *
 * Seven scripts out of eleven tried. The endpoint answers `413` and the worker
 * marks the document `failed`, which nothing retries — so a Russian corpus
 * indexed nothing at all while the API answered `queued`. Exactly the shape of
 * the batch-size defect, arriving through the other bound on the same request.
 *
 * ## The cost model, and why it is not the provable one
 *
 * The provable bound is the UTF-8 **byte** length: a byte-fallback tokenizer
 * emits at most one token per byte, and the worst case measured was 0.97
 * tokens per byte. Using it would be correct and would also cut English chunks
 * from 800 characters to about 510, for text that was never near the ceiling —
 * a 57% increase in vectors to fix a problem English does not have.
 *
 * So ASCII is charged at **half a token per character** and everything else at
 * its byte length. That is above ASCII prose (0.18 measured) and identifiers
 * (0.42), and below the one ASCII case that beats it — a run of pure
 * punctuation, at 0.97. This estimate is therefore *not* an upper bound, and
 * that is a deliberate trade rather than an oversight: `ingest.ts` re-chunks
 * and retries when the endpoint refuses, so an underestimate costs one extra
 * request and never a document. Being provably safe here would cost every
 * English deployment half its context, permanently, to avoid a retry.
 */

/**
 * The ceiling to assume when a deployment has not said and the endpoint will
 * not answer.
 *
 * **512, because that is what the BGE and E5 families accept** — the models
 * this project's own profiles start. The same argument as `DEFAULT_EMBED_BATCH`
 * being 32: a bound the ecosystem's most common self-hosted server actually
 * enforces, rather than a guess at a good number.
 */
export const DEFAULT_EMBED_MAX_TOKENS = 512

/**
 * Reserved out of the ceiling for whatever the model adds around the input.
 *
 * BERT-family tokenizers wrap every input in `[CLS]` and `[SEP]`, and those
 * count against the same 512. Four rather than two: a tokenizer that adds a
 * language or task prefix — E5's `query:` and `passage:`, which some
 * deployments prepend — costs a little more, and the difference between four
 * tokens and two is not worth a refusal.
 */
export const TOKEN_RESERVE = 4

/**
 * An estimate of what `text` costs the embedder, in tokens.
 *
 * Deliberately cheap: one pass, no table, no allocation per character. It runs
 * on every chunk boundary of every document, so it has to cost about what
 * measuring a length costs.
 */
export function estimateTokens(text: string): number {
  let cost = 0
  for (const character of text) {
    const code = character.codePointAt(0) as number
    if (code < 0x80) {
      // ASCII: half a token each. See the note above — over prose and
      // identifiers, under a run of pure punctuation.
      cost += 0.5
    } else if (code < 0x800) {
      cost += 2
    } else if (code < 0x10000) {
      cost += 3
    } else {
      // Astral: emoji, and the rarer CJK planes. Four bytes.
      cost += 4
    }
  }
  return Math.ceil(cost)
}

/**
 * How much of a model's window a chunk may fill.
 *
 * Separate from the ceiling itself so the reserve is applied in one place
 * rather than at each call site — the defect this file exists for is a bound
 * that two pieces of code disagreed about.
 */
export function tokenBudget(maxTokens: number = DEFAULT_EMBED_MAX_TOKENS): number {
  const budget = maxTokens - TOKEN_RESERVE
  if (budget < 1) {
    throw new Error(
      `an embedding token ceiling of ${String(maxTokens)} leaves no room for input once ` +
        `${String(TOKEN_RESERVE)} tokens are reserved for what the model wraps around it`,
    )
  }
  return budget
}

/**
 * Whether an error from an embedding endpoint says the input was too long.
 *
 * Matched on the message rather than the status, and both are checked, because
 * the status alone is ambiguous: Text Embeddings Inference answers **413** for
 * a batch with too many texts *and* for one text with too many tokens, and the
 * two want opposite repairs — send fewer texts, or send shorter ones. The
 * wording is what tells them apart.
 *
 * Checked against a real TEI: the OpenAI-shaped route answers
 * `Input validation error: \`inputs\` must have less than 512 tokens. Given: 1482`.
 */
export function refusedForLength(message: string): boolean {
  return /must have less than \d+ tokens|too long|exceeds? (?:the )?maximum (?:input )?length|context length/i.test(
    message,
  )
}
