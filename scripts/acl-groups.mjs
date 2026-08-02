/**
 * The groups the acl-invariants workflow runs, in one place.
 *
 * The workflow runs each of these as its own step so a leak reads as "T3
 * failed" in the checks list rather than as one number among a hundred. That
 * split has a failure mode of its own: the selectors are literal, so a test
 * whose describe block matches none of them **never runs in CI at all** — and
 * the job is green, because every step it did run passed.
 *
 * That had already happened twice. `coverage.test.ts` ("test plan coverage")
 * and `permissions.test.ts` ("permission implication") — rule 6, the one
 * invariant most likely to be "fixed" by someone who thinks it is a typo — were
 * both invisible to the gate that exists to protect them.
 *
 * `check-acl-groups.mjs` now asserts every test in the project matches
 * something here, so adding a file with a new describe name fails the build
 * instead of quietly opting out of the gate.
 */
export const ACL_GROUPS = [
  { selector: 'baseline', title: 'T1-T8 · baseline' },
  { selector: 'saturation', title: 'T9-T10 · result saturation' },
  { selector: 'truth table', title: 'truth table · docs/authz.md 3.2' },
  { selector: 'adversarial', title: 'T11-T15 · adversarial' },
  {
    selector: 'pipeline round trip',
    title: 'round trip · the worker and the search path agree',
  },
  // Not a T-case. It asserts that every case docs/authz.md names has a test,
  // which makes it the one that notices when the others stop being enough.
  { selector: 'test plan coverage', title: 'coverage · every case in docs/authz.md has a test' },
  // Rule 6 — write does not imply read, admin implies both. It is the opposite
  // of most permission systems, so it is the rule someone eventually corrects.
  { selector: 'permission implication', title: 'rule 6 · write does not imply read' },
  { selector: 'I5 · the delete path', title: 'I5 · a deleted document leaves the index' },
]

/** The property run is its own step with its own run count; not a group. */
export const UNGROUPED = ['property · resolve agrees with the reference implementation']
