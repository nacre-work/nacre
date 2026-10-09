# @nacre.work/mcp

The MCP server for a [Nacre](https://nacre.work) installation — a self-hosted
knowledge index that answers an agent with **exactly the documents that agent's
principal may read**.

Two transports from one package: Streamable HTTP for a deployed installation,
and `nacre-mcp` over STDIO for an agent on a laptop. Both run the same tools
against the same resolver, held together by a test that drives one table of
cases through both — a method implemented on one transport and forgotten on the
other is a build failure.

## Tools

| | |
|---|---|
| `search` | hybrid dense + BM25, permission-filtered inside the index traversal |
| `list_layers` | the layers this principal can reach, one page per call |
| `get_document` | one document by id, with a link to the original file where there is one |
| `ingest_document` | add or update a document from text or a URL |
| `request_upload` | a single-use ticket to send a file to, so its bytes never pass through the model |
| `upload_file` | the upload panel, in a client that renders MCP Apps |
| `ingest_status` | what became of an ingest |
| `delete_document` | remove one |
| `list_skills` | the skills that say how to work here — the base one and each layer's |
| `get_skill` | read one: its `SKILL.md`, or another file in it |
| `update_skill` | write a layer's skill, as a new version, with `admin` on the layer |

Eleven tools, and the write ones are why **an MCP client is already a
connector**: an agent that can reach Confluence, a ticket tracker or a drive
puts documents in through the same session it searches them out of, with its own
permissions, and no integration code of ours in between. For a source nobody is
sitting in front of, the [reference connectors](https://github.com/nacre-work/connectors)
do the same on a schedule.

In a client that renders MCP Apps, `search`, `list_layers` and `upload_file`
open a panel inside the conversation. The panel holds no credential; it calls
these same tools through the client.

## STDIO, locally

```json
{
  "mcpServers": {
    "nacre": {
      "command": "npx",
      "args": ["-y", "@nacre.work/mcp"],
      "env": { "NACRE_SERVICE_KEY": "…" }
    }
  }
}
```

**This process talks to Postgres and Qdrant directly**, so it belongs where those
are reachable — it is not a thin proxy in front of a remote API, and the rest of
the installation's configuration has to be in its environment too. `NACRE_SERVICE_KEY`
is the one credential that is specific to this mode: local mode carries exactly
one service account's permissions, so there is nobody to be without it.

**Local mode gets no relaxation of any kind.** Same resolver, same layer bounds,
same `404`. There is no developer-convenience path that skips a check because
the process happens to be on the operator's machine.

## Authorization

The transport is an OAuth **resource server**: it validates an audience-bound
token and issues none. It serves the RFC 9728 protected-resource document, and a
`401` names it — so a compliant client discovers the authorization server,
registers, sends its person to a consent screen, and comes back with a token.
That whole chain has been driven end to end with a real MCP client rather than
asserted in a test.

A person approving a connection bounds it: a permission set per connection, and
a narrower one per layer — "read the handbook, write to scratch" — so connecting
a search client does not hand it the ability to delete a document. The
delegation stops when that person is disabled, which a service account key does
not.

## What an agent will notice

**`404` covers both "no such document" and "you may not see it"**, with the same
wording. That is deliberate and everywhere: the alternative lets anyone map what
exists by probing.

**`write` does not imply `read`.** `admin` implies both.

Apache 2.0. The MCP surface, the tool schemas and the authorization chain:
[github.com/nacre-work/nacre](https://github.com/nacre-work/nacre/blob/main/docs/mcp.md).
