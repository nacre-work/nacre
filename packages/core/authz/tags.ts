import { createHash } from 'node:crypto'

import type { PrincipalRef } from '../types.js'

/**
 * ACL tags: the denormalization described in docs/authz.md 3.6.
 *
 * Each indexed chunk carries hashes of the principals allowed to read it, so a
 * filter can narrow on the payload instead of joining back to Postgres. The
 * thing to keep in view is what it is *not*:
 *
 * **`acl_tags` is a cache. The `grants` table is the source of truth.** A grant
 * change starts a background recomputation, and until it finishes the tags are
 * stale. That is why the layer bound stays in every query rather than being
 * "simplified" away once tags exist — see the collision note below.
 */

/** Bytes kept from each hash. The default matches `NACRE_ACL_TAG_HASH_BYTES`. */
export const DEFAULT_TAG_BYTES = 8

/**
 * Hash one principal reference into a tag.
 *
 * Truncation is deliberate and it does collide: 8 bytes over a large enough
 * population will eventually produce two principals with the same tag, and a
 * collision means a false tag match — a chunk appearing to be readable by
 * someone it was not granted to.
 *
 * That is only safe because **the query is also bounded by the allowed
 * `layer_id` list**. A colliding tag inside a layer the caller may already read
 * changes nothing; a colliding tag in a layer they may not read never gets
 * considered, because the layer bound excludes it first. Remove the layer bound
 * and the truncation becomes a leak — which is the single most important thing
 * to know before touching this file.
 */
export function principalTag(ref: PrincipalRef, bytes: number = DEFAULT_TAG_BYTES): string {
  if (bytes < 1 || bytes > 32) {
    throw new Error(`tag width must be between 1 and 32 bytes, got ${bytes}`)
  }
  const digest = createHash('sha256').update(ref, 'utf8').digest()
  return `h:${digest.subarray(0, bytes).toString('hex')}`
}

/**
 * The tags for a set of principals, sorted so the payload is stable.
 *
 * Stability matters for the recomputation job: an unstable order makes every
 * chunk look changed on every pass, and the propagation metric stops meaning
 * anything.
 */
export function aclTags(
  principals: Iterable<PrincipalRef>,
  bytes: number = DEFAULT_TAG_BYTES,
): readonly string[] {
  return [...new Set([...principals].map((p) => principalTag(p, bytes)))].sort()
}
