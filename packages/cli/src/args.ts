/**
 * Argument parsing, by hand.
 *
 * The same argument the parser and the S3 client make: this is a small,
 * completely specified surface, and a dependency here would be one more thing
 * with a release cadence in a program whose whole job is to be quick to install.
 * `node:util`'s `parseArgs` would do most of it and is deliberately not used —
 * it throws on an unknown option with a message that names neither the command
 * nor what was expected, and the first thing anybody does with a CLI is get an
 * option wrong.
 */

export interface Parsed {
  readonly positional: readonly string[]
  readonly options: ReadonlyMap<string, string | true>
}

export function parse(argv: readonly string[]): Parsed {
  const positional: string[] = []
  const options = new Map<string, string | true>()

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string

    // Everything after `--` is positional, whatever it looks like. A query is
    // the argument most likely to start with a dash.
    if (token === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }

    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }

    const body = token.slice(2)
    const equals = body.indexOf('=')
    if (equals !== -1) {
      options.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }

    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options.set(body, next)
      i += 1
    } else {
      options.set(body, true)
    }
  }

  return { positional, options }
}

/** A flag that was given a value is still a flag; `--json=false` is not. */
export function flag(parsed: Parsed, name: string): boolean {
  const value = parsed.options.get(name)
  return value === true || (typeof value === 'string' && value !== 'false')
}

export function option(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name)
  return typeof value === 'string' ? value : undefined
}

export function integer(parsed: Parsed, name: string): number | undefined {
  const raw = option(parsed, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--${name} takes a positive whole number, not ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Wrong usage, as opposed to a request the server refused.
 *
 * Separate from every other failure because it exits `2` rather than `1`: a
 * script that cannot tell "I called this wrong" from "the document was not
 * found" retries the first one forever.
 */
export class UsageError extends Error {}
