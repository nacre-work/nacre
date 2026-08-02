/**
 * ACL tag recomputation.
 *
 * docs/authz.md 3.6: `acl_tags` is a cache of the `grants` table, a grant
 * change enqueues a background recomputation of the affected documents, and
 * `nacre_acl_propagation_lag_seconds` is bounded by the SLA. The measurement
 * landed first. This is the part that drains it.
 *
 * What it must not become is a second permission model. It recomputes the same
 * tags `tagsForLayer` produces at index time, from the same table, and writes
 * them to the payload. Nothing here decides who may read anything — a resolver
 * that disagreed with the one in `packages/core/authz` would be a leak that
 * every test in the leak suite passes, because the suite tests that resolver.
 */

export interface StaleDocument {
  readonly orgId: string
  /** The organization's collection, not derived from its slug. */
  readonly collection: string
  readonly documentId: string
  readonly layerId: string
}

export interface RetagPorts {
  /** Documents whose acl_version is behind their organization's, oldest first. */
  claim(limit: number): Promise<readonly StaleDocument[]>
  /** The tags for a layer, and the version they were built from. */
  tagsFor(orgId: string, layerId: string): Promise<{ tags: readonly string[]; version: number }>
  /** Rewrite the payload tags of every point of a document. */
  retag(input: {
    collection: string
    documentId: string
    aclTags: readonly string[]
    aclVersion: number
  }): Promise<void>
  markTagged(orgId: string, documentId: string, aclVersion: number): Promise<void>
  onError(document: StaleDocument, error: unknown): void
}

export interface RetagResult {
  readonly retagged: number
  readonly failed: number
}

/**
 * One pass.
 *
 * `concurrency` is bounded because the spec asks for it and because the reason
 * is not throughput: a revocation across a large layer can touch every document
 * in it, and an unbounded pass would take the vector store down at exactly the
 * moment correctness depends on it being reachable.
 *
 * A document that fails is left behind rather than marked. It keeps its old
 * `acl_version`, stays in the next claim, and keeps contributing to the lag —
 * which is the behaviour to want, because the alternative is a document that
 * silently stops being retried while the gauge reports everything is fine.
 */
export async function retagOnce(ports: RetagPorts, batch: number, concurrency: number): Promise<RetagResult> {
  if (batch < 1) throw new Error('batch must be at least 1')
  if (concurrency < 1) throw new Error('concurrency must be at least 1')

  const documents = await ports.claim(batch)
  if (documents.length === 0) return { retagged: 0, failed: 0 }

  let retagged = 0
  let failed = 0
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      const document = documents[index]
      if (document === undefined) return

      try {
        // Read the tags and the version together, then write, then mark — the
        // same order ingest uses, and for the same reason. Marking a document
        // at a version whose tags never reached the payload records it as
        // caught up while its points still carry a revoked grant.
        const acl = await ports.tagsFor(document.orgId, document.layerId)
        await ports.retag({
          collection: document.collection,
          documentId: document.documentId,
          aclTags: acl.tags,
          aclVersion: acl.version,
        })
        await ports.markTagged(document.orgId, document.documentId, acl.version)
        retagged++
      } catch (error) {
        failed++
        ports.onError(document, error)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, documents.length) }, worker))
  return { retagged, failed }
}
