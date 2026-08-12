import { NacreClient } from '@nacre.work/sdk'

import { parse, UsageError } from './args.js'
import { ask, evaluate, grant, ingest, layers, login, search, whoami, type Context } from './commands.js'
import { saveSession, type Session } from './config.js'

export const HELP = `nacre — the command line client for a Nacre installation

  nacre login --url <https://api.example>   sign in, and remember the session
  nacre whoami                              which principal this session is
  nacre layers                              layers you can read
  nacre layers create <slug> [--name ...]   create one  [--workspace <slug>]
  nacre grant <permission> <scope> --to <principal>
  nacre ingest <file|dir>... --layer <slug> index text files, and wait for them
  nacre search <query> [--layer <slug>] [--top-k <n>]
  nacre eval --layer <slug> [--top-k <n>] [--floor <0..1>]
                                            score the layer's reference queries

  --json      print the response as JSON, for a script rather than a person
  --help      this

A scope is layer:<slug>, workspace:<slug> or document:<id>. A principal is
user:<id>, group:<id> or service_account:<id>.

NACRE_API_URL and NACRE_TOKEN override the stored session, which is what a
service account in CI uses — there is no terminal there to log in from.

Permissions are not a ladder: write does not imply read, and admin implies both.
An ingest-only service account holds write and cannot search back what it wrote.
`

const COMMANDS: Record<string, (context: Context) => Promise<Outcome>> = {
  login,
  whoami,
  layers,
  grant,
  ingest,
  search,
  eval: evaluate,
}

/**
 * What a command hands back: text when it worked, or text and a code when it
 * partly did. Ingest is the only one that needs the second form today.
 */
export type Outcome = string | { readonly output: string; readonly code: number }

export interface Result {
  readonly output: string
  readonly code: number
  /** Print on stdout despite a non-zero code — the output is still the answer. */
  readonly stdout?: boolean
}

/**
 * One command, returning what to print and the code to exit with.
 *
 * Split from the entry point so the whole surface is testable without spawning
 * a process: everything the program touches that is not the network arrives
 * through `Context`.
 */
export async function run(
  argv: readonly string[],
  overrides: Partial<Context> = {},
): Promise<Result> {
  const parsed = parse(argv)
  const name = parsed.positional[0]

  if (name === undefined || name === 'help' || parsed.options.has('help')) {
    // Help is a success when it was asked for and a usage error when it is the
    // answer to a command nobody named — a script piping `nacre` with no
    // arguments must not read exit 0 as "it worked".
    return { output: HELP, code: name === undefined && !parsed.options.has('help') ? 2 : 0 }
  }

  const command = COMMANDS[name]
  if (command === undefined) {
    return { output: `Unknown command ${JSON.stringify(name)}.\n\n${HELP}`, code: 2 }
  }

  const context: Context = {
    parsed,
    env: process.env,
    prompt: ask,
    clientFor: defaultClient,
    ...overrides,
  }

  try {
    const outcome = await command(context)
    return typeof outcome === 'string'
      ? { output: outcome, code: 0 }
      : // A command that partly worked reports on **stdout** and still exits
        // non-zero. Ingest is the one: a directory where every document failed
        // is not a success, and a script reading exit 0 there is the "reported
        // success having done nothing" failure this repository keeps finding —
        // but the per-document summary is the answer, so `--json | jq` has to
        // keep working while the code says not everything landed.
        { output: outcome.output, code: outcome.code, stdout: true }
  } catch (error) {
    // Two codes, and the difference is whose fault it is: `2` means this
    // invocation was wrong and repeating it will fail the same way, `1` means
    // the request was refused or the network was. A script that cannot tell
    // them apart retries the first one forever.
    const code = error instanceof UsageError ? 2 : 1
    return { output: error instanceof Error ? error.message : String(error), code }
  }
}

function defaultClient(session: Session): NacreClient {
  return new NacreClient({
    baseUrl: session.baseUrl,
    token: session.token,
    ...(session.refreshToken === undefined ? {} : { refreshToken: session.refreshToken }),
    // The session renews itself and the renewal has to be written down, or the
    // next invocation is a fresh process holding the token that just expired.
    // This is the whole reason the CLI keeps a file rather than an env var.
    onTokens: (tokens) => {
      saveSession({
        baseUrl: session.baseUrl,
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      })
    },
  })
}
