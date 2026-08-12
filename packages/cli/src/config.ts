import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where the CLI keeps an endpoint and a session.
 *
 * On disk rather than in the environment, because the alternative is what the
 * quickstart used to ask for: a token pasted into a shell, which ends up in a
 * history file with no expiry and no way to tell it was ever there. The
 * environment still wins when it is set — that is what CI uses, and a variable
 * a process was handed is not a variable this program wrote down.
 */

export interface Session {
  readonly baseUrl: string
  readonly token: string
  readonly refreshToken?: string
}

interface Stored {
  baseUrl?: string
  token?: string
  refreshToken?: string
}

/** `$XDG_CONFIG_HOME/nacre/config.json`, or the usual place under `$HOME`. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg !== undefined && xdg !== '' ? xdg : join(env.HOME ?? homedir(), '.config')
  return join(base, 'nacre', 'config.json')
}

function readStored(path: string): Stored {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Stored) : {}
  } catch {
    // A missing file is the ordinary case on a first run, and an unreadable or
    // corrupt one is not worth failing a `search` over — `login` rewrites it.
    return {}
  }
}

/**
 * The session to use, from the environment first and the file second.
 *
 * Returns `undefined` rather than throwing so a command can say what to do
 * about it. There is exactly one message for this and it names both ways in,
 * because an operator reaching for the CLI in CI wants the variables and one on
 * a laptop wants `nacre login`.
 */
export function loadSession(env: NodeJS.ProcessEnv = process.env): Session | undefined {
  const stored = readStored(configPath(env))

  const baseUrl = env.NACRE_API_URL ?? stored.baseUrl
  const token = env.NACRE_TOKEN ?? stored.token
  if (baseUrl === undefined || baseUrl === '' || token === undefined || token === '') return undefined

  // Only from the file. A refresh token in the environment beside an access
  // token would be a second credential to leak for a session the environment
  // cannot renew anyway — nothing here would have anywhere to write the new one.
  const refreshToken = env.NACRE_TOKEN === undefined ? stored.refreshToken : undefined

  return { baseUrl, token, ...(refreshToken === undefined ? {} : { refreshToken }) }
}

/**
 * Write the session, readable by nobody else.
 *
 * `0600` on the file **and** `0700` on the directory, set explicitly rather
 * than left to the umask: this holds a refresh token, and a refresh token is a
 * session that renews itself, so it outlives the access token beside it by as
 * long as the deployment allows. A default umask of `022` would leave it world
 * readable on a shared machine, which is the one place a CLI config actually
 * gets read by somebody else.
 */
export function saveSession(session: Session, env: NodeJS.ProcessEnv = process.env): string {
  const path = configPath(env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  // mkdirSync's mode is ignored when the directory already exists, and
  // writeFileSync's is ignored when the file does — so neither call above is
  // enough on its own for the second run, which is the run that matters.
  chmodSync(dirname(path), 0o700)
  chmodSync(path, 0o600)
  return path
}

/** Forget the session. Not a sign-out — that revokes, and this only forgets. */
export function clearSession(env: NodeJS.ProcessEnv = process.env): void {
  const path = configPath(env)
  const stored = readStored(path)
  if (stored.baseUrl === undefined) return
  saveSession({ baseUrl: stored.baseUrl, token: '' }, env)
}
