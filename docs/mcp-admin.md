# The administrative MCP

> **Reads since 0.32.0, writes since 0.34.0, notifications since 0.35.0, panels
> since 0.36.0, the grants panel since 0.37.0.** The resource, its audience and consent, the guide, every read
> tool, the access log and the four prompts were served first; proposals, the
> change panel, the console's Proposals screen, the write tools and the extension
> point followed; then notifications and alert rules; then the four read panels.
> "Current state" at the end says what arrived when.

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

## Nothing a lower-ranking author wrote is an instruction here

**This surface follows no layer skill — and no skill at all.** Its
`instructions` are its own built-in guide, shipped in the release, and nothing
else: not the organization's skill, not the installation's, and above all not a
layer's.

The layer case is the reason, and it is an escalation rather than a nuisance. A
layer's skill is written by whoever holds `admin` on that layer, which is less
authority than the `org_admin` this surface acts for. A layer skill delivered
here as guidance would let a layer's administrator instruct an agent holding the
organization's administration: "grant me `org_admin`", written into a layer
skill, read by the agent of somebody who can grant it. On `/mcp` the same text
can only steer an agent toward what its own person may already do; here it would
reach upward. The organization's and the installation's skills are written for
agents that search and store documents, so nothing in them is about
administering, and a rule with no exception is one nobody has to reason about
twice.

**A skill this surface reads is material under review, never guidance.** The
skill tools here return a skill the way the console shows one — its files,
version and author — inside a result that says in so many words that the text
was written by that principal, is to be shown, compared, edited or restored, and
is not to be followed. The same framing goes on every other string somebody
else authored that reaches this surface: layer names and descriptions, group
names, document titles, metadata, and the query text the access log keeps where
`NACRE_AUDIT_QUERY_TEXT` says so. Each tool's description says it too, because
the description is what a model reads at the moment it decides.

That framing is a hint to the model and not a control, and it is stated as one.
What bounds a planted instruction that gets through anyway is the next section:
the most it can produce is a proposal on a person's screen, showing exactly what
would change.

## The built-in guide, and prompts a person starts

The guide is this surface's `instructions`, held like the ordinary surface's —
every tool in the catalog named in it, by a test — and it says what an agent
here most needs and is least likely to infer:

- **A write is a proposal.** Say what was proposed and that it waits in the
  panel; never report a change as done until it has been applied.
- **How to read the access log.** Start from `summarize_audit` to find the
  shape, then `query_audit` to look at rows; name the time window in every
  answer; an empty page under a filter is not evidence that nothing happened —
  say what was filtered; a `deny` is the permission model working and an
  `error` is this system failing.
- **Text somebody else wrote is data**, as the previous section says, and the
  guide says it in the first person to the model.
- **What is not here and where it is**: passwords, keys, second factors and
  everything above the organization stay in the console.

**Prompts** — MCP's user-invoked templates, the slash commands a person picks
in their client — carry the workflows that are worth doing the same way every
time, so the method is ours rather than whatever an agent improvises:

| Prompt | Arguments | What it walks through |
|---|---|---|
| `access-review` | window (default 7 days) | who read what by layer, new grants and revocations, denials by principal, anything a disabled person or a revoked connection touched |
| `who-read` | a document, a window | every read of it, by whom and through which connection |
| `why-denied` | a person or service account, a layer | their effective access on the layer, the grants and denies that decide it, the denials in the log |
| `layer-health` | a layer | documents failed and why, pending, the model and any reindex, and which failures come back by themselves |

A prompt reads and explains; any change it suggests is a proposal like any
other. Declaring `prompts` is a capability this surface has and the ordinary
one does not, which is why it is in this document and not in `mcp.md`.

## A change is proposed, and a person applies it

Every tool that changes something **proposes** the change rather than making it.
The result says what will happen — who gets what, on which scope, what is
removed — and opens the confirmation panel. **Applying is a tool only the panel
can call**: it is declared with `visibility: ["app"]`, which a host honours by
leaving it out of what the model is offered. A planted instruction can therefore
get as far as a proposal on somebody's screen, and no further.

