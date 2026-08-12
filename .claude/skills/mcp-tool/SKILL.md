---
name: mcp-tool
description: Use when adding or changing an MCP tool, the MCP transport, or MCP authorization in packages/mcp — tool schemas, tools/list, the Streamable HTTP endpoint, STDIO mode, OAuth, CIMD, EMA, or ID-JAG. Triggers on "MCP tool", "tools/list", "Streamable HTTP", "Mcp-Method", "CIMD", "DCR", "EMA", "ID-JAG", "resource server", "well-known", "OAuth" in the context of MCP.
---

# Adding or changing an MCP tool

Contract: `docs/mcp.md`, target revision **2026-07-28**.

## Transport rules that constrain every tool

- **Stateless.** No `initialize`, no `Mcp-Session-Id`, nothing kept between
  requests. Any request is served by any replica.
- A tool needing state between calls **returns an explicit descriptor** in its
  result and takes it back as an argument next time. Hidden state in the
  transport is not allowed — it is what makes the round-robin deployment work.
- Required headers: `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`.
- `tools/list` returns `ttlMs: 300000` and `cacheScope: "user"`. The catalog
  depends on the caller's permissions, so a global cache would serve one user's
  catalog to another.

## Every tool declares

1. **Which permission it requires** — `read` or `write`, from the model in
   `docs/authz.md`. Remember `write` does not imply `read`: an ingest-only
   service account must not be able to search.
2. **What it returns on no permission** — `404`, never `403`, and worded
   identically to a genuinely missing object.

## Forbidden in a tool

- Error messages that reveal an inaccessible object exists. "Layer contracts not
  found" and "you may not read layer contracts" must be the same string.
- Accepting `org_id` as an argument. It comes from the token, always.
- Bypassing the authorization service on the search path "for speed".

## Descriptions are generated, not written

`search` builds its description from the caller's visible layer catalog:

```
Search corporate documents by meaning and by exact term — identifiers, error codes, part numbers and names match literally. Available: {layer.name} — {layer.description} ({n} docs); …
```

A generic "searches the knowledge base" makes the model reach for web search
instead. The layer `description` column is user-facing copy for this reason —
treat it as product text, not an internal note.

Because the description depends on permissions, the tool list is per-user. This
is the same fact as `cacheScope: "user"` above; if you change one, check the
other.

## Authorization boundary

The MCP server is a **resource server**, not an authorization server.

EMA and ID-JAG authorize the *connection*. Permission on a specific document is
computed by the authorization service on **every call**. A valid token grants
access to no document by itself — if you find code that trusts the token's
presence for data access, that is a bug regardless of how the token was
obtained.

Client registration is CIMD. DCR stays behind `NACRE_OAUTH_DCR_ENABLED`,
defaulting off.

## STDIO mode

Local mode carries exactly the service account's permissions. There is no
developer-convenience relaxation, and a PR adding one should be closed rather
than reviewed.

## Deployment detail that bites once

`/.well-known/*` and the OAuth issuer live on `api.nacre.work`, not the apex.
Pages intercepts the discovery path on the apex. The domain is baked into the
issuer URL of every token ever issued, so it is chosen once.
