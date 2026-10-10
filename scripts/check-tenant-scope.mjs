#!/usr/bin/env node
/**
 * Every statement over a tenant table names its organization in a predicate.
 *
 * Row-level security is the second line, not the only one. A policy binds
 * `nacre_app` and binds nothing that is a superuser or owns the tables — and a
 * deployment that connects as one is a deployment the policies do not protect.
 * `GET /v1/embedding-providers` relied on the policy alone and listed every
 * organization's providers to any member of one, on exactly such a connection.
 *
 * The rule is the one `nacre-enterprise`'s `lint:tenant-scope` states, with the
 * hole that check has closed: `org_id` has to appear as a **predicate** — `org_id
 * = …`, `… = x.org_id`, `org_id IN …` — and not merely somewhere in the text.
 * The statement that leaked selected `org_id` as a column, which a text search
 * counts as naming it. An INSERT is the exception the other way round: it names
 * the organization by writing the column, so its column list is what is asked.
 *
 * The tenant tables are **discovered** from the migrations — every table
 * created with an `org_id` — so a table added later is held on the day it
 * exists rather than on the day somebody remembers this list.
 *
 * A statement that is deliberately keyed some other way carries a written
 * exemption, and each exemption must match **exactly one** statement: zero is a
 * stale entry that reads as a decision, and two is an argument written about
 * one statement waving through the next one spelled the same way.
 *
 * Refuses if it finds no statement at all: a check with nothing to hold must
 * not report green.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = 'packages/core/migrations'
const ROOTS = ['packages/api/src', 'packages/worker/src', 'packages/mcp/src', 'packages/core']

function tenantTables() {
  const tables = new Set()
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8').replace(/--[^\n]*/g, '')
    for (const m of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      if (/^\s*org_id\b/m.test(m[2])) tables.add(m[1].toLowerCase())
    }
  }
  return tables
}

const ON_A_TENANT = (tables) =>
  new RegExp(String.raw`\b(?:FROM|UPDATE|INTO|JOIN|USING)\s+(?:${[...tables].join('|')})\b`, 'i')

/**
 * `org_id = …`, `x.org_id = …`, `… = x.org_id`, `org_id IN …`, and `org_id IS
 * NULL` — the installation's own rows, which is a statement about scope too.
 */
const PREDICATE = /\b(?:\w+\.)?org_id\s*(?:=|\bIN\b|\bIS NULL\b|\bIS NOT DISTINCT FROM\b)|=\s*(?:\w+\.)?org_id\b/i

