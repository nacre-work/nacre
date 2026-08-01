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
export function searchDescription(layers: readonly Layer[]): string {
  if (layers.length === 0) {
    // Honest rather than inviting. A caller with no layers should not be
    // encouraged to call this, and must not be told what exists elsewhere.
    return 'Semantic search over corporate documents. No layers are available to you.'
  }

  const catalog = layers
    .map((l) => `${l.name} — ${l.description} (${l.documentCount} docs)`)
    .join('; ')

  return `Semantic search over corporate documents. Available: ${catalog}.`
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
            description: 'Layers to search. Empty means all accessible ones.',
          },
          top_k: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
          filters: { type: 'object', description: 'Filter on document metadata fields' },
          rerank: { type: 'boolean', default: true },
          include_content: { type: 'boolean', default: true },
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
      name: 'ingest_document',
      description: 'Add or update a document in a layer.',
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
