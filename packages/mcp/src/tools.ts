import type { AuthContext } from '@nacre.work/api'

/**
 * The tool catalog, from docs/mcp.md 5.4.
 *
 * Every entry names the permission it needs, and the permission is checked on
 * every call by the authorization service. A valid token grants access to no
 * document by itself — EMA and ID-JAG authorize the *connection*, and that is a
 * different question from whether this caller may read this layer.
 */
export type ToolPermission = 'read' | 'write'

export interface Layer {
  readonly id: string
  readonly slug: string
  readonly name: string
  /** User-facing copy: it ends up in the generated tool description. */
  readonly description: string
  readonly documentCount: number
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly permission: ToolPermission
}

/** A tool as MCP defines one: no `permission`, because that field is ours. */
export type WireTool = Omit<ToolDefinition, 'permission'>

/**
 * The catalog as it goes on the wire.
 *
 * `permission` is this repository's own bookkeeping — it names what a tool
 * resolves, and `mcp-surface.test.ts` asserts each one. MCP's `Tool` object has
 * no such member, so putting it in a response is a non-standard field a client
 * validating against the schema is entitled to refuse.
 *
 * Streamable HTTP stripped it and STDIO did not, so for the whole life of both
 * transports `tools/list` answered with different objects depending on which
 * one you asked — and `transport-parity.test.ts`, which exists against exactly
 * that, compared the tool *names* and was green. One function now, because two
 * places that have to remember is what produced it, and the parity case
 * compares the shape.
 */
export const onTheWire = (tools: readonly ToolDefinition[]): WireTool[] =>
  tools.map(({ permission, ...tool }) => {
    void permission
    return tool
  })

/**
 * The description of `search` is generated from the layers this caller can see.
 *
 * A generic "searches the knowledge base" makes a model reach for web search
 * instead of the index — it has no way to tell whether the answer is in there.
 * Naming the layers and their sizes is what turns the tool from a gamble into
 * an obvious choice.
 *
 * Because it depends on permissions, the catalog is per user. That is the same
 * fact as `cacheScope: "user"` on tools/list; changing one without the other
 * serves one caller's catalog to another.
 */
/**
 * What the tool does, in the sentence a model reads before deciding to call it.
 *
 * It said "Semantic search over corporate documents" while search was in fact
 * dense-only, so the description was accurate and the product was the poorer
 * half of what it should have been. Now that the lexical branch exists, leaving
 * the sentence alone would be the opposite error — and it is not a cosmetic
 * one. A model asked for `SQLSTATE 23505`, an invoice number or a variable name
 * reads "semantic" as *conceptually similar*, concludes that a literal string
 * is not what this tool is for, and goes to a web search or to guessing. The
 * catalog below is in the description for exactly the same reason.
 *
 * Short on purpose: this text is sent on every `tools/list`, and the per-layer
 * catalog after it is the part that varies and earns its length.
 */
const WHAT_SEARCH_DOES =
  'Search corporate documents by meaning and by exact term — identifiers, error codes, ' +
  'part numbers and names match literally.'

export function searchDescription(layers: readonly Layer[]): string {
  if (layers.length === 0) {
    // Honest rather than inviting. A caller with no layers should not be
    // encouraged to call this, and must not be told what exists elsewhere.
    return `${WHAT_SEARCH_DOES} No layers are available to you.`
  }

  const catalog = layers
    .map((l) => `${l.name} — ${l.description} (${l.documentCount} docs)`)
    .join('; ')

  return `${WHAT_SEARCH_DOES} Available: ${catalog}.`
}

export function catalog(layers: readonly Layer[]): readonly ToolDefinition[] {
  return [
    {
      name: 'search',
      description: searchDescription(layers),
      permission: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query' },
          layers: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Layer slugs to restrict the search to. Empty or absent means every ' +
              'layer you can read. Naming a layer you cannot read returns nothing ' +
              'from it, and is indistinguishable from naming one that does not exist.',
            maxItems: 64,
          },
          top_k: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
          rerank: { type: 'boolean', default: true },
          include_content: {
            type: 'boolean',
            default: true,
            description: 'false omits the chunk text, leaving ids and scores.',
          },
          // Back, and applied this time. It was advertised and read by nothing
          // once, so a client that filtered a search got everything back and
          // believed it had narrowed the query — which for an agent is worse
          // than for a person, because an agent acts on the answer without
          // looking at it.
          filters: {
            type: 'object',
            description:
              'Restrict to documents whose metadata matches. Equality; a list means any of ' +
              'those values. Narrowing only — it can never reach a document you could not ' +
              'already read. Keys are lower case letters, digits and underscores.',
            additionalProperties: {
              oneOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'array', items: { type: ['string', 'number', 'boolean'] }, maxItems: 32 },
              ],
            },
          },
        },
        required: ['query'],
        // No org_id, at any depth. The organization comes from the token, and a
        // schema that accepts one invites a client to send it.
        additionalProperties: false,
      },
    },
    {
      name: 'list_layers',
      description: 'The layers you can read, with descriptions and document counts.',
      permission: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'get_document',
      description: 'Fetch one document by id, or by external id within a layer.',
      permission: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          document_id: { type: 'string' },
          external_id: { type: 'string' },
          layer: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'ingest_status',
      /**
       * The tool an agent needs and did not have.
       *
       * `ingest_document` answers `queued`, and everything that can go wrong
       * happens afterwards in the worker — so an agent that ingested and moved
       * on treated a queued document as an indexed one. There was no way for it
       * to learn otherwise: `get_document` needs `read`, and rule 6 means the
       * ingest-only principal this surface is built for does not have it.
       *
       * `write`, therefore. What it returns is a status, a chunk count and a
       * classified reason — never the document.
       */
      description:
        'What became of an ingest. Poll this after ingest_document: `queued` means the work was ' +
        'accepted, not that it succeeded, and indexing fails afterwards. `indexed` with ' +
        'chunk_count 0 means the document parsed to no text and is not searchable. On `failed`, ' +
        'reason says whether re-sending would help — `too_long` and `unreadable` will not change, ' +
        '`unavailable` may.',
      permission: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'From ingest_document' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'ingest_document',
      description:
        'Add or update a document in a layer. Returns `queued`: the document is accepted, not ' +
        'yet indexed. Check ingest_status with the job_id before treating it as searchable.',
      // write, and write does not imply read: a service account that only
      // uploads must not be able to search what it uploaded.
      permission: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          layer: { type: 'string' },
          external_id: { type: 'string', description: 'Idempotency key' },
          title: { type: 'string' },
          content: { type: 'string' },
          url: { type: 'string' },
          metadata: { type: 'object' },
        },
        required: ['layer'],
        additionalProperties: false,
      },
    },
    {
      name: 'delete_document',
      description: 'Tombstone a document. It leaves search results immediately.',
      permission: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          document_id: { type: 'string' },
          external_id: { type: 'string' },
          layer: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  ]
}

/** What a tool call needs to reach the rest of the system. */
export interface ToolContext {
  readonly auth: AuthContext
  readonly requestId: string
}
