---
name: mcp-tool
description: Use when adding or changing an MCP tool, the MCP transport, or MCP authorization in packages/mcp — tool schemas, tools/list, the Streamable HTTP endpoint, STDIO mode, OAuth, CIMD, EMA, or ID-JAG. Triggers on "MCP tool", "tools/list", "Streamable HTTP", "Mcp-Method", "CIMD", "DCR", "EMA", "ID-JAG", "resource server", "well-known", "OAuth" in the context of MCP.
---

# Adding or changing an MCP tool

Contract: `docs/mcp.md`, target revision **2026-07-28**.

## Transport rules that constrain every tool

- **Stateless, in both eras.** The protocol is `@modelcontextprotocol/server`
  2.x: `factory.ts` builds one `McpServer` per request (STDIO, per connection),
  and it answers a legacy client's `initialize` and a modern client's
  `server/discover` alike. No `Mcp-Session-Id` is ever issued and nothing is
  kept between requests. Any request is served by any replica.
- A tool needing state between calls **returns an explicit descriptor** in its
  result and takes it back as an argument next time. Hidden state in the
  transport is not allowed — it is what makes the round-robin deployment work.
- The mirrored headers — `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`
  on `tools/call`, `resources/read` and `prompts/get` — are required of a
  *modern* client (one sending the `_meta` envelope) and compared against the
  body; a legacy client sends none and is not asked to. Present and
  disagreeing is `-32020`.
- `tools/list` returns `ttlMs: 0` and `cacheScope: "private"`. The catalog
  depends on the caller's permissions, so it is never shared across callers,
  and a grant can change it with no `list_changed`, so it is never fresh.
- A `/mcp` tool is registered in `factory.ts` and nowhere else;
  `transport-parity.test.ts` refuses a second site (`admin.ts` is its one
  written exemption).

## Every tool declares

1. **Which permission it requires** — `read`, `write` or `admin`
   (`ToolPermission` in `tools.ts`), from the model in `docs/authz.md`.
   Remember `write` does not imply `read`: an ingest-only service account must
   not be able to search. A delegation's ceiling also removes the tool from
   that connection's catalog — through the `ceiling` field, never by name.
2. **What it returns on no permission** — the same `isError` result with the
   text `Not found` that a genuinely missing object gets. Never a `403`, and
   never an HTTP `404` either: on Streamable HTTP that tells a client its
   session is gone.
3. **Its `title` and MCP `annotations`** — the type requires them.

## Forbidden in a tool

- Error messages that reveal an inaccessible object exists. "Layer contracts not
  found" and "you may not read layer contracts" must be the same string.
- Accepting `org_id` as an argument. It comes from the token, always.
- Bypassing the authorization service on the search path "for speed".

## Descriptions are generated, not written

`search` builds its description from the caller's visible layer catalog:

```
Search corporate documents by meaning and by exact term — identifiers, error codes, part numbers and names match literally. Available: {slug} — {name}: {description} ({n} docs); …; and more — call list_layers for the rest.
```

A sample of `CATALOG_SAMPLE` layers, by slug because `layers` takes slugs;
`list_layers` enumerates the rest.

A generic "searches the knowledge base" makes the model reach for web search
instead. The layer `description` column is user-facing copy for this reason —
treat it as product text, not an internal note.

Because the description depends on permissions, the tool list is per-user. This
is the same fact as `cacheScope: "private"` above; if you change one, check the
other.

## Authorization boundary

The MCP server is a **resource server**, not an authorization server.

EMA and ID-JAG (the commercial `ema` module) authorize the *connection*.
Permission on a specific document is computed by the authorization service on
**every call**. A valid token grants access to no document by itself — if you
find code that trusts the token's presence for data access, that is a bug
regardless of how the token was obtained.

Client registration is not this transport's: the installation's API is the
authorization server and implements DCR at `/oauth/register`, deliberately not
CIMD. `NACRE_OAUTH_CIMD_ENABLED` and `NACRE_OAUTH_DCR_ENABLED` were removed.

## The administrative surface

`/mcp/admin` (`admin.ts`, `docs/mcp-admin.md`) has its own audience and
consent, `org_admin` only. A write there changes nothing on the call: it is a
proposal a person applies, and a module's write is `propose` and `apply`.

## STDIO mode

Local mode carries exactly the service account's permissions. There is no
developer-convenience relaxation, and a PR adding one should be closed rather
than reviewed.

## Deployment detail that bites once

`/.well-known/oauth-protected-resource` is one document, served by the API and
by this transport; `authorization_servers` names the installation's API by
default, never this transport. `NACRE_JWT_ISSUER` is baked into every token ever
issued, so it is chosen once.
