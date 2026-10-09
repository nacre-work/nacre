/**
 * Whether an RFC 8707 resource indicator names the administrative MCP.
 *
 * The console's consent screen asks it to decide which screen to draw, and the
 * API asks the core's `namesAdminResource` to decide what the approval
 * *means*. Two copies because neither the console nor this package may import
 * the core; `admin-mcp.test.ts` holds them against each other over one table,
 * so a rule that moves in one and not the other fails there. The screen is
 * never the authority: an approval the console drew wrongly is refused by the
 * server, which reads the indicator itself.
 */
export const ADMINISTRATIVE_PATH = '/mcp/admin'

export function isAdministrativeResource(resource: string | undefined): boolean {
  if (resource === undefined) return false
  try {
    return new URL(resource).pathname.replace(/\/+$/, '') === ADMINISTRATIVE_PATH
  } catch {
    return false
  }
}
