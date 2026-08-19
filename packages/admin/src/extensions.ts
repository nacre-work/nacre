import { NacreError } from '@nacre.work/sdk'

import { authorizedFetch, readBase, explain } from './api.js'
import { ago, agoCell, chip, clear, copyControl, copyableId, copyText, h, icon, shortId } from './dom.js'
import { picker } from './pick.js'

/**
 * How a commercial module puts a screen in this console.
 *
 * ## Why there is a seam here at all
 *
 * `packages/admin` is the community console and it is deliberately
 * single-organization: every screen it draws is behind `administers(auth)`,
 * which is `org_admin` and nothing else. The commercial modules mount routes
 * under `/v1/admin/*` — organizations, tenancy, the installation's default
 * embedding model — and until this file there was no screen for any of them, on
 * either side of the boundary. A customer who bought multi-tenancy administered
 * it with `curl`, which is the shape the open core keeps closing arriving in
 * the paid half.
 *
 * Three ways to close it were possible and two of them are wrong.
 *
 * The core could grow those screens and hide them behind a probe. That puts
 * commercial UI in the open repository, which devalues both halves — and the
 * `boundary` job would not catch it, because it looks for a package name.
 *
 * The other repository could ship a console of its own. That means a second
 * copy of `admin.css`, of `dom.ts`, of `pick.ts` and of every layout rule this
 * console has learned by rendering itself in a browser — with nothing that
 * knows there are two, across a repository boundary where no check can see both
 * sides. It is this codebase's most repeated defect, at the largest scale it has
 * been available in.
 *
 * So the console is the host and an extension is a **file**, exactly the way
 * `NACRE_MODULES` makes the API one. `nacre-enterprise-web` is built `FROM` the
 * open `web` image and replaces one file in it.
 *
 * ## The contract is a function, not an import
 *
 * An extension is handed everything it may use, rather than importing it. That
 * is what makes it possible without publishing a package: nothing in the
 * extension's own bundle resolves `@nacre.work/*`, so there is no second copy of
 * anything and no npm name to own. It is also what makes the surface countable
 * — `ConsoleKit` is the whole of it, and a helper that is not on this object is
 * not part of the contract.
 *
 * `CONTRACT` is the version of that object. An extension declares which one it
 * was built against and a mismatch is **said out loud** rather than swallowed:
 * a console that quietly drops the screens somebody paid for is the "hiding
 * what the server allows" defect, arriving through a version number.
 */

/**
 * Bumped when `ConsoleKit` changes in a way an extension can notice.
 *
 * Additive counts. An extension built against 2 and loaded by a host at 1 finds
 * `undefined` where it expected a helper, which is a screen that draws nothing
 * with an error in nobody's log — the failure this number exists to turn into a
 * sentence. So the rule is not "breaking changes only".
 *
 * **2** — `copyControl`. Added because the first screen written against this
 * contract was one that hands a generated password over once, and the kit could
 * not build the control for it: `copyText` is the primitive, and assembling a
 * button around it is a second control with the same job, which `copyControl`'s
 * own header says is how one of them gets the clipboard fallback, the checkmark
 * timing or the accessible name wrong. Found by rendering that screen and
 * reading the picture — the value came out truncated with no visible control
 * beside it, which is this console's own 0.17 defect in a new repository.
 */
export const CONTRACT = 2

/** What an extension is handed. Everything it may use, and nothing else. */
export interface ConsoleKit {
  readonly contract: number
  /** Build an element. Text goes through `textContent`, never `innerHTML`. */
  readonly h: typeof h
  readonly clear: typeof clear
  readonly icon: typeof icon
  readonly ago: typeof ago
  readonly agoCell: typeof agoCell
  readonly chip: typeof chip
  readonly shortId: typeof shortId
  readonly copyableId: typeof copyableId
  readonly copyText: typeof copyText
  /**
   * The control that takes a value, for a value shown once.
   *
   * Not assembled from `copyText` by a caller. Two controls with the same job
   * is how one of them gets the clipboard fallback wrong — `navigator.clipboard`
   * exists only in a secure context and a self-hosted console is very often not
   * one — or the checkmark timing, or the accessible name, which this one
   * changes on both success and failure.
   */
  readonly copyControl: typeof copyControl
  /** Choose a thing the caller can already see. Never a field asking for a uuid. */
  readonly picker: typeof picker
  /** What to show a person when a call fails. Never turns a 404 into "forbidden". */
  readonly explain: typeof explain
  /**
   * One authorized request against the API this console is signed in to.
   *
   * Renewing, so a screen open across an access token's fifteen minutes does
   * not have to know that. Rejects with a `NacreError` carrying the problem
   * document, which is what `explain` reads — an extension that invented its
   * own error shape would be a second answer about what a failure looks like.
   */
  readonly request: (init: {
    method: string
    path: string
    body?: unknown
  }) => Promise<unknown>
}

