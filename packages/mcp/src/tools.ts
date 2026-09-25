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

/**
 * MCP's `ToolAnnotations`: what a client may assume about a tool before it
 * calls one — whether to ask a person first, whether a retry is safe.
 *
 * Every tool carries them, and the type requires it. Without them a client has
 * to assume the worst of every tool (the specification's defaults are "may
 * modify, may destroy, not idempotent, reaches the open world"), which makes a
 * careful client confirm every `search` and a careless one confirm nothing —
 * the delete included. They are hints and never a control: what a caller may
 * actually do is decided by `permission` and the resolver, on every call.
 */
export interface ToolAnnotations {
  readonly title: string
  /** Changes nothing anywhere. `ingest_status` qualifies: it reads a job. */
  readonly readOnlyHint: boolean
  /** May remove or replace what is already there. Meaningless when read-only. */
  readonly destructiveHint: boolean
  /** Calling twice with the same arguments leaves the same state as once. */
  readonly idempotentHint: boolean
  /** Reaches beyond this installation's own data. */
  readonly openWorldHint: boolean
}

export interface ToolDefinition {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations: ToolAnnotations
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
 * fact as `cacheScope: "private"` on tools/list; changing one without the other
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

/**
 * How many layers `tools/list` names inside the search description.
 *
 * A sample, not the catalog. The description used to interpolate every layer
 * the caller can read, which reads well at three and is a megabytes-long tool
 * description at the scale layers are sold for — one per patient, one per
 * matter. A dozen is enough for a model to see what kind of thing a layer is;
 * `list_layers` is the enumeration surface, and the description says so when
 * there are more.
 */
export const CATALOG_SAMPLE = 12

export function searchDescription(
  layers: readonly Layer[],
  options: { readonly more: boolean } = { more: false },
): string {
  if (layers.length === 0) {
    // Honest rather than inviting. A caller with no layers should not be
    // encouraged to call this, and must not be told what exists elsewhere.
    return `${WHAT_SEARCH_DOES} No layers are available to you.`
  }

  const catalog = layers
    .slice(0, CATALOG_SAMPLE)
    .map((l) => `${l.name} — ${l.description} (${l.documentCount} docs)`)
    .join('; ')

  return options.more || layers.length > CATALOG_SAMPLE
    ? `${WHAT_SEARCH_DOES} Available: ${catalog}; and more — call list_layers for the rest.`
    : `${WHAT_SEARCH_DOES} Available: ${catalog}.`
}

export function catalog(
  layers: readonly Layer[],
  options: { readonly more: boolean } = { more: false },
): readonly ToolDefinition[] {
  return [
    {
      name: 'search',
      title: 'Search documents',
      annotations: {
        title: 'Search documents',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description: searchDescription(layers, options),
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
      title: 'List layers',
      annotations: {
        title: 'List layers',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'The layers you can read, with descriptions and document counts. ' +
        'One page per call: pass next_cursor from the previous answer to continue.',
      permission: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 100, minimum: 1, maximum: 500 },
          cursor: {
            type: 'string',
            description: 'The next_cursor from the previous page. Absent means the first page.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_document',
      title: 'Get a document',
      annotations: {
        title: 'Get a document',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Fetch one document by id, or by external_id within a layer: its title, layer, status and ' +
        'metadata. Read-only.',
      permission: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          document_id: {
            type: 'string',
            description: 'The document id, as search returns it.',
          },
          external_id: {
            type: 'string',
            description: 'The id the document was ingested under. Needs layer as well.',
          },
          layer: {
            type: 'string',
            description: 'Layer slug; required with external_id.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'ingest_status',
      title: 'Check an ingest',
      annotations: {
        title: 'Check an ingest',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      title: 'Add or update a document',
      // Destructive because sending an external_id that already exists
      // replaces that document's content; idempotent for the same reason.
      // Open world because `url` makes the parser fetch somebody else's page.
      annotations: {
        title: 'Add or update a document',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        'Add or update a document in a layer. An external_id that already exists is replaced. ' +
        'Returns `queued`: the document is accepted, not yet indexed. Check ingest_status with ' +
        'the job_id before treating it as searchable.',
      // write, and write does not imply read: a service account that only
      // uploads must not be able to search what it uploaded.
      permission: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          layer: {
            type: 'string',
            description: 'Slug of the layer to write into.',
          },
          external_id: {
            type: 'string',
            description:
              'Your id for the document and the idempotency key: sending the same one again ' +
              'replaces that document instead of adding a second.',
          },
          title: { type: 'string' },
          content: {
            type: 'string',
            description: 'The text to index. One of content or url is required.',
          },
          url: {
            type: 'string',
            description: 'A public page to fetch and index instead of content.',
          },
          metadata: {
            type: 'object',
            description:
              'Flat key/value tags (lower-case keys) that search can filter on with `filters`.',
          },
        },
        required: ['layer'],
        additionalProperties: false,
      },
    },
    {
      name: 'delete_document',
      title: 'Delete a document',
      annotations: {
        title: 'Delete a document',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Delete a document: it leaves search results immediately and its vectors are reclaimed ' +
        'later. Destructive: there is no undelete; sending it again with ingest_document brings it ' +
        'back. Identify it by document_id, or by external_id with layer.',
      permission: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          document_id: {
            type: 'string',
            description: 'The document id, as search returns it.',
          },
          external_id: {
            type: 'string',
            description: 'The id the document was ingested under. Needs layer as well.',
          },
          layer: {
            type: 'string',
            description: 'Layer slug; required with external_id.',
          },
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

/**
 * The catalog as a dispatcher sees it: names and permissions, no listing.
 *
 * A tool's name and its permission are static; only the search *description*
 * depends on the caller's layers, and nothing reads a description while
 * dispatching. Both transports used to fetch the full per-caller catalog to
 * find a tool by name — a listing per call, paid for by every caller on every
 * call, read by nobody.
 */
export function dispatchCatalog(): readonly ToolDefinition[] {
  return catalog([])
}

