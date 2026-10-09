# The administrative MCP

> **Specified, not built.** Everything below is the contract the implementation
> is written to.

An organization's administrator does their work in the console: people, groups,
layers, grants, skills, the access log. An agent can do most of it from a
sentence — "give Petya read on contracts", "who read the board minutes this
week", "why did forty documents fail last night" — and this is the surface it
does that through.

It is a **second MCP server** rather than more tools on the first, and that
separation is the design rather than tidiness: the first server's job is to put
documents in front of a model, and documents are untrusted input. A sentence
inside one can ask an agent to grant somebody access. The less an administrative
session reads of what the organization stores, the less there is to ask it.

## A separate resource, a separate token

- **`/mcp/admin`** on the MCP process, with its own RFC 9728 document at
  `/.well-known/oauth-protected-resource/mcp/admin` naming that resource.
- **Its own audience.** A token for it carries `${NACRE_JWT_AUDIENCE}/admin`,
  which is the shape the second-factor challenge already uses to be refused
  everywhere an access token is accepted. The API and `/mcp` compare audiences
  exactly, so they refuse it; `/mcp/admin` accepts that audience and nothing
  else, so an ordinary connection's token is refused there. A client reaches this
  surface only by connecting to it on purpose.
- **Its own consent.** The authorization request names the resource (RFC 8707),
  and the consent screen for this resource is the administrative one: it is
  offered only to an `org_admin`, and it sets `admin` in the connection's
  ceiling — the value the ordinary screen deliberately never offers, because
  there the same token would reach REST. Here it reaches nothing but this
  surface.
- **People only.** A service account holds grants, never the `org_admin` role, so
  it cannot use this surface; a `platform_admin` cannot delegate at all. Nothing
  that spans tenants is reachable here — those rights stay in the API and the
  console, by decision.
- **No local mode.** STDIO authenticates with a service account key, which
  cannot hold the role.

Every request re-resolves, exactly as a delegation does elsewhere: a person
demoted from `org_admin` or disabled loses this surface on the next call.

## No content, deliberately