/** Who the person signed in is, as the server answered rather than as derived. */
export interface ConsoleViewer {
  /** `GET /v1/me`'s `administers` — this token administers **this** organization. */
  readonly administers: boolean
  /** `administersTenants(auth)` in the API: the role, which has no ceiling question. */
  readonly platformAdmin: boolean
}

/** One screen. The same shape the console's own routes have. */
export interface ConsoleView {
  /** `#/organizations`. Must begin `#/` and must not collide with a core route. */
  readonly hash: string
  readonly label: string
  /** Whether to offer it at all, from what the server said. */
  readonly shows: (viewer: ConsoleViewer) => boolean
  readonly render: (root: HTMLElement, viewer: ConsoleViewer) => void
}

/** What an extension's default export returns. */
export interface ConsoleExtension {
  /** The `CONTRACT` this extension was built against. */
  readonly contract: number
  readonly views: readonly ConsoleView[]
}

/** The result of trying to load one. A refusal is a value, not an exception. */
export type Extensions =
  | { readonly ok: true; readonly views: readonly ConsoleView[] }
  | { readonly ok: false; readonly reason: string }

const KIT: ConsoleKit = {
  contract: CONTRACT,
  h,
  clear,
  icon,
  ago,
  agoCell,
  chip,
  shortId,
  copyableId,
  copyText,
  copyControl,
  picker,
  explain,
  request: async ({ method, path, body }) => {
    const response = await authorizedFetch()(`${readBase()}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    if (!response.ok) {
      // The server's own problem document, or a stand-in with the same fields.
      // A response that is not `application/problem+json` still has to become a
      // `NacreError`, or `explain` would fall through to `String(error)` and
      // put a raw body on the screen.
      let problem: unknown
      try {
        problem = await response.json()
      } catch {
        problem = undefined
      }
      const fields = (problem ?? {}) as Record<string, unknown>
      throw new NacreError({
        type: typeof fields.type === 'string' ? fields.type : 'about:blank',
        title: typeof fields.title === 'string' ? fields.title : response.statusText,
        status: response.status,
        detail: typeof fields.detail === 'string' ? fields.detail : `${method} ${path} failed.`,
        instance: typeof fields.instance === 'string' ? fields.instance : path,
        request_id: typeof fields.request_id === 'string' ? fields.request_id : '',
      })
    }

    if (response.status === 204) return undefined
    return await response.json()
  },
}

/**
 * Load the extension file, if the image this console came in has a real one.
 *
 * The specifier is built at run time on purpose. A literal would be resolved by
 * the bundler and inlined, which is the opposite of the point — the file has to
 * be a *separate* one so an image built `FROM` this one can replace it. A
 * bare specifier would need an import map, which `script-src 'self'` refuses,
 * and that is a mistake the sibling stand has already made; an absolute
 * same-origin URL needs none.
 *
 * The open image ships a stub returning no views, so the ordinary path is a
 * successful import of a file that registers nothing. That is deliberately not
 * a 404: a missing file is indistinguishable here from a file the server
 * mis-served, and a branch on "the import threw" would be a branch on which of
 * those happened.
 */
export async function loadExtensions(): Promise<Extensions> {
  let module: unknown
  try {
    module = await import(new URL('extensions.js', document.baseURI).href)
  } catch (error) {
    return { ok: false, reason: `The console extension file could not be loaded: ${explain(error)}` }
  }

  const register = (module as { default?: unknown }).default
  if (typeof register !== 'function') {
    return { ok: false, reason: 'The console extension file does not export a registration function.' }
  }

  let extension: unknown
  try {
    extension = (register as (kit: ConsoleKit) => unknown)(KIT)
  } catch (error) {
    return { ok: false, reason: `The console extension failed to register: ${explain(error)}` }
  }

  const { contract, views } = (extension ?? {}) as Partial<ConsoleExtension>
  if (contract !== CONTRACT) {
    // Said out loud. A console that silently drops the screens an installation
    // paid for is the same defect as one offering screens the server refuses,
    // and it is the harder of the two to notice — nothing is on the screen to
    // be wrong about.
    return {
      ok: false,
      reason:
        `The console extensions in this image were built for contract ${String(contract)} and this ` +
        `console speaks ${String(CONTRACT)}. Use an enterprise image built for this core.`,
    }
  }

  if (!Array.isArray(views)) {
    return { ok: false, reason: 'The console extension registered no views array.' }
  }

  const bad = views.find(
    (view) =>
      typeof view?.hash !== 'string' ||
      !view.hash.startsWith('#/') ||
      typeof view.label !== 'string' ||
      typeof view.shows !== 'function' ||
      typeof view.render !== 'function',
  )
  if (bad !== undefined) {
    return { ok: false, reason: 'The console extension registered a view that is not one.' }
  }

  return { ok: true, views }
}
