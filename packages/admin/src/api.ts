import { NacreClient, NacreError, type ClientOptions } from '@nacre.work/sdk'

/**
 * The client, and where the token lives.
 *
 * `sessionStorage`, not `localStorage`. The token is a bearer credential with
 * no server-side session behind it — there is no login yet, so it cannot be
 * invalidated from anywhere — and `localStorage` would leave it on the machine
 * until something explicitly removed it. Closing the tab should end the
 * session, because that is the only sign-out this build can honestly offer.
 *
 * The API's own origin is the default. An admin UI served from somewhere other
 * than the API is a CORS problem and a cookie problem and, mostly, a decision
 * nobody made on purpose — but a self-hoster running the container behind their
 * own proxy may need it, so it is configurable and stored beside the token.
 */

const TOKEN_KEY = 'nacre.admin.token'
const BASE_KEY = 'nacre.admin.base'

export const readToken = (): string | null => sessionStorage.getItem(TOKEN_KEY)
export const readBase = (): string => sessionStorage.getItem(BASE_KEY) ?? location.origin

export function signIn(token: string, baseUrl: string): void {
  sessionStorage.setItem(TOKEN_KEY, token)
  sessionStorage.setItem(BASE_KEY, baseUrl)
}

export function signOut(): void {
  sessionStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(BASE_KEY)
}

export function client(): NacreClient {
  const token = readToken()
  if (token === null) throw new Error('not signed in')
  const options: ClientOptions = { baseUrl: readBase(), token }
  return new NacreClient(options)
}

/**
 * What to show a person when a call fails.
 *
 * A 404 from this API means "absent, or not yours", and the admin UI must not
 * translate that into "you do not have permission" — the whole point of
 * invariant I4 is that nobody can tell those apart, and a UI that guesses
 * undoes it for anyone reading the screen over a shoulder.
 */
export function explain(error: unknown): string {
  if (error instanceof NacreError) {
    if (error.status === 401) return 'The token is not valid. Sign in again.'
    if (error.status === 404) return 'Not found, or not visible to this token.'
    return `${error.detail} (request ${error.requestId})`
  }
  if (error instanceof Error) return error.message
  return String(error)
}
