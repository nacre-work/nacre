import { readFileSync } from 'node:fs'

/**
 * This release's version, read from the package's own manifest.
 *
 * Every package in the workspace carries the same one — `lint:publish` holds
 * them together — so the core's manifest answers for the API and both MCP
 * transports alike. It lived in `packages/mcp` until the API needed it too, and
 * a second copy would be two answers to a question with one.
 *
 * A function rather than a constant: a file read at import time is the shape
 * that threw ENOENT from the built package once already, and nothing here runs
 * until somebody calls it.
 *
 * It degrades rather than refusing. An unreadable manifest is a wrong string in
 * a client's server list; it is not a reason for the process to fail to start.
 */
export function packageVersion(): string {
  try {
    const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const version = (JSON.parse(manifest) as { version?: unknown }).version
    return typeof version === 'string' ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
