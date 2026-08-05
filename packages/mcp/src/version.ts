import { readFileSync } from 'node:fs'

/**
 * What `initialize` and `server/discover` report as the server's version.
 *
 * A function rather than a constant, and read from the entry points rather than
 * from `server.ts`: that module is imported by the tests and by both transports,
 * and a file read at import time is the shape that threw ENOENT from the built
 * package once already. Nothing here runs until somebody calls it.
 *
 * It degrades rather than refusing. An unreadable manifest is a wrong string in
 * a client's server list; it is not a reason for the process to fail to start.
 *
 * Both transports reported `0.0.0` on every connection until this went in,
 * because `serverVersion` was optional and neither entry point passed one — a
 * field that was carried, threaded through an option, and never given a value.
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
