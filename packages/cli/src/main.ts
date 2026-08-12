#!/usr/bin/env node
/**
 * The `nacre` entry point.
 *
 * Everything that decides anything is in `run.ts`; this is the shell around it,
 * and it is thin on purpose — a program whose logic lives in its entry point is
 * a program whose logic is tested by spawning it.
 */
import { run } from './run.js'

const { output, code, stdout } = await run(process.argv.slice(2))

// Diagnostics to stderr, the answer to stdout. `nacre search q --json | jq`
// has to work, and it cannot if a refusal is printed into the same stream as
// the results.
//
// `stdout` is the third case: a command that partly worked, where the output is
// still the answer and the code still has to say so. An ingest of a hundred
// files with two failures is that, and putting its summary on stderr would make
// the failure unreadable to the script that has to act on it.
if (code === 0 || stdout === true) {
  if (output !== '') process.stdout.write(`${output}\n`)
} else {
  process.stderr.write(`${output}\n`)
}

process.exitCode = code
