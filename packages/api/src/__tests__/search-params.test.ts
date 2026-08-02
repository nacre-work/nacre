import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApi, type SearchHit, type SearchOptions } from '../index.js'
import { NacreSearchService } from '../adapters.js'
import type { AccessPlan } from '@nacre.work/core'

/**
 * The three search parameters that were declared and ignored.
 *
 * `layers`, `filters` and `include_content` were in `docs/openapi.yaml` and in
 * the MCP tool schema from the beginning, and the handler read `query`, `top_k`
 * and `rerank`. A client scoping a search to one layer silently searched all of
 * them, and one filtering by metadata got everything back.
 *
 * For this product that is the worst available shape of no-op: a caller who
 * narrows a search and is handed everything believes they narrowed it. These
 * assert what the handler now does with each — the search service is a stub,
 * because what is under test is what reaches it.
 */

const SECRET = new TextEncoder().encode('a'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'
const ORG = '11111111-1111-1111-1111-111111111111'

/** Every option the handler passed down, in order. */
const seen: SearchOptions[] = []

const hit = (id: string): SearchHit => ({
  chunk_id: id,
  doc_id: 'doc-1',
  layer: 'handbook',
  title: 'Handbook',
  score: 0.9,
  text: 'the body of the chunk',
})

let server: Server
let base: string

const auth = async (): Promise<Record<string, string>> => ({
  authorization: `Bearer ${await new SignJWT({ org: ORG, principal_type: 'user', role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('alice')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)}`,
  'content-type': 'application/json',
})

const search = async (body: unknown): Promise<Response> =>
  fetch(`${base}/v1/search`, { method: 'POST', headers: await auth(), body: JSON.stringify(body) })

describe('search parameters', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      documents: { read: async () => undefined },
      search: {
        search: async (_a, _q, _k, options = {}) => {
          seen.push(options)
          // The service is what applies `includeContent`; this stub returns the
          // text unconditionally so a handler quietly stripping it would show up
          // as a difference here rather than being masked.
          return [hit('chunk-1')]
        },
      },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => {} },
      jobs: { read: async () => undefined },
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('passes layers down instead of dropping them', async () => {
    seen.length = 0
    const response = await search({ query: 'anything', layers: ['handbook', 'policies'] })

    expect(response.status).toBe(200)
    expect(seen[0]?.layers).toEqual(['handbook', 'policies'])
  })

  it('treats an empty layers array as no restriction', async () => {
    // `[]` means "every layer I can read", not "no layers". The distinction
    // matters because the filter builder refuses a narrowing to nothing, so
    // passing `[]` through would turn a harmless request into a 500.
    seen.length = 0
    const response = await search({ query: 'anything', layers: [] })

    expect(response.status).toBe(200)
    expect(seen[0]?.layers).toBeUndefined()
  })

  it('refuses layers that is not an array of strings', async () => {
    for (const layers of ['handbook', 42, [1, 2], [{}], { a: 1 }]) {
      const response = await search({ query: 'anything', layers })
      expect(response.status).toBe(400)
    }
  })

  it('refuses filters rather than ignoring it', async () => {
    // The whole point. Accepting the parameter and applying nothing lets a
    // search look narrower than it was, which is the one failure this product
    // cannot afford to make quiet.
    seen.length = 0
    const response = await search({ query: 'anything', filters: { department: 'legal' } })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { detail: string }
    expect(body.detail).toContain('not implemented')
    // And the search never ran, so nothing was returned that could look filtered.
    expect(seen).toEqual([])
  })

  it('refuses an empty filters object too', async () => {
    // `{}` is a client that built a filter and found nothing to put in it. It
    // is still a client that believes filtering works.
    expect((await search({ query: 'anything', filters: {} })).status).toBe(400)
  })

  it('passes include_content down when it is false', async () => {
    seen.length = 0
    const response = await search({ query: 'anything', include_content: false })

    expect(response.status).toBe(200)
    expect(seen[0]?.includeContent).toBe(false)
  })

  it('leaves include_content alone when it is true or absent', async () => {
    // Only ever a way to turn the text off. `true` is the default, so passing
    // it changes nothing and must not become an explicit option that a service
    // could read as "definitely include" and treat differently.
    seen.length = 0
    await search({ query: 'anything', include_content: true })
    await search({ query: 'anything' })

    expect(seen[0]?.includeContent).toBeUndefined()
    expect(seen[1]?.includeContent).toBeUndefined()
  })

  it('still requires a query', async () => {
    expect((await search({ layers: ['handbook'] })).status).toBe(400)
  })
})

/**
 * What the service does with the options, as opposed to what the handler passes.
 *
 * Two decisions live here and nowhere else: which layer ids the narrowing ends
 * up carrying, and whether the text survives. The narrowing's *safety* property
 * — that it can only ever remove results — is `buildFilter`'s and is tested in
 * packages/core/authz/__tests__/prefilter.test.ts.
 *
 * The pool is a fake because `withOrg` is the real one: it wants BEGIN, a role,
 * a set_config and a COMMIT, and none of those are what is under test.
 */
