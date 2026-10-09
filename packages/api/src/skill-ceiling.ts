/**
 * `skill` in a delegation's ceiling — and the only file that reads it.
 *
 * The consent screen offers, per layer, "edit this layer's skill", and only on a
 * layer where the person holds `admin`. It is stored as `skill` in that layer's
 * ceiling and is read by `may_write_layer_skill` in docs/skills.md and by
 * nothing else:
 *
 * ```
 * may_write_layer_skill(auth, L) =
 *     resolve(person, admin) reaches L
 *   ∧ (auth is not a delegation  ∨  'admin' ∈ ceiling(L)  ∨  'skill' ∈ ceiling(L))
 * ```
 *
 * The first clause is the skills adapter's, because it needs the database; the
 * second is `skillCeilingAdmits` below. Three properties hold them, each a case
 * in docs/authz.md:
 *
 * - **`skill` confers nothing the person lacks** (T30). The first clause
 *   resolves the *person*, so a delegation whose ceiling holds `skill` on a
 *   layer its person only writes is refused, however the consent was stored.
 * - **`skill` confers nothing else** (T29). It is not a `Permission` and
 *   `resolve` never sees it: `permissionsOf` strips it from every resolve input
 *   `contextFor` builds, so no search, ingest, grant, rename or delete path can
 *   be reached through it. A connection whose ceiling is `{skill}` alone
 *   resolves to nothing for every verb, which is right — it may edit a skill
 *   and do nothing else.
 * - **One reader.** `scripts/check-skill-ceiling.mjs` refuses a comparison
 *   against `'skill'` anywhere else in the server's sources, the way
 *   `check-admin-gate.mjs` refuses the raw role comparison. A value that grants
 *   something is only as safe as the number of places that interpret it.
 *
 * Why a value of its own and not `admin` in the layer's ceiling, which already
 * lets a delegation write the skill: a token from the consent flow reaches REST
 * as well as MCP — `NACRE_JWT_AUDIENCE` is one value — so `admin` would let an
 * MCP client rename the layer, delete it and issue grants on it. Editing what
 * agents are told about a layer is a narrower thing to approve.
 */
import type { Permission } from '@nacre.work/core'

import { delegationPermits, type AuthContext } from './auth.js'

/**
 * A value a delegation's ceiling may hold.
 *
 * Every permission, and `skill`. Stored in `oauth_consents.permissions` and
 * `oauth_consent_layers.permissions`, whose CHECKs admit exactly these
 * (migration 0037).
 */
export type CeilingValue = Permission | 'skill'

/** Every value a ceiling may hold, in the order the contract lists them. */
export const CEILING_VALUES: readonly CeilingValue[] = ['read', 'write', 'admin', 'skill']

/** Whether a string from a request is a ceiling value. */
export const isCeilingValue = (value: string): value is CeilingValue =>
  (CEILING_VALUES as readonly string[]).includes(value)

/**
 * A ceiling as `resolve` takes it: the permissions in it, and not `skill`.
 *
 * This is what keeps `skill` from conferring anything else. `resolve` refuses
 * a permission outside the ceiling before rule 3, so a ceiling of `{skill}`
 * becomes `[]` here — every verb refused, which is what a connection that may
 * only edit a skill should get from every path that is not the skill's.
 */
export function permissionsOf(values: readonly CeilingValue[]): Permission[] {
  return values.filter((v): v is Permission => v !== 'skill')
}

/**
 * Whether `value` is in the ceiling on one layer.
 *
 * The connection's ceiling and the layer's own, both: consent refuses a layer
 * set the connection excludes, so the second is already a subset of the first —
 * and asking both anyway is what keeps a row written some other way from being
 * the one place the rule does not hold. A layer outside a narrowing has no
 * ceiling at all; the delegation does not reach it.
 */
function inCeiling(auth: AuthContext, layerId: string, value: CeilingValue): boolean {
  const delegation = auth.delegation
  if (delegation === undefined) return true
  const connection = delegation.permissions
  if (connection !== undefined && !connection.includes(value)) return false
  if (delegation.layers === undefined) return true
  const entry = delegation.layers.find((l) => l.id === layerId)
  if (entry === undefined) return false
  return entry.permissions === undefined || entry.permissions.includes(value)
}

/**
 * The second clause of `may_write_layer_skill`: whether the token's ceiling on
 * this layer admits writing its skill.
 *
 * `true` for everything that is not a delegation. Never sufficient on its own —
 * the skills adapter asks it beside `admin` resolved for the person.
 */
export function skillCeilingAdmits(auth: AuthContext, layerId: string): boolean {
  return inCeiling(auth, layerId, 'admin') || inCeiling(auth, layerId, 'skill')
}

/**
 * The layers on which the ceiling admits writing a skill, or `undefined` for
 * "every layer" — not a delegation, or one with no narrowing whose connection
 * ceiling admits it.
 *
 * For listings, which cannot ask `skillCeilingAdmits` of a layer they have not
 * found yet. An empty array is a real answer: the delegation may write no
 * layer's skill.
 */
export function skillCeilingLayers(auth: AuthContext): readonly string[] | undefined {
  const delegation = auth.delegation
  if (delegation === undefined) return undefined
  if (delegation.layers === undefined) {
    const connection = delegation.permissions
    const admits = connection === undefined || connection.includes('admin') || connection.includes('skill')
    return admits ? undefined : []
  }
  return delegation.layers.filter((l) => skillCeilingAdmits(auth, l.id)).map((l) => l.id)
}

/**
 * Whether a delegation's ceiling admits something that needs `need` — a
 * permission, or `skill` for the one write it stands in for.
 *
 * The MCP catalog's question: a tool the ceiling refuses is left out of
 * `tools/list`. For a permission this is the connection's ceiling, the same
 * predicate the request path asks; for `skill` it is whether any layer's
 * ceiling admits writing a skill, so `update_skill` is offered to a connection
 * that may write one somewhere and to nobody else.
 */
export function ceilingOffers(auth: AuthContext, need: CeilingValue): boolean {
  if (need === 'skill') {
    const layers = skillCeilingLayers(auth)
    return layers === undefined || layers.length > 0
  }
  return delegationPermits(auth, need)
}
