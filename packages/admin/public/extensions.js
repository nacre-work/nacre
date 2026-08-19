/**
 * The console's extension file. This one registers nothing, on purpose.
 *
 * `packages/admin` is the community console and is single-organization. The
 * commercial modules mount routes under `/v1/admin/*` — organizations, tenancy,
 * the installation's default embedding model — and the screens for those are
 * not in this repository and must not be: putting them here would be the open
 * core carrying UI for a feature it does not implement, which devalues both
 * halves of the product.
 *
 * So the console loads this file at start-up and the enterprise `web` image is
 * built `FROM` the open one with this file replaced. The stub exists rather
 * than the file being absent because "missing" and "mis-served" look the same
 * from a browser, and a console that branched on an import throwing would be
 * branching on which of those happened.
 *
 * The contract is in `packages/admin/src/extensions.ts` and is one function:
 * it is handed a `ConsoleKit` — every helper it may use, so an extension
 * resolves no package of ours and there is no second copy of anything — and
 * returns the contract number it was built against and its views. A number this
 * console does not speak is said out loud rather than swallowed.
 *
 * @returns {import('../src/extensions.js').ConsoleExtension}
 */
export default function register() {
  return { contract: 1, views: [] }
}