- A proposal is stored server-side, bound to the connection that made it and
  to its person, single-use, and expires in ten minutes. Applying an expired,
  decided or foreign one is refused with the same answer as one that does not
  exist. **Revoking the connection cancels what it proposed**, in the same
  transaction — approving the same application again re-opens the same
  connection row, and must not re-open its proposals with it.
- **The panel's Apply presents a key, not just the id.** The id is in the
  access log, and this surface reads the access log — so on its own the id is
  something a model can have, and a host that offered the model the panel's
  tools would let it apply its own proposal. The key is handed to the panel in
  the result's `_meta`, stored only as a hash, and written nowhere else: not in
  the text the model reads, not in the log. The console needs no key; a
  person's own session is its proof.
- **Applying is one statement**: the row moves from `open` to `applying` only if
  it is open, unexpired, and the caller's — so two presses, two tabs or the
  panel and the console at once apply it exactly once.
- Everything the panel and the console show is the server's own sentence,
  written from names it resolved, never text the model typed.
- **A client that cannot render panels** — a terminal, say — leaves the proposal
  on the console's **Proposals** screen, which is the same Apply and Cancel for
  the same person and nobody else: the API answers those routes for a person's
  own session and for nothing a connected application holds, so the model
  cannot reach that screen either. The result the model reads names the screen,
  and while something is waiting the console says so in a line above every
  screen.
- There is **no "apply directly" setting.** It was specified as an
  organization's choice for clients without panels and dropped once the console
  could hold the button instead: every way of making that switch safe ends up
  being a person pressing Apply somewhere, and the console is somewhere.

What this guarantee rests on is stated rather than implied: a host that keeps
the result's `_meta` from the model, which is what `_meta` is for. A host that
also offered the model the panel's tools — anything that does not know
`visibility: ["app"]` — still gives it nothing to apply with, because the key
is not in anything the model reads. A host that handed the model `_meta` *and*
the tools would let it apply only proposals its own connection made, to the
organization its person administers.

## Tools

All read tools are `readOnlyHint`; every write is `destructiveHint` and goes
through a proposal.

| Area | Read | Write — each a proposal |
|---|---|---|
| People | `list_people`, `list_service_accounts` | `create_person` (no password), `set_person_role` (`member` / `org_admin`), `disable_person`, `enable_person` |
| Groups | `list_groups`, `get_group` | `create_group`, `delete_group`, `add_group_member`, `remove_group_member` |
| Workspaces and layers | `list_workspaces`, `list_layers`, `layer_status` | `create_workspace`, `create_layer`, `update_layer` (name, description), `delete_layer` |
| Grants | `list_grants` by principal or scope, `effective_access` | `issue_grant`, `revoke_grant` |
| Skills | `list_skills`, `get_skill` — returned as material under review, see above | `write_skill`, `restore_skill`, `clear_skill`, for the organization's skill and a layer's |
| Connections | `list_connections` | `revoke_connection` |
| Access log | `query_audit`, `summarize_audit` | — |
| Notifications — where a mail relay is configured | `list_alert_rules` | `send_notification`, `create_alert_rule`, `remove_alert_rule` |

Every write names things the way a person does — an address, a group's name, a
layer's slug — and the proposal is where those names are resolved, so what the
panel shows is what was found rather than what was typed. A name that matches
nothing, or more than one thing, is refused there, before anything is stored.

**A skill is proposed whole.** A skill is the instructions every later agent on
a layer follows, and the agent proposing one may be carrying an instruction it
read in a document — so `write_skill` and `restore_skill` show the person every
file's text, `SKILL.md` first, rather than a list of paths. A skill is checked
when it is proposed, so the person is never asked to apply one the write would
refuse. One longer than 40,000 characters across its files is refused rather
than shown in part, because the part not shown is where an instruction would
sit. A person writes a larger one on the console's Skills screen or in the skill
panel, where the write is theirs.

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

### How it is built

