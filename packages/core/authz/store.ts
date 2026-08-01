import type { PoolClient } from 'pg'

import type { Grant, Permission, Principal, PrincipalRef } from '../types.js'
import type { GroupGraph } from './principals.js'
import { MemoryScopeTree, type ScopeTree } from './scope-tree.js'

/**
 * Load the grants that could bear on a request.
 *
 * Deliberately *not* filtered by permission in SQL. `satisfies` decides which
 * grants matter, and duplicating rules 6 and 7 into a `WHERE` clause would mean
 * two places to keep in step — with the SQL one being the copy nobody tests
 * against the truth table. The row count here is bounded by the caller's
 * principals, not by the size of the index.
 *
 * The connection must already be scoped with `withOrg`, so RLS is a second
 * bound on top of the explicit `org_id` below.
 */
export async function loadGrants(
  client: PoolClient,
  orgId: string,
  principals: ReadonlySet<PrincipalRef>,
): Promise<readonly Grant[]> {
  const refs = [...principals]
  if (refs.length === 0) return []

  // Split the `{type}:{id}` refs into parallel arrays so the query stays a
  // single indexed lookup rather than a string comparison per row.
  const types: string[] = []
  const ids: string[] = []
  for (const ref of refs) {
    const sep = ref.indexOf(':')
    types.push(ref.slice(0, sep))
    ids.push(ref.slice(sep + 1))
  }

  const { rows } = await client.query<{
    principal_type: Principal['type']
    principal_id: string
    scope_type: 'workspace' | 'layer' | 'document'
    scope_id: string
    permission: Permission
    effect: 'allow' | 'deny'
  }>(
    `SELECT principal_type, principal_id, scope_type, scope_id, permission, effect
       FROM grants
      WHERE org_id = $1
        AND (principal_type, principal_id) IN (
              SELECT * FROM unnest($2::text[], $3::uuid[])
            )`,
    [orgId, types, ids],
  )

  return rows.map((r) => ({
    orgId,
    principal: { type: r.principal_type, id: r.principal_id },
    scope: { type: r.scope_type, id: r.scope_id },
    permission: r.permission,
    effect: r.effect,
  }))
}

/**
 * Build the scope tree the resolver needs.
 *
 * Only the documents named in the grants are placed — the tree never
 * enumerates the index. Deleted layers and documents are excluded, so a grant
 * pointing at one becomes unplaceable and is therefore refused, which is the
 * behaviour rule I3 asks for.
 */
export async function loadScopeTree(
  client: PoolClient,
  orgId: string,
  documentIds: readonly string[],
): Promise<ScopeTree> {
  const { rows: layerRows } = await client.query<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id FROM layers WHERE org_id = $1 AND deleted_at IS NULL`,
    [orgId],
  )

  const layers: Record<string, string[]> = {}
  for (const row of layerRows) {
    ;(layers[row.workspace_id] ??= []).push(row.id)
  }

  const documents: Record<string, string> = {}
  if (documentIds.length > 0) {
    const { rows } = await client.query<{ id: string; layer_id: string }>(
      `SELECT id, layer_id FROM documents
        WHERE org_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
      [orgId, [...documentIds]],
    )
    for (const row of rows) documents[row.id] = row.layer_id
  }

  return new MemoryScopeTree({ layers, documents })
}

/**
 * Group membership, read straight from the join table.
 *
 * Nesting is resolved by `effectivePrincipals`, not here, and not in SQL. A
 * recursive CTE would be faster and would also have to answer what to do about
 * a cycle — `WITH RECURSIVE` needs a cycle clause or it does not terminate, and
 * getting that wrong is a hung connection rather than a wrong answer. Keeping
 * the traversal in one tested place is worth a second round trip.
 */
export class PostgresGroupGraph implements GroupGraph {
  readonly #edges: Map<string, readonly string[]>

  private constructor(edges: Map<string, readonly string[]>) {
    this.#edges = edges
  }

  static async load(client: PoolClient, orgId: string): Promise<PostgresGroupGraph> {
    const { rows } = await client.query<{
      group_id: string
      member_user: string | null
      member_group: string | null
    }>(`SELECT group_id, member_user, member_group FROM group_members WHERE org_id = $1`, [orgId])

    const edges = new Map<string, string[]>()
    for (const row of rows) {
      const member: PrincipalRef | null = row.member_user
        ? `user:${row.member_user}`
        : row.member_group
          ? `group:${row.member_group}`
          : null
      if (member === null) continue
      ;(edges.get(member) ?? edges.set(member, []).get(member)!).push(row.group_id)
    }

    return new PostgresGroupGraph(edges)
  }

  directGroups(principal: PrincipalRef): readonly string[] {
    return this.#edges.get(principal) ?? []
  }
}
