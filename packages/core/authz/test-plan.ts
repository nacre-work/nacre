/**
 * The T1-T15 inventory from docs/authz.md section "Test plan".
 *
 * This exists so the gap between "the suite the specification requires" and
 * "the suite that runs today" is a checked fact rather than a memory. A test
 * asserts that every entry marked `implemented` has a test carrying its
 * marker, and that no number went missing — so a case cannot be quietly
 * dropped, and a case cannot be quietly claimed either.
 *
 * `pending` means the test needs something that does not exist yet — the
 * vector store, the HTTP surface, a running index. It does not mean optional.
 * Every one of them blocks the release the specification describes, and this
 * file is the list of what is still owed.
 */
export type TestStatus = 'implemented' | 'pending'

export interface TestCase {
  readonly id: `T${number}`
  readonly group: 'baseline' | 'saturation' | 'adversarial'
  readonly scenario: string
  readonly status: TestStatus
  /** Why it cannot run yet. Required for `pending`, absent otherwise. */
  readonly blockedBy?: string
}

export const TEST_PLAN: readonly TestCase[] = [
  // ── baseline ──
  { id: 'T1', group: 'baseline', status: 'implemented',
    scenario: 'A user of org A searches with an org A token against an index holding org B documents' },
  { id: 'T2', group: 'baseline', status: 'pending',
    blockedBy: 'HTTP surface: the org_id must be rejected in the request body, which needs a request',
    scenario: 'An org A token with org_id swapped to org B in the request body' },
  { id: 'T3', group: 'baseline', status: 'implemented',
    scenario: 'read on a workspace, deny read on one layer' },
  { id: 'T4', group: 'baseline', status: 'implemented',
    scenario: 'write without read' },
  { id: 'T5', group: 'baseline', status: 'implemented',
    scenario: 'read on one document, nothing on its layer' },
  { id: 'T6', group: 'baseline', status: 'implemented',
    scenario: 'A user is removed from a group' },
  { id: 'T7', group: 'baseline', status: 'implemented',
    scenario: 'A deleted document is excluded before garbage collection' },
  { id: 'T8', group: 'baseline', status: 'pending',
    blockedBy: 'HTTP surface: 404-not-403 is a property of the response, not of the plan',
    scenario: 'A direct request for another org’s document_id' },

  // ── saturation ──
  // These are the ones that catch a post-filter: an implementation that filters
  // after ranking passes every baseline case and fails both of these.
  { id: 'T9', group: 'saturation', status: 'pending',
    blockedBy: 'Qdrant: result counts are a property of the index traversal',
    scenario: '20 layers, access to 1, top_k=10 returns exactly 10' },
  { id: 'T10', group: 'saturation', status: 'pending',
    blockedBy: 'Qdrant: as above',
    scenario: 'The accessible layer holds 5 documents, top_k=10 returns 5 with no topping up' },

  // ── adversarial ──
  { id: 'T11', group: 'adversarial', status: 'pending',
    blockedBy: 'Redis and the propagation job',
    scenario: 'A group changes while 1000 queries run concurrently' },
  { id: 'T12', group: 'adversarial', status: 'pending',
    blockedBy: 'Qdrant and the reindex pipeline',
    scenario: 'A layer is reindexed during active search' },
  { id: 'T13', group: 'adversarial', status: 'implemented',
    scenario: 'A grant issued and revoked in one transaction' },
  { id: 'T14', group: 'adversarial', status: 'implemented',
    scenario: 'Cyclic group nesting (A ⊂ B ⊂ A)' },
  { id: 'T15', group: 'adversarial', status: 'implemented',
    scenario: '10 000 principals in the filter' },
]

export const pending = (): readonly TestCase[] =>
  TEST_PLAN.filter((t) => t.status === 'pending')