**Three bounds on who receives one, and T35 asks each.** The tool resolves every
address or id it is given to an active person in the caller's organization, and
refuses the call naming whatever did not resolve — before a proposal is stored,
which is "refused before a message is composed". Somebody in another
organization and an address nobody has are the same refusal, word for word, or
the tool is an oracle for which addresses this installation knows. Applying
resolves the stored ids again, because somebody disabled in the ten minutes
between is somebody the organization has just decided should not be reached.
And the worker reads each address at the moment it sends, from `users` in the
notification's own organization, active accounts only: a row written straight
into the outbox naming somebody elsewhere reaches nobody, and the case that
asks so writes one.

**What is stored is ids.** `notifications` and `alert_rules` (migration 0040)
carry `uuid[]` and a flag for "every `org_admin`" — there is no column an
address could be written into, so an agent asked to send the log to an auditor
outside has no field to name them in, and neither does anything after it.

**No links.** The body is somebody's prose sent from the installation's own
address, which is the exact shape of a phishing message on a surface whose
threat model is a planted instruction. A URL — a scheme, `www.`, or a dotted
name followed by a path — is refused in the subject and the body, with the
reason; the one link in the message is to the access log, built from
`NACRE_CANONICAL_URL`. The subject is one line and the body is plain text,
paragraphs separated by a blank line, 200 and 4,000 characters.

**The message says where it came from.** `Nacre:` before an agent's subject and
`Nacre alert:` before a rule's, and a last line naming the application the
administrative connection was approved for and the person who applied it — or
which kind of rule fired and who set it up. One message per address, so nobody
sees who else received it.

**Thirty an hour per organization**, agents and rules together, counted in the
statement that queues one under a per-organization lock. Over it, applying is
refused with that sentence; a rule's message is held and found again on a later
pass rather than lost. Fifty rules per organization.

**Alert rules** are answered from what the database already records — skill
versions, the access log, the documents table — so none needs a hook in the code
that does the thing:

| Kind | Fires when | Narrowed by |
|---|---|---|
| `skill_by_agent` | a skill version is written by an agent: over MCP, through a delegation, or by a service account | a layer |
| `skill_scripts` | a skill version adds scripts its predecessor did not have | a layer |
| `admin_connection` | an administrative connection is approved | — |
| `denial_spike` | one principal is denied at least `threshold` times within `window_minutes` | — |
| `documents_failed` | at least `threshold` documents fail to index within `window_minutes` | a layer |

The worker looks at each rule about once a minute and a counting rule fires at
most once per window, so a spike lasting an hour is one message and not sixty.
An alert names layers by slug and people by address, and never a document's
title or anything in it. An application's registered name is the one string an
alert carries that somebody outside the organization chose, so it is put on one
line and broken where a mail client would make it a link.

**At most once.** A message is claimed before it is sent and never claimed
twice; a worker that dies between the two leaves it `sending`, and fifteen
minutes later it is marked `failed` rather than sent again. A relay that refuses
is retried twice more, backing off; a message nobody could send within a day is
`dropped`; each of those is a `notification.sent` with `result: "error"` and the
reason, which is where an administrator finds the message that did not go. A
finished message's body is deleted after thirty days — the record of it is the
access log's, and the text has no reason to outlive the month it was sent in.

**Offered only where there is a relay.** The MCP transport reads
`NACRE_MAIL_FROM` — the half of the pair that is not a secret — to decide
whether to offer the four tools; the worker holds the relay and sends; the API
holds it too, and composes the writes into the console's Proposals screen only
where it does. A proposal made while a relay was configured and applied after it
was removed finds no tool, and is refused rather than queued for nobody.

## Panels

A panel is an MCP App view the host renders beside the answer, and it reaches
the server through the host with the same connection and nothing else: every
one is listed with no network of its own. Five open from a read and one from a
write.

| Panel | Opened by | What it shows |
|---|---|---|
| Change | every write | the proposed change, in the server's own sentence, with Apply and Cancel |
| Access log | `query_audit` | the rows the model was handed, newest first — the action, who, the result in one column of one size; an actor pressed narrows to that actor, and More reads the next page |
| Connections | `list_connections` | who has connected what, as whom, through which surface, with which ceiling, and when it was last used; Revoke proposes `revoke_connection` from the panel |
| Access | `effective_access` | one principal's reach as a matrix of layers against `read`, `write` and `admin` in the permission colours, computed by the resolver search uses, with the grants that decide it; anybody else can be asked from the panel |
| Layer | `layer_status` | documents indexed, pending and failed; the most recent failures with their reason and whether each comes back by itself; the model, a reindex's progress, the recall gate |
| Grants | `list_grants`, and a module's read that names it | grants as issued — who, on what, which permission, allow or deny — with Revoke on every row, and, where the read was about a scope, a form to give or deny access there |