/** file → [statement prefix, reason]. A prefix is matched against the statement with its whitespace collapsed. */
const EXEMPT = {
  'packages/api/src/adapters.ts': [
    [
      'l.id, l.slug, l.name, l.workspace_id',
      'a projection, interpolated into statements that say l.org_id = $1 themselves; its subqueries reach documents through that layer',
    ],
    [
      'SELECT k.key, count(*) AS events',
      "the access log's summary: its WHERE is assembled from a list whose first entry is 'org_id = $1'",
    ],
    [
      'SELECT id::text, occurred_at, occurred_at::text AS occurred_at_text',
      "the access log's page: its WHERE is assembled from a list whose first entry is 'org_id = $1'",
    ],
  ],
  'packages/api/src/login.ts': [
    [
      'SELECT id, org_id, user_id, family_id, expires_at, used_at, revoked_at',
      'whileAuthenticating: a refresh token is found by its hash, which is what says which organization it belongs to',
    ],
    [
      'SELECT org_id, family_id FROM refresh_tokens WHERE token_hash = $1',
      'whileAuthenticating: sign-out finds the token by its hash, which is what says which organization it belongs to',
    ],
    [
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      'the rehash on sign-in, keyed by the id the same sign-in has just verified inside its organization',
    ],
    [
      'UPDATE refresh_tokens SET used_at = now() WHERE id = $1',
      'spends the token the same transaction has just found by its hash, which already carries its organization',
    ],
    [
      'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1',
      'a family is minted inside one organization and its id is random; revoking it is keyed by the family the replay was found in',
    ],
  ],
  'packages/api/src/oauth-store.ts': [
    [
      'SELECT org_id FROM oauth_authorizations WHERE code_hash = $1',
      'whileAuthenticating: an authorization code is found by its hash, which is what says which organization it belongs to',
    ],
    [
      'SELECT org_id FROM oauth_refresh_tokens WHERE token_hash = $1',
      'whileAuthenticating: an OAuth refresh token is found by its hash, which is what says which organization it belongs to',
    ],
    [
      'UPDATE oauth_refresh_tokens SET used_at = now() WHERE id = $1',
      'spends the token the same transaction has just found by its hash',
    ],
  ],
  'packages/api/src/recovery.ts': [
    [
      'UPDATE users SET password_hash = $2 WHERE id = $1',
      'the redemption, keyed by the user the same transaction found through a token that names its organization',
    ],
  ],
  'packages/api/src/second-factor.ts': [
    [
      'UPDATE user_second_factors SET confirmed_at = now()',
      'keyed by the factor the same transaction read for this person inside withOrg',
    ],
    [
      'UPDATE user_second_factors SET last_step = $2',
      'keyed by the factor the same transaction read for this person inside withOrg',
    ],
    [
      'UPDATE user_second_factors SET failed_attempts = $2::int',
      'keyed by the factor the same transaction read for this person inside withOrg',
    ],
    [
      'UPDATE user_second_factors SET last_used_at = now(), sign_count = $2',
      'keyed by the credential the same ceremony matched for this person inside withOrg',
    ],
  ],
  'packages/api/src/service-keys.ts': [
    [
      'SELECT id, org_id, key_hash FROM service_accounts WHERE key_prefix = $1',
      'whileAuthenticating: a key is found by its prefix, which is what says which organization it belongs to',
    ],
    [
      'UPDATE service_accounts SET last_used_at = now() WHERE id = $1',
      'keyed by the account a key was just resolved to, which names its organization',
    ],
  ],
  'packages/worker/src/adapters.ts': [
    [
      'WITH expired AS ( SELECT id, claimed_at FROM documents',
      'acrossOrganizations: the reaper reclaims a lease whichever organization holds it',
    ],
    [
      'WITH due AS ( SELECT id FROM admin_proposals',
      'acrossOrganizations: the expiry sweep ends proposals whichever organization they belong to, and records each against its own',
    ],
    [
      'SELECT org_id, name FROM retired_collections WHERE retired_at <',
      'acrossOrganizations: superseded collections past the rollback window, whichever organization retired them',
    ],
    [
      'WITH doomed AS ( SELECT ctid FROM refresh_tokens WHERE expires_at < now()',
      'installation-wide: expired tokens go whichever organization they belong to, through acrossOrganizations',
    ],
  ],
  'packages/worker/src/claim.ts': [
    [
      "UPDATE documents SET status = 'parsing'",
      'the claim, keyed by the document the same statement selected across organizations for the queue',
    ],
  ],
  'packages/worker/src/notify.ts': [
    [
      'SELECT id, org_id, kind, layer_id, threshold, window_minutes',
      "acrossOrganizations: every organization's alert rules, each evaluated against its own organization",
    ],
    [
      "UPDATE notifications n SET status = 'sending'",
      'acrossOrganizations: the outbox is claimed whichever organization queued it; the address is read from its own organization',
    ],
    [
      'WITH due AS ( SELECT id FROM notifications',
      'acrossOrganizations: the sweep ends stale notifications whichever organization queued them',
    ],
    [
      'DELETE FROM notifications WHERE id IN',
      'installation-wide: finished notifications past their window go whichever organization sent them',
    ],
  ],
}