describe('NacreSearchService options', () => {
  const LAYER = 'eeeeeeee-0000-4000-8000-000000000001'
  const WORKSPACE = 'dddddddd-0000-4000-8000-000000000001'

  /**
   * Enough of a database for the resolver to produce a scoped plan.
   *
   * One `read` grant on one layer, no groups, no document-level grants — which
   * is the ordinary shape and the one the narrowing intersects against. Every
   * other statement (`BEGIN`, `SET LOCAL ROLE`, `set_config`, `COMMIT`) answers
   * empty, because `withOrg` here is the real one.
   */
  const CATALOGUE = [
    {
      id: LAYER,
      vector_name: 'v_test_2',
      provider_id: 'provider-1',
      endpoint: 'http://embedder.invalid',
      model: 'test',
      dimensions: 2,
    },
  ]

  const poolReturning = (
    layerLookup: readonly string[],
    catalogue: readonly Record<string, unknown>[] = CATALOGUE,
  ) =>
    ({
      connect: async () => ({
        query: async (text: string) => {
          if (text.includes('vector_collection FROM organizations')) {
            return { rows: [{ vector_collection: 'org_acme' }] }
          }
          // The layer catalogue the branch grouping is built from. One layer
          // on one provider by default, which is the ordinary single-model
          // shape.
          if (text.includes('JOIN embedding_providers')) {
            return { rows: [...catalogue] }
          }
          if (text.includes('FROM layers WHERE org_id = $1 AND slug = ANY')) {
            return { rows: layerLookup.map((id) => ({ id })) }
          }
          if (text.includes('FROM grants')) {
            return {
              rows: [
                {
                  principal_type: 'user',
                  principal_id: 'alice',
                  scope_type: 'layer',
                  scope_id: LAYER,
                  permission: 'read',
                  effect: 'allow',
                },
              ],
            }
          }
          if (text.includes('id, workspace_id FROM layers')) {
            return { rows: [{ id: LAYER, workspace_id: WORKSPACE }] }
          }
          return { rows: [] }
        },
        release: () => {},
      }),
    }) as never

  const service = (
    options: {
      resolvesTo?: readonly string[]
      plan?: AccessPlan
      onSearch?: (narrow: { layers: readonly string[] } | undefined) => void
    } = {},
  ) =>
    new NacreSearchService({
      pool: poolReturning(options.resolvesTo ?? []),
      vectors: {
        search: async (request: { narrow?: { layers: readonly string[] } }) => {
          options.onSearch?.(request.narrow)
          return [{ id: 'chunk-1', score: 0.9, payload: { org_id: ORG } }]
        },
      },
      embedderFor: () => ({ embed: async () => [[0.1, 0.2]] }),
    } as never)

  const context = { orgId: ORG, role: 'member', principal: { type: 'user', id: 'alice' } } as never

  it('refuses a layer whose vector name and provider disagree', async () => {
    // These two columns say which slot to search and which model to embed the
    // query with. A reindex switched the first and left the second behind, and
    // the symptom was Qdrant refusing the whole query on a dimension mismatch
    // — which takes every other layer in the organization down with it. Named
    // here, and raised rather than skipped: dropping the layer would answer the
    // search from a silently smaller corpus.
    const svc = new NacreSearchService({
      pool: poolReturning([], [
        {
          id: LAYER,
          // The old model's slot...
          vector_name: 'v_bge_m3_1024',
          provider_id: 'provider-1',
          endpoint: 'http://embedder.invalid',
          // ...with the new model's provider.
          model: 'small-v2',
          dimensions: 768,
        },
      ]),
      vectors: { search: async () => [] },
      embedderFor: () => ({ embed: async () => [[0.1, 0.2]] }),
    } as never)

    await expect(svc.search(context, 'q', 5)).rejects.toThrow(/out of step/)
  })

  it('strips the text when include_content is false, and keeps everything else', async () => {
    // One line in the service, which is exactly the kind of thing that breaks
    // silently: a client asking for ids and scores would keep paying for
    // bodies and never know.
    const svc = service()
    // Hydration reads chunk text from Postgres, which the fake pool does not
    // model. Replaced with a known hit so the assertion is about the one
    // transformation under test.
    ;(svc as unknown as { hydrate: unknown }).hydrate = async () => [hit('chunk-1')]

    const withText = await svc.search(context, 'q', 5)
    const withoutText = await svc.search(context, 'q', 5, { includeContent: false })

    expect(withText[0]?.text).toBe('the body of the chunk')
    expect(withoutText[0]?.text).toBe('')
    // Ids and scores survive — that is the entire point of asking for it.
    expect(withoutText[0]?.chunk_id).toBe('chunk-1')
    expect(withoutText[0]?.score).toBe(0.9)
  })

  it('does not query at all when no named layer resolves', async () => {
    // A slug that does not exist and one that exists but sits outside the
    // caller's grants are the same answer, and neither costs a round trip to
    // the vector store. That last part matters: whatever makes the query path
    // fail — the embedder being down, the vector store being down — would
    // otherwise separate the two cases.
    let queried = false
    const svc = service({ resolvesTo: [], onSearch: () => (queried = true) })
    ;(svc as unknown as { hydrate: unknown }).hydrate = async () => [hit('chunk-1')]

    expect(await svc.search(context, 'q', 5, { layers: ['nope'] })).toEqual([])
    expect(queried).toBe(false)
  })
})
