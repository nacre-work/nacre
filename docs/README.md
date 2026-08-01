# Nacre documentation

Read [authz.md](./authz.md) first. Everything else depends on the permission
model, and reworking it after search is written is expensive.

| Document | Covers |
|---|---|
| [authz.md](./authz.md) | **Start here.** Permission model, algorithm, invariants, the T1–T15 test plan |
| [architecture.md](./architecture.md) | Components, data flow, vector storage, reindexing, backups |
| [mcp.md](./mcp.md) | MCP server: transport, authorization, tools |
| [api.md](./api.md) | REST API conventions · contract in [openapi.yaml](./openapi.yaml) |
| [config.md](./config.md) | Environment variables, Compose profiles, metrics |
| [audit.md](./audit.md) | Access log schema and guarantees |
| [licensing.md](./licensing.md) | Open/commercial boundary, third-party licenses |
| [quickstart.md](./quickstart.md) | First run, first document, first search |

## Order of work

1. `authz.md` and `packages/core/migrations/0001_init.sql` — the permission
   model and the schema, **with the tests from the test plan**. The tests are
   written before search, not after. Written after, they get written to match
   whatever was built rather than what was specified.
2. `architecture.md` — vector storage and the pre-filter.
3. `mcp.md` — the MCP server.
4. `api.md` and `openapi.yaml` — REST.
5. `config.md` and `audit.md` — operations and audit.

## The six invariants

Breaking any of them is a security incident, not a bug.

1. The organization comes from the token and nowhere else.
2. Access filtering is a pre-filter, never a post-filter.
3. A failure to evaluate permissions denies access.
4. "No permission" and "no such object" return identical responses.
5. A deleted document is never returned, including before garbage collection.
6. `write` does not imply `read`.
