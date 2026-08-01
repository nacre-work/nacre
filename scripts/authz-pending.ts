/**
 * Prints what the T1-T15 suite does not yet cover.
 *
 * Run as its own step in the acl-invariants workflow. The same list exists as a
 * test, but vitest does not surface console output on a passing run, and a gap
 * nobody sees is a gap nobody closes — the point of this file is that the CI
 * log says "incomplete" on every single green run.
 */
import { TEST_PLAN, pending } from '../packages/core/authz/test-plan.js'

// `pnpm authz:pending | head` closes the pipe early, and Node turns that into
// an unhandled EPIPE that looks like a crash in the report itself.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EPIPE') throw e
})

const outstanding = pending()
const done = TEST_PLAN.length - outstanding.length

console.log(`authz test plan: ${done}/${TEST_PLAN.length} implemented\n`)

if (outstanding.length === 0) {
  console.log('  all cases implemented')
} else {
  for (const t of outstanding) {
    console.log(`  ${t.id}  [${t.group}]  ${t.scenario}`)
    console.log(`        waiting on: ${t.blockedBy}\n`)
  }
  console.log(
    'These block the release the specification describes. Until they run,\n' +
      'this job is not evidence that the access-control invariants hold.',
  )
}
