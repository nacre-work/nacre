/**
 * The T1-T25 inventory from docs/authz.md section "Test plan".
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
  readonly group: 'baseline' | 'saturation' | 'adversarial' | 'delegation'
  readonly scenario: string
  readonly status: TestStatus
  /** Why it cannot run yet. Required for `pending`, absent otherwise. */
  readonly blockedBy?: string
}

export const TEST_PLAN: readonly TestCase[] = [
  // ── baseline ──
  { id: 'T1', group: 'baseline', status: 'implemented',
    scenario: 'A user of org A searches with an org A token against an index holding org B documents' },
  { id: 'T2', group: 'baseline', status: 'implemented',
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
  { id: 'T8', group: 'baseline', status: 'implemented',
    scenario: 'A direct request for another org’s document_id' },

  // ── saturation ──
  // These are the ones that catch a post-filter: an implementation that filters
  // after ranking passes every baseline case and fails both of these.
  { id: 'T9', group: 'saturation', status: 'implemented',
    scenario: '20 layers, access to 1, top_k=10 returns exactly 10' },
  { id: 'T10', group: 'saturation', status: 'implemented',
    scenario: 'The accessible layer holds 5 documents, top_k=10 returns 5 with no topping up' },

  // ── adversarial ──
  { id: 'T11', group: 'adversarial', status: 'implemented',
    scenario: 'A group changes while 1000 queries run concurrently' },
  { id: 'T12', group: 'adversarial', status: 'implemented',
    scenario: 'A layer is reindexed during active search' },
  { id: 'T13', group: 'adversarial', status: 'implemented',
    scenario: 'A grant issued and revoked in one transaction' },
  { id: 'T14', group: 'adversarial', status: 'implemented',
    scenario: 'Cyclic group nesting (A ⊂ B ⊂ A)' },
  { id: 'T15', group: 'adversarial', status: 'implemented',
    scenario: '10 000 principals in the filter' },

  // ── delegation ──
  // A delegation adds a filter clause and an authentication check, so it can
  // fail in both of the ways this plan already guards against plus one of its
  // own. Written before the implementation, deliberately: a test written after
  // the code it covers gets written to match what was built.
  { id: 'T16', group: 'delegation', status: 'implemented',
    scenario: 'A delegation resolves exactly what its user resolves — across two layers, a document-scoped grant and one deny' },
  { id: 'T17', group: 'delegation', status: 'implemented',
    scenario: 'A grant revoked from the user is gone from a live delegation on the next request, with no renewal between' },
  { id: 'T18', group: 'delegation', status: 'implemented',
    scenario: 'Disabling the user suspends every delegation with 401; re-enabling restores them, the grant untouched throughout' },
  { id: 'T19', group: 'delegation', status: 'implemented',
    scenario: 'Forgetting the application stops that delegation while the user’s own token keeps working' },
  { id: 'T20', group: 'delegation', status: 'implemented',
    scenario: 'A delegation narrowed to layer L returns nothing from layer M its user also reads, and never more from L than the user would' },
  { id: 'T21', group: 'delegation', status: 'implemented',
    scenario: 'platform_admin is refused at consent, and a token minted around consent is refused at validation' },
  // The one a naive implementation passes everywhere else: a narrowing applied
  // to the result set instead of to the query returns fewer than top_k and
  // reads as "there were only that many". T9's argument, aimed at the new
  // clause.
  { id: 'T22', group: 'delegation', status: 'implemented',
    scenario: '20 layers, the user reads 1, the delegation narrowed to that 1, top_k=10 returns exactly 10' },

  // The permission ceiling. A set rather than a level, because rule 6 makes
  // permissions unordered — and T24 is the case that would be lost by
  // modelling it as one.
  { id: 'T23', group: 'delegation', status: 'implemented',
    scenario: 'A ceiling of {read} whose person holds write: reads, and every write path answers as it would for a principal with no write' },
  { id: 'T24', group: 'delegation', status: 'implemented',
    scenario: 'A ceiling of {write} whose person holds both: ingests, and search returns empty — rule 6 inherited rather than collapsed' },
  // The one a half-built ceiling passes: bound documents and not
  // administration, and a read-only delegation can still mint a key.
  { id: 'T25', group: 'delegation', status: 'implemented',
    scenario: 'An org_admin with a {read} ceiling reads the whole organization and every org_admin-gated endpoint refuses' },
]

export const pending = (): readonly TestCase[] =>
  TEST_PLAN.filter((t) => t.status === 'pending')
