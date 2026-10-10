import { fromJsonSchema } from '@modelcontextprotocol/server'

/**
 * A tool's input schema, compiled once for the life of the process.
 *
 * `fromJsonSchema` compiles its argument with Ajv, on a validator the SDK keeps
 * at module level and never releases, and Ajv caches every schema it compiles
 * by object identity. Both transports build a server per request or per
 * connection, and `catalog()` writes each schema as a fresh literal every time
 * — so each request compiled every tool's schema again and the cache kept all
 * of them. Measured on a running stack: the MCP transport grew about 80 KB per
 * request and never gave it back, and with its heap capped at 200 MB it died
 * with "JavaScript heap out of memory" after some 3,600 searches, dropping the
 * three thousand requests in flight. The compiling was also most of what made a
 * search over MCP cost four times the CPU of the same search over REST.
 *
 * Keyed by content, because the schemas are static — `tools.ts` and
 * `admin-tools.ts` write literals, and a module's tools arrive once at load —
 * so this map holds one entry per distinct schema and stops there.
 * `schemas.test.ts` asks that building servers for different callers compiles
 * nothing after the first, and that nothing else in this package calls
 * `fromJsonSchema`, which is how a second spelling would bring the leak back.
 */
type Compiled = ReturnType<typeof fromJsonSchema>

const compiled = new Map<string, Compiled>()
let compiles = 0

export function compiledSchema(schema: Record<string, unknown>): Compiled {
  const key = JSON.stringify(schema)
  const found = compiled.get(key)
  if (found !== undefined) return found
  compiles += 1
  const made = fromJsonSchema(schema)
  compiled.set(key, made)
  return made
}

/**
 * How many times this process has handed a schema to Ajv — counted at the call,
 * not as the map's size, so a cache that stops being consulted shows up here.
 */
export function compiledSchemaCount(): number {
  return compiles
}