/**
 * Whether a predicate on `org_id` sits in a clause that filters — after a
 * `WHERE` or a join's `ON`, before the `ORDER BY`, `GROUP BY`, `LIMIT` or
 * `RETURNING` that ends it. Anywhere else it is not a filter: `ORDER BY org_id
 * IS NULL` sorts the installation's rows last and narrows nothing, and the
 * first version of this check counted exactly that statement as scoped.
 */
function filters(code) {
  for (const m of code.matchAll(/\b(?:WHERE|ON)\b([\s\S]*?)(?=\b(?:ORDER BY|GROUP BY|LIMIT|RETURNING|WHERE|ON|UNION|SELECT)\b|$)/g)) {
    if (PREDICATE.test(m[1])) return true
  }
  return false
}

/**
 * An INSERT names its organization by writing the column; whatever it reads
 * besides — an `INSERT … SELECT` from another tenant table — still needs a
 * predicate. Everything else needs one outright.
 */
function scoped(code) {
  const target = /\bINSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/.exec(code)
  if (target === null) return filters(code)
  if (!tables.has(target[1].toLowerCase()) || /\borg_id\b/.test(target[2])) {
    const rest = code.slice(0, target.index) + code.slice(target.index + target[0].length)
    const reads = new RegExp(String.raw`\b(?:FROM|JOIN|USING)\s+(?:${[...tables].join('|')})\b`).test(rest)
    return !reads || filters(rest)
  }
  return false
}

function sources(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'migrations' || name.startsWith('__')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sources(full))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** SQL literals: template literals, and single-quoted strings that start with a statement keyword. */
function literals(text) {
  const out = []
  for (const m of text.matchAll(/`([^`]*)`/gs)) out.push({ sql: m[1], index: m.index })
  for (const m of text.matchAll(/'((?:SELECT|UPDATE|INSERT|DELETE|WITH)\b[^'\n]*)'/g)) out.push({ sql: m[1], index: m.index })
  return out
}

const tables = tenantTables()
if (tables.size < 10) {
  console.error(`::error::check-tenant-scope: found ${String(tables.size)} tenant table(s) in ${MIGRATIONS}; the discovery has stopped working`)
  process.exit(1)
}
const touches = ON_A_TENANT(tables)

const problems = []
const used = new Map()
let statements = 0

for (const file of ROOTS.flatMap(sources)) {
  const text = readFileSync(file, 'utf8')
  for (const { sql, index } of literals(text)) {
    // Comments are prose, and prose says "from" and "into" about things that
    // are not tables.
    const code = sql.replace(/--[^\n]*/g, '')
    if (!touches.test(code)) continue
    if (!/\b(?:SELECT|UPDATE|INSERT|DELETE)\b/.test(code) && !/^\s*l\./.test(code)) continue
    statements += 1
    if (scoped(code)) continue
    const flat = code.split(/\s+/).join(' ').trim()
    const exemption = (EXEMPT[file] ?? []).find(([prefix]) => flat.startsWith(prefix))
    if (exemption !== undefined) {
      const key = `${file}\0${exemption[0]}`
      used.set(key, (used.get(key) ?? 0) + 1)
      continue
    }
    const line = text.slice(0, index).split('\n').length
    problems.push(
      `${file}:${String(line)}: a statement over a tenant table names no organization in a predicate — ` +
        `row-level security does not bind a connection that owns the tables. "${flat.slice(0, 90)}"`,
    )
  }
}

for (const [file, entries] of Object.entries(EXEMPT)) {
  for (const [prefix] of entries) {
    const count = used.get(`${file}\0${prefix}`) ?? 0
    if (count !== 1) {
      problems.push(`${file}: the exemption "${prefix}" matches ${String(count)} statement(s); it must match exactly one`)
    }
  }
}

if (statements === 0) {
  console.error('::error::check-tenant-scope: found no SQL over a tenant table; a check with nothing to hold must not report green')
  process.exit(1)
}
if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`)
  process.exit(1)
}
console.log(
  `check-tenant-scope: ${String(statements)} statement(s) over ${String(tables.size)} tenant tables, each naming its organization or exempted once.`,
)
