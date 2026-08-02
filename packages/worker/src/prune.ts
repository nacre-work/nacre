/**
 * Retention: the two tables that only ever grew.
 *
 * Both were documented as swept and neither was. `refresh_tokens` carries a
 * comment in migration `0009` on the index built to make the sweep cheap;
 * `audit_events` has `NACRE_AUDIT_RETENTION_DAYS`, validated at startup since
 * the day it was added and read by nothing. A configuration variable that
 * changes nothing is worse than an absent feature: the operator who set it
 * believes retention is enforced.
 *
 * They fail independently. An audit prune that raises — a retention below the
 * floor, a missing grant on a database migrated by hand — must not stop token
 * expiry, and the reverse holds too. Nothing downstream waits on either, so a
 * pass that half worked is a pass that did half the work and said so.
 */

export interface PrunePorts {
  /** Refresh tokens past `expires_at`. Returns how many rows went. */
  tokens(limit: number): Promise<number>
  /**
   * Audit events past the retention horizon, through the definer function.
   * Separate from `tokens` because it can legitimately be refused — see
   * `pruneAuditEvents` — and a refusal is the operator's to see.
   */
  audit(retentionDays: number, limit: number): Promise<number>
  onError(what: 'tokens' | 'audit', error: unknown): void
}

export interface PruneResult {
  readonly tokens: number
  readonly audit: number
  readonly failed: number
}

export async function pruneOnce(
  ports: PrunePorts,
  batch: number,
  retentionDays: number,
): Promise<PruneResult> {
  if (batch < 1) throw new Error('batch must be at least 1')

  let tokens = 0
  let audit = 0
  let failed = 0

  try {
    tokens = await ports.tokens(batch)
  } catch (error) {
    failed++
    ports.onError('tokens', error)
  }

  try {
    audit = await ports.audit(retentionDays, batch)
  } catch (error) {
    failed++
    ports.onError('audit', error)
  }

  return { tokens, audit, failed }
}
