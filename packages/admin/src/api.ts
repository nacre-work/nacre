import { NacreClient, NacreError, type ClientOptions } from '@nacre.work/sdk'

/**
 * The client, and where the session lives.
 *
 * Two ways in, because there are two kinds of credential and neither replaces
 * the other:
 *
 * - **Email and password.** What a person has. Produces an access token and a
 *   refresh token, and the session outlives the access token's fifteen minutes
 *   because this file renews it — see `renewingFetch`.
 * - **A pasted token.** What `init` prints, and what a service account key is.
 *   Neither has a refresh token, so such a session ends when the credential
 *   does. Kept rather than replaced: signing in *as* a service account is how
 *   an administrator checks what an agent can actually see, which is a question
 *   this UI should be able to answer.
 *
 * `sessionStorage`, not `localStorage`, and a refresh token makes that argument
 * stronger rather than weaker — it is the longer-lived of the two credentials
 * here, so leaving it on the machine until something explicitly removed it is
 * the direction not to go. Closing the tab ends the session, and `signOut` now
 * also revokes it on the server, which is the part that was not possible when
 * the only credential was a JWT with nothing behind it.
 *
 * The API's own origin is the default. An admin UI served from somewhere other
 * than the API is a CORS problem and a cookie problem and, mostly, a decision
 * nobody made on purpose — but a self-hoster running the container behind their
 * own proxy may need it, so it is configurable and stored beside the token.
 */

const TOKEN_KEY = 'nacre.admin.token'
const REFRESH_KEY = 'nacre.admin.refresh'
const BASE_KEY = 'nacre.admin.base'

export const readToken = (): string | null => sessionStorage.getItem(TOKEN_KEY)
export const readBase = (): string => sessionStorage.getItem(BASE_KEY) ?? location.origin

/**
 * Called when a session ends underneath the UI — the refresh token was spent,
 * replayed, or revoked, and there is nothing left to renew with.
 *
 * A callback rather than a redirect from in here: this module knows the session
 * is over, and `index.ts` knows what to put on the screen.
 */
let onSessionEnded: () => void = () => undefined
export const whenSessionEnds = (fn: () => void): void => {
  onSessionEnded = fn
}

/** A pasted credential: `init`'s JWT, or a `nacre_sk_` service account key. */
export function signInWithToken(token: string, baseUrl: string): void {
  sessionStorage.setItem(TOKEN_KEY, token)
  // Explicitly removed rather than left alone. Switching from a password
  // session to a pasted token must not leave the previous session's refresh
  // token behind to renew a credential this one did not come from.
  sessionStorage.removeItem(REFRESH_KEY)
  sessionStorage.setItem(BASE_KEY, baseUrl)
}

/**
 * Email and password.
 *
 * `false` for a refusal, and there is exactly one refusal: the server answers a
 * single `401` with a single message for an unknown address, a wrong password,
 * a wrong organization, a disabled account and an account with no password set
 * — in the same time. A screen that distinguished them would hand back the
 * information the API is careful not to give.
 */
/**
 * Whether this installation offers a recovery link at all.
 *
 * Asked before the sign-in screen draws, so the link is **absent** rather than
 * present-and-failing where no sender is configured. A control that answers
 * "email is not configured" reads as a broken application and tells an
 * unauthenticated stranger about the deployment besides.
 *
 * A deployment this cannot reach answers `false`: an unreachable API is a
 * screen with nothing on it either way, and guessing `true` would put a link
 * there that cannot work.
 */
export async function signInMethods(baseUrl: string): Promise<{ passwordReset: boolean }> {
  try {
    const bare = new NacreClient({ baseUrl, token: 'unauthenticated' })
    return await bare.auth.methods()
  } catch {
    return { passwordReset: false }
  }
}

/** Ask for a link. Resolves the same whether or not the address has an account. */
export async function requestPasswordReset(baseUrl: string, email: string): Promise<void> {
  const bare = new NacreClient({ baseUrl, token: 'unauthenticated' })
  await bare.auth.requestPasswordReset(email)
}

/** Spend a link. `false` for one that never existed, was spent, or expired. */
export async function confirmPasswordReset(
  baseUrl: string,
  token: string,
  password: string,
): Promise<boolean> {
  const bare = new NacreClient({ baseUrl, token: 'unauthenticated' })
  return bare.auth.confirmPasswordReset(token, password)
}

/** A challenge to answer, when the password alone was not the whole sign-in. */
export interface SecondFactorPending {
  readonly challenge: string
  readonly baseUrl: string
}