**A press in a panel is a proposal like the model's.** Revoke calls the same
write the model would, the server's sentence appears under the table, and the
person applies it with the key the result handed the panel — so a panel adds no
path that skips the person, and nothing a panel does is anything the model could
not have proposed.

**The Access panel is one principal against every layer**, not every principal
against one layer. "What does Petya see" is one call to the resolver; "who sees
`contracts`" is one call per principal, and a panel that made them would be
issuing reads nobody asked for. The model answers the second from `list_grants`
on the scope and `effective_access` for whoever it names, and cites both.

**The Grants panel is where access is changed from a conversation.** Listed by
a layer or a workspace, it offers `issue_grant` on that scope from a form under
the table; listed by a person alone there is no scope to fix and no form. Revoke
on a row is `revoke_grant`, which withdraws any grant by id — a module's
included. What the form may offer is not the panel's to decide: the server
attaches it to the result in `_meta`, and only writes in this surface's catalog
survive into it. A module's read can open this panel too — `acl-advanced`'s
`list_document_grants` does, offering `issue_document_grant` and `issue_deny` with
a document field — which is how a document's access is set without leaving the
conversation. See [extensions.md](./extensions.md), "A read can open a core
panel".

**The Layer panel offers nothing to press.** Retrying a failed document is a
write on its layer, and this surface's connection holds `read` and `admin` but
not `write`, because it changes no documents — so a Retry here would be refused
on every press. A failure the worker retries by itself says so; one that will
not says that instead, and the answer to it is fixing the cause and re-sending
the document, or `POST /v1/documents/{id}/retry` by somebody who may write to
the layer. Widening the ceiling of every administrative connection already
approved, to add one button, is not a trade this surface makes.

**There is no skill panel here**, deliberately. On this surface a skill is
material under review — it was written by somebody with less authority than the
administrator the session acts for — and rendering its Markdown inside that
session is the presentation the review notice exists to avoid. A skill is read,
compared and restored on the console's Skills screen, and a proposed write to one
is shown in the change panel like any other.

Drawn in the brand like the ordinary surface's views, with the host deciding
light or dark, and rendered at 600 and 390 in both themes by `lint:apps`.

## Commercial modules add tools here

`registerMcpTools(surface, ...tools)` is the point, built in 0.34.0 and
described in [extensions.md](./extensions.md): `acl-advanced` adds
document-scoped grants and deny rules to this surface. A registered write is two
functions — `propose`, which resolves and describes and changes nothing, and
`apply`, which the core calls only when the person applies — so a module cannot
add a write that skips the panel: the shape has no third way. A proposal records
which module made it, and is refused if that module is no longer the one
offering the tool. A name the core already uses, or that two modules both
register, stops the process at startup rather than shadowing a tool somebody
believes they called.

## Audit

Every call from this surface is recorded with `surface: "mcp-admin"` and the
connection — including the ones that were refused: a read that failed, a write
whose names matched nothing, a press on a proposal that was not there to press.
A proposal leaves `proposal.created` when it is made and one of
`proposal.applied`, `proposal.cancelled` or `proposal.expired` when it is
decided — the last written by the worker, which sweeps them once a minute, and
a revocation writing `cancelled` for each one it ends — and an applied one also
leaves the ordinary record of the change itself, with the proposal's id beside
it. A stream of proposals nobody applied, or of presses that were refused, is
what an injection attempt looks like from the outside.

A decided proposal is kept as long as those events are, and goes with them at
`NACRE_AUDIT_RETENTION_DAYS` — never one still waiting. And at most 25 wait on a
connection at once: past that the next is refused, recorded like any other
refusal, with a sentence asking the person to decide what is waiting first. A
queue longer than a person will read is an agent in a loop, or an injected
instruction asking for the same change again and again.

