/**
 * Everything a Postgres-backed verifier needs, in one place.
 *
 * There are three processes that verify a token — the API, the MCP Streamable
 * HTTP transport and MCP STDIO — and each used to assemble its own
 * `VerifyOptions` by hand. That is the shape this repository keeps being bitten
 * by: **a property that has to hold in N places, with nothing that knows N.**
 * `serviceKeys` was wired into all three because it was written when there were
 * three; the next port added to that object would be wired into however many
 * the author remembered.
 *
 * The failure would also be quiet in exactly the wrong direction. A transport
 * missing `delegations` does not crash — it refuses every delegated token with
 * the same `401` a forged one gets, because invariant 3 makes a check that
 * cannot run a denial. So the symptom is "this MCP client cannot connect", days
 * later, with nothing in a log saying why.
 *
 * So the answer is not a fourth copy but a function: this is what a
 * Postgres-backed verifier is, and adding a port here reaches every process
 * that has one.
 */

import type { Pool } from 'pg'

import type { VerifyOptions } from './auth.js'
import { PostgresDelegations } from './oauth-store.js'
import { PostgresServiceKeys } from './service-keys.js'

/**
 * The database-backed halves of `VerifyOptions`.
 *
 * Deliberately not the keys, the issuer or the audience: those come from
 * configuration a process loads for itself, and the MCP transport loads only
 * the *public* key on purpose. Mixing them in here would put a signing key into
 * the one helper a verify-only process calls.
 */
export function postgresVerification(
  pool: Pool,
  role?: string,
): Required<Pick<VerifyOptions, 'serviceKeys' | 'delegations'>> {
  return {
    serviceKeys: new PostgresServiceKeys(pool, role),
    delegations: new PostgresDelegations(pool, role),
  }
}