export async function signInWithPassword(input: {
  email: string
  password: string
  organization?: string
  baseUrl: string
}): Promise<boolean | SecondFactorPending> {
  // A bare client on the plain `fetch`: there is nothing to renew with yet, and
  // pointing the renewing one at the sign-in call is a loop waiting to happen.
  const bare = new NacreClient({ baseUrl: input.baseUrl, token: 'unauthenticated' })
  const tokens = await bare.auth.login({
    email: input.email,
    password: input.password,
    ...(input.organization === undefined || input.organization === ''
      ? {}
      : { organization: input.organization }),
  })
  if (tokens === undefined) return false

  /*
   * A correct password is not always a session.
   *
   * Where the account has a second factor the server answers with a challenge,
   * and the caller is being asked for the rest rather than refused. Returned
   * rather than handled here: this function has no screen to ask on, and the
   * sign-in view is what owns the second field.
   */
  if ('secondFactorRequired' in tokens) {
    return { challenge: tokens.challenge, baseUrl: input.baseUrl }
  }

  keep(tokens, input.baseUrl)
  return true
}

/**
 * The second half, once a person has typed what their authenticator shows.
 *
 * The challenge is what carries identity across the two calls, so nothing about
 * the password is kept in the browser between them.
 */
export async function signInSecondFactor(input: {
  challenge: string
  code: string
  baseUrl: string
}): Promise<boolean> {
  const bare = new NacreClient({ baseUrl: input.baseUrl, token: 'unauthenticated' })
  const tokens = await bare.auth.secondFactor({ challenge: input.challenge, code: input.code })
  if (tokens === undefined) return false
  keep(tokens, input.baseUrl)
  return true
}

function keep(tokens: { accessToken: string; refreshToken: string }, baseUrl: string): void {
  sessionStorage.setItem(TOKEN_KEY, tokens.accessToken)
  sessionStorage.setItem(REFRESH_KEY, tokens.refreshToken)
  sessionStorage.setItem(BASE_KEY, baseUrl)
}

/** Forget the session in this browser. Reaches nothing; see `signOut`. */
function forget(): void {
  sessionStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(REFRESH_KEY)
  sessionStorage.removeItem(BASE_KEY)
}

/**
 * End the session, on the server as well as here.
 *
 * Best effort, and the local half happens first and regardless: someone who
 * clicked "sign out" gets a signed-out browser whether or not the API is
 * reachable. Keeping the token because a request failed would be the worst of
 * both.
 */
export async function signOut(): Promise<void> {
  const refresh = sessionStorage.getItem(REFRESH_KEY)
  const base = readBase()
  forget()

  if (refresh === null) return
  try {
    await new NacreClient({ baseUrl: base, token: 'unauthenticated' }).auth.logout(refresh)
  } catch {
    // The session is over here either way and the refresh token expires on its
    // own. Reporting this would be telling someone about a failure in something
    // they have, from their side, already finished.
  }
}

/**
 * A `fetch` that renews the access token once, when the API says it is spent.
 *
 * Reactive rather than a timer. A timer has to guess the clock skew between
 * this browser and the API and it fires whether or not anyone is using the
 * page; a `401` is the API stating the fact directly.
 *
 * This is the SDK's own seam — `ClientOptions.fetch` — rather than a wrapper
 * around fourteen call sites, so no view has to know a session can be renewed.
 * The client deliberately does not swap its own credential (see its note on
 * why), which is exactly the reason the swap belongs out here.
 *
 * The renewal itself goes through the plain `fetch`, never this one: a `401`
 * from the refresh endpoint must not trigger another refresh.
 */
function renewingFetch(): typeof globalThis.fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const first = await globalThis.fetch(url, init)
    if (first.status !== 401) return first

    const refresh = sessionStorage.getItem(REFRESH_KEY)
    // A pasted token has no refresh token, so its 401 is the end of the road
    // and the caller should see it. There is only ever one retry: the second
    // attempt returns whatever it gets.
    if (refresh === null) return first

    let renewed: { accessToken: string; refreshToken: string } | undefined
    try {
      renewed = await new NacreClient({
        baseUrl: readBase(),
        token: 'unauthenticated',
      }).auth.refresh(refresh)
    } catch {
      renewed = undefined
    }

    if (renewed === undefined) {
      // Spent, replayed, or revoked — replaying one revokes the whole family by
      // design, so there is nothing left to retry with. Putting the sign-in
      // screen back is more honest than letting every subsequent call fail on
      // its own with a message about a token.
      forget()
      onSessionEnded()
      return first
    }

    sessionStorage.setItem(TOKEN_KEY, renewed.accessToken)
    sessionStorage.setItem(REFRESH_KEY, renewed.refreshToken)

    const headers = new Headers(init?.headers as HeadersInit | undefined)
    headers.set('authorization', `Bearer ${renewed.accessToken}`)
    return globalThis.fetch(url, { ...init, headers })
  }) as typeof globalThis.fetch
}

export function client(): NacreClient {
  const token = readToken()
  if (token === null) throw new Error('not signed in')
  const options: ClientOptions = { baseUrl: readBase(), token, fetch: renewingFetch() }
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
    if (error.status === 401) return 'This session has ended. Sign in again.'
    if (error.status === 404) return 'Not found, or not visible to this token.'
    return `${error.detail} (request ${error.requestId})`
  }
  if (error instanceof Error) return error.message
  return String(error)
}