## Current state

**Built in 0.32.0** — the half every write will rest on:

- `/mcp/admin` on the MCP process, its RFC 9728 document at
  `/.well-known/oauth-protected-resource/mcp/admin` (served by the transport and
  by the API, because a front door sends `/.well-known/` to the API), and a `401`
  naming that document.
- The audience `${NACRE_JWT_AUDIENCE}/admin`, chosen when a token is minted from
  the connection's `surface` (migration 0038) — on the first exchange and on
  every renewal, since a renewal has no request to read a resource from.
  Authentication refuses an administrative connection anywhere else and an
  ordinary one here, refuses an agent's key and an identity provider's
  assertion here, and requires `org_admin` on every request; renewal suspends a
  connection whose person has lost the role. T31.
- The consent: an RFC 8707 indicator naming `/mcp/admin` makes the request the
  administrative one — `org_admin` only, as the person, no layers, no
  permissions — and the console draws it as one decision with what it may and
  may not do. Connections label every row **MCP** or **admin MCP**.
- `instructions` are the built-in guide and nothing else; `get_skill` returns a
  skill under a notice saying it is under review; every result carrying text
  somebody wrote opens with a notice saying it is data. T39.
- Thirteen read tools: `list_people`, `list_service_accounts`, `list_groups`,
  `get_group`, `list_workspaces`, `list_layers`, `list_grants` (by principal or
  scope, in SQL), `effective_access` (computed by the active resolver, with the
  groups and grants that decide it), `list_skills`, `get_skill`,
  `list_connections`, `query_audit` and `summarize_audit` (grouped in the
  database, over a window of at most 366 days, counting a search that *returned*
  a document as well as a fetch of it).
- The four prompts.
- Every call recorded with `surface: "mcp-admin"` and the connection —
  `audit_events.client`, in the schema since 0001 and written by nothing until
  now, carries `connection:<id>` for **every** delegated request on every
  surface, because the scope is entered once per request rather than at
  fifty-nine call sites.

**Built in 0.34.0** — the writes, all of them proposals:

- `admin_proposals` (migration 0039): bound to the connection and its person by
  composite keys, under row-level security, ten minutes long.
- The eighteen write tools in the table above, and the change panel
  (`ui://nacre/change.html`) a write opens. Apply and Cancel are the app-only
  tools `apply_proposal` and `cancel_proposal`, left out of the catalog of a
  client that declared no panels.
- The console's **Proposals** screen and `GET /v1/proposals`,
  `POST /v1/proposals/{id}/apply` and `…/cancel` — a person's own session only.
- `proposal.created`, `proposal.applied`, `proposal.cancelled` and
  `proposal.expired`, and the worker's expiry sweep. T32.
- `registerMcpTools`, for a module's read and write tools on this surface.

**Built in 0.35.0** — notifications and alert rules, as above:

- `notifications` and `alert_rules` (migration 0040), under row-level security,
  holding user ids and never an address.
- `send_notification`, `create_alert_rule` and `remove_alert_rule`, each a
  proposal, and `list_alert_rules` — offered only where a relay is configured.
- The worker's evaluator and sender, every thirty seconds, at most once, and
  `notification.sent` for each message whatever became of it. T35.
- The `oauth.consent` event records which surface a connection is for, which the
  `admin_connection` rule reads.

**Built in 0.36.0** — the read panels:

- `ui://nacre/audit.html`, `connections.html`, `access.html` and `layer.html`,
  opened by `query_audit`, `list_connections`, `effective_access` and the new
  read tool `layer_status`, each listed with an empty `connectDomains`.
- Revoke in the Connections panel, as a proposal applied with the panel's key.

**Built in 0.37.0** — the grants panel:

- `ui://nacre/grants.html`, opened by `list_grants` and by any module read that
  names it; a form proposing what the server offers in `_meta['nacre/panel']`,
  and Revoke on every row.
- `McpReadTool.panel` in `registerMcpTools`, and the core's check that an offer
  names a write on this surface.

Nothing here is specified and unbuilt.