There is no `search`, no `get_document`, no `ingest_document` here. An
administrative session reads names, roles, grants, counts, statuses and the
access log — still text the organization wrote (a layer's description, a
person's name, a search query where the log keeps them), so not nothing, but a
small fraction of what a document-reading session takes in.

The one gap no server can close is a client with **both** servers connected:
text returned by the first can ask for a call to the second. That is said here
and in the setup guide in those words, and it is the reason for the next
section.

## A change is proposed, and a person applies it

Every tool that changes something **proposes** the change rather than making it.
The result says what will happen — who gets what, on which scope, what is
removed — and opens the confirmation panel. **Applying is a tool only the panel
can call**: it is declared with `visibility: ["app"]`, which a host honours by
leaving it out of what the model is offered. A planted instruction can therefore
get as far as a proposal on somebody's screen, and no further.

- A proposal is stored server-side, bound to the connection, single-use, and
  expires in ten minutes. Applying an expired or foreign one is refused.
- The proposal's identifier travels in the result's `_meta` for the panel, not in
  the text the model reads.
- **A client that cannot render panels** gets the organization's choice, set in
  the console: refuse writes with a sentence saying a panel is needed (the
  default), or apply directly, relying on the client's own confirmation of a
  tool annotated destructive.

What this guarantee rests on is the host not offering an app-only tool to the
model, and that is stated rather than implied.

## Tools

All read tools are `readOnlyHint`; every write is `destructiveHint` and goes
through a proposal.

| Area | Read | Write |
|---|---|---|
| People | list, one person with their groups and grants | create (no password), set role `member` / `org_admin`, disable, enable |
| Groups | list, members | create, rename, delete, add and remove members |
| Workspaces and layers | list, one with its state | create, rename, delete |
| Grants | by principal, by scope, effective access of a principal | issue, revoke |
| Skills | as [skills.md](./skills.md) | organization and layer skill: write, restore, clear |
| Connections | delegations in the organization | revoke |
| Access log | query, summarize | — |
| Notifications | — | send, alert rules |

**What is not here, and why:**

- **Passwords and keys.** A generated password or a service account key returned
  through a tool stays in the conversation with the model, and conversations are
  stored. Creating a person sends them a link to set their own where a mail relay
  is configured; otherwise the console resets it. Keys are minted in the console
  or the API. A panel could show one without the model seeing it, but only if the
  host does not keep panel results in the transcript — verified on a live host
  before anything relies on it, not assumed.
- **Second factors.** Never administered on somebody's behalf, on any surface.
- **Anything above the organization**: the installation's skill, tenants, quotas,
  the default model.

## Reading the access log

The log answers the questions an administrator actually asks, and an agent asks
them better than a filter form: who read this document, what did this
connection touch, why is this person denied, what changed in permissions this
week.

- **`query_audit`** — the same rows `GET /v1/audit` returns to an `org_admin`,
  with the same filters (actor, action, layer, document, outcome, time range),
  cursor-paged.
- **`summarize_audit`** — aggregates computed in the database, so an agent does
  not page through a million rows to count them: by actor, action, layer,
  document, outcome and day, over a bounded window. "Top readers of `contracts`
  this month", "denials per hour for this connection", "documents read by
  somebody who was disabled since".

The same rule as everywhere else in the log: an `org_admin` sees which documents
were read; nothing here widens that. Reading the log is itself recorded, as
`audit.read`, with the surface.

## Notifications

Only where a mail relay is configured, and **only to people in the
organization**: a recipient is a user id of an active user in the caller's own
organization, resolved to their address by the server. There is no field for an
address. That is the whole of the leak argument — an agent asked to "send the
log to auditor@elsewhere" has no way to name elsewhere.

- **`send_notification`** — to chosen users or to every `org_admin`, a subject and
  a plain-text body, bounded in length, through the confirmation panel like any
  other write. Sent in the brand's message layout with a line saying it was sent
  by an agent through the administrative connection, and by whom.
- **Alert rules** — kept by the organization and evaluated by the worker, so they
  work with no agent running: a skill written by an agent, a version adding
  scripts, an administrative connection approved, a spike in denials for one
  principal, documents failing in a layer. Each rule names its recipients the same
  way. Rules are created and removed through proposals.

Both are rate-limited per organization, and every message is in the log as
`notification.sent` with its recipients and the rule or connection behind it.

## Panels

| Panel | What it shows |
|---|---|
| Change | the proposed change, in full, with Apply and Cancel |
| Skill | as [skills.md](./skills.md), with versions, comparison and restore |
| Access | a matrix of people, groups and service accounts against layers, in the permission colours, computed by the resolver — "who sees `contracts`", "what does Petya see" |
| Layer | documents indexed, pending and failed; failures with their reason and a retry; the model, a reindex's progress, the recall gate |
| Access log | the rows, filterable, an actor pressed to narrow to them |
| Connections | who has connected what, as whom, with which ceiling, and a revoke |

Drawn in the brand like the existing three, with the host deciding light or dark.

## Commercial modules add tools here

`registerMcpTools(surface, ...tools)` is the point, specified in
[extensions.md](./extensions.md): `acl-advanced` adds document-scoped grants and
deny rules to this surface. A registered write goes through a proposal like a
core one — the point takes the proposal and the apply step, not a function that
writes directly — so a module cannot add a write that skips the panel.

## Audit

Every call from this surface is recorded with `surface: "mcp-admin"` and the
connection. Proposals that were never applied are recorded too, as
`proposal.expired` and `proposal.cancelled`: a stream of proposals nobody
applied is what an injection attempt looks like from the outside.

## Current state

Specified, with the authorization cases in `docs/authz.md` marked pending. Built
after skills, in this order: the resource, audience and consent; the read tools
and the access log; proposals and the change panel; the write tools; the other
panels; notifications and alert rules; the extension point.
