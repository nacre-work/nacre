/**
 * The T1-T40 inventory from docs/authz.md section "Test plan".
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

  // Per-layer ceilings. Implemented and tested before they had a row here, and
  // labelled T26–T28 in the suite — the numbers the skills cases below were
  // then given, so a skills case would have been "covered" by a test about
  // something else. Numbered after the skills cases for that reason, and the
  // coverage suite now refuses a pending case whose marker a test carries.
  { id: 'T36', group: 'delegation', status: 'implemented',
    scenario: 'A narrowing with {read} on L and {write} on M reads L only, writes M only, and the search clause carries L alone' },
  { id: 'T37', group: 'delegation', status: 'implemented',
    scenario: 'A layer in the narrowing with no ceiling of its own inherits the connection\u2019s' },
  { id: 'T38', group: 'delegation', status: 'implemented',
    scenario: 'admin in one layer\u2019s ceiling reaches that layer and never administration of the organization' },

  // ── skills and the administrative surface ──
  // Specified ahead of the code on purpose: written after, they get written to
  // match whatever was built rather than what docs/authz.md asks.
  { id: 'T26', group: 'baseline', status: 'implemented',
    scenario: 'A layer skill on a layer the caller holds no permission on is absent, and answers as a layer with no skill' },
  { id: 'T27', group: 'baseline', status: 'implemented',
    scenario: 'A principal holding only write on a layer sees that layer\u2019s skill' },
  { id: 'T28', group: 'delegation', status: 'implemented',
    scenario: 'A delegation narrowed to L whose person reads L and M lists L\u2019s skill and never M\u2019s' },
  { id: 'T29', group: 'delegation', status: 'implemented',
    scenario: 'Without skill in L\u2019s ceiling a layer admin\u2019s delegation cannot write L\u2019s skill; with it, it can, and still cannot rename, delete or grant' },
  { id: 'T30', group: 'delegation', status: 'implemented',
    scenario: 'skill in L\u2019s ceiling while the person holds only write on L: the skill write is refused' },
  { id: 'T31', group: 'delegation', status: 'pending', blockedBy: 'the administrative MCP is specified in docs/mcp-admin.md and not built yet',
    scenario: 'An administrative-resource token is refused by the API and /mcp, and an ordinary token by /mcp/admin' },
  { id: 'T32', group: 'adversarial', status: 'pending', blockedBy: 'the administrative MCP is specified in docs/mcp-admin.md and not built yet',
    scenario: 'An administrative write called and never applied changes nothing, and the expired proposal is recorded' },
  { id: 'T33', group: 'baseline', status: 'implemented',
    scenario: 'platform_admin never reads an organization\u2019s skill; only that role writes the installation skill' },
  { id: 'T34', group: 'baseline', status: 'implemented',
    scenario: 'An organization\u2019s skill never reaches a caller from another organization, including through instructions' },
  { id: 'T35', group: 'adversarial', status: 'pending', blockedBy: 'the administrative MCP is specified in docs/mcp-admin.md and not built yet',
    scenario: 'A notification to anything but an active user of the caller\u2019s organization is refused before composing' },
  // The catalog is permission data. A delegation narrowed to L used to be
  // listed M — its name, description and document count — on both surfaces,
  // and the MCP catalog built its resolve input by hand with no ceiling in it.
  { id: 'T40', group: 'delegation', status: 'implemented',
    scenario: 'The layer catalog, over REST and MCP alike, lists the narrowing and nothing past the ceiling' },
  // A layer skill is written by a layer's administrator, who has less authority
  // than the org_admin the administrative surface acts for — so a layer skill
  // followed there is an escalation written in prose.
  { id: 'T39', group: 'adversarial', status: 'pending', blockedBy: 'the administrative MCP is specified in docs/mcp-admin.md and not built yet',
    scenario: 'The administrative surface\u2019s instructions carry no skill, and a skill read through it is marked as text under review, never guidance' },
]

export const pending = (): readonly TestCase[] =>
  TEST_PLAN.filter((t) => t.status === 'pending')
