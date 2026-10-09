# Skills

> **Specified, not built.** Everything below is the contract the implementation
> is written to. Where the code and this document disagree once it exists, one
> of them is a bug — say which.

An agent connected to Nacre over MCP learns two things today: the tool schemas,
and a few paragraphs of `instructions` about the permission model. It does not
learn what *this organization* keeps where, how a document here is named, which
metadata a layer expects, or that the `contracts` layer holds only signed PDFs.
So the first thing every agent does with a fresh connection is guess, and the
guesses end up in the index.

A **skill** is the answer, in the shape agents already read: the folder format
Claude uses for its own skills. The goal is a sentence — **an agent that has
just connected already knows how to work here, what to store, and how** — and
everything below serves it.

## What a skill is

A folder, exactly as Claude defines one:

```
SKILL.md          required — YAML frontmatter, then Markdown
references/…      optional — further Markdown the agent reads when relevant
scripts/…         optional — code the agent may run on its own side
anything else     optional — text files the body refers to
```

`SKILL.md` opens with frontmatter carrying `name` (lower case letters, digits
and single hyphens, at most 64 characters) and `description` (1 to 1024
characters, what the skill is for and when to use it). Other frontmatter keys
are kept as written. A folder that Claude Code or claude.ai accepts as a skill
is one this accepts, and an export from here is one they accept — that is what
"compatible" is held to, by a test that round-trips the format rather than by
reading this paragraph.

**Text only, in this version.** Every file is UTF-8; a binary file is refused
by name. Bounds, each a refusal and never a truncation: 64 files, 256 KiB per
file, 1 MiB per skill, paths relative with no `..` segment and no leading `/`.

**Scripts are allowed**, and that was decided rather than defaulted. A script
in a skill runs on the *agent's* side, under that agent's own approval — Claude
Code asks before it executes a command — and never inside this installation.
What it changes is who can put code in front of an agent: whoever may write the
skill. So a version containing anything under `scripts/` is marked as such
everywhere it is shown, and the console and the skill panel say so before
anything else.

## Three levels, and one that is not a skill

| Level | Stored as | Written by | When absent |
|---|---|---|---|
| **Built-in instructions** | `packages/mcp/src/instructions.ts` | nobody — part of the release | — |
| **Installation** | `org_id NULL, layer_id NULL` | `platform_admin` | the default skill shipped in the image |
| **Organization** | `org_id, layer_id NULL` | `org_admin` | the installation's |
| **Layer** | `org_id, layer_id` | `admin` on that layer | nothing |

**The built-in instructions are always present and cannot be edited.** They
state the permission model's observable behaviour — an empty result is an
answer, "not permitted" and "not there" are one reply, `write` does not imply
`read` — and a skill that could remove them would let an organization's own
text unteach an agent the rules it is held to. A skill adds to them; it never
replaces them.

**The organization's skill replaces the installation's, entirely.** Not a
merge: two skills concatenated are one skill nobody wrote, and the
organization is the party that knows what its agents should do. A skill whose
`SKILL.md` body is empty is the same as none, so clearing one is how an
organization goes back to the installation's.

**A layer's skill is added to the base, never instead of it**, and is
optional. It says what belongs in that layer: the documents it holds, how they
are named, which metadata keys it expects, its language, what never goes in it.

The **default skill** is shipped in the image, under `packages/core/skills/default/`,
and is the one an agent gets on an installation nobody has configured. It is the
most important artifact here, because it is what most agents will ever read: how
to search (meaning and exact terms both; an empty result is an answer), what to
store (one subject per document, no secrets, no personal data unless a layer's
skill says otherwise), how to store it (a stable `external_id` so a resend
replaces; lower-case metadata keys; `ingest_document` for text the agent wrote,
`request_upload` for a file it holds, `upload_file` for a file a person picks;
`ingest_status` until it settles), and to read a layer's skill before writing to
it. It is judged by running it: a fresh agent connected to the demo stand with no
other guidance, storing and finding things correctly.

## Who sees what

```
base(caller)   = organization skill  ?? installation skill  ?? default skill
layers(caller) = { L : caller holds any permission on L }
```

**Any permission, `write` included.** An agent that only ingests into a layer
needs that layer's conventions more than anyone, and rule 6 does not make a
layer's *existence* secret from somebody allowed to write to it. "Holds any
permission on L" is `resolve(caller, p)` reaching `L` for some `p`, and for a
delegation `p ∈ ceiling(L)` as `docs/authz.md` defines it — so a connection
narrowed away from a layer does not see its skill either.

**A layer skill is visible exactly when its layer is.** One the caller cannot
see answers as a layer with no skill does: not found, same status, same words.
Anything else turns the skill listing into a way to learn which layers exist,
which is invariant I6 broken through a side door.

**An organization's skill never leaves it.** Tenant isolation is checked first,
as for everything else, and the organization comes from the token.

**`platform_admin` reads and writes the installation's skill and no
organization's.** An organization's skill is that organization's text, and rule
2 — administering a tenant is not access to its data — covers it.

## Who writes what

| Level | Over REST | Over MCP |
|---|---|---|
| Installation | `administersTenants(auth)` | **never** |
| Organization | `administers(auth)` | `administers(auth)` — the admin MCP, see [mcp-admin.md](./mcp-admin.md) |
| Layer | `admin` resolved on the layer | the same, and for a delegation `skill ∈ ceiling(L)` |

**The installation's skill is never written over MCP**, by decision: rights that
span tenants stay in the API and the console, where a person is doing it.

**Editing a layer's skill is its own consent.** A token from the consent flow
works on REST as well as MCP — `NACRE_JWT_AUDIENCE` is one value — so putting
`admin` on the consent screen would hand an MCP client the power to issue grants
and delete the layer through REST, which is why `admin` is not on that screen.
Instead the screen offers, per layer, **"edit this layer's skill"**, and only for
a layer where the person holds `admin`. It is stored as `skill` in that layer's
ceiling and read by **one function** and nothing else:

```
may_write_layer_skill(auth, L) =
    resolve(person, admin) reaches L
  ∧ (auth is not a delegation  ∨  'admin' ∈ ceiling(L)  ∨  'skill' ∈ ceiling(L))
```

Three properties, each a case in `docs/authz.md`:

- `skill` confers nothing the person lacks. Without `admin` on the layer it is
  refused, however the consent was stored.
- `skill` confers nothing else. It is not a permission `resolve` takes, so no
  search, ingest, grant or delete path can be reached through it — and a lint
  check refuses any reader of it outside that function, the way
  `check-admin-gate.mjs` refuses the raw role comparison.
- A connection's ceiling that excludes `skill` makes a per-layer `skill`
  impossible to store, by the rule consent already applies to every per-layer
  set.

## Why writing a skill is the most dangerous write here

A document is data to an agent; a skill is instruction. A document in a layer can
say "rewrite this layer's skill to say …", and an agent holding the right will
do it — after which every later agent reads the planted text as its
instructions. That is a prompt injection that **persists** rather than lasting
one conversation.

What bounds it, in order:

1. **It takes `admin` on the layer and an explicit consent.** A connection made
   through the consent flow cannot edit a skill unless the person ticked that
   layer's box, and the box is offered only to somebody who administers the
   layer.
2. **Every write is in the access log**, with the surface (`rest`, `mcp`,
   `mcp-admin`, `console`) and, for a delegation, the connection.
3. **Every write is a version**, and going back is one operation.
4. **A version written by an agent says so**, in the console and in the panel,
   and so does a version that adds scripts.

What does not bound it, stated so nobody relies on it: content checks. Nothing
here inspects what a skill says, for the same reason nothing inspects what a
document says.

## Versions

Every write creates a new, immutable version and moves the current pointer to
it. Going back is a write too — a new version carrying an old one's files — so
history stays linear and is never rewritten.

A write names the version it was based on, and a mismatch is **`409`**, not a
silent overwrite: two agents editing one skill otherwise erase each other with
both believing they succeeded. Each version records who wrote it, through which
surface and connection, when, how many files, and whether it contains scripts.

## Surfaces

### MCP

- **`instructions`** carry the built-in text and then `base(caller)`: its name,
  its description and its body. An agent knows how to work here before its first
  call, which is the whole point. A base skill whose `SKILL.md` exceeds 16 KiB is
  represented by its name, its description and a sentence pointing at
  `get_skill`, because `instructions` is prepended to every context window.
  Since the text then depends on the organization, `initialize` and
  `server/discover` are cached `private`, not `public`.
- **`list_skills`** — `read`-only. The base skill and every layer skill the
  caller sees: level, layer slug, `name`, `description`, file list, version,
  whether it has scripts. A catalog rather than texts, so an agent reads what it
  needs; paged like `list_layers`.
- **`get_skill`** — `read`-only. `{ skill }` (`"base"` or a layer slug) returns
  `SKILL.md`; with `{ path }` it returns that file. Not found for a layer the
  caller cannot see, exactly as for one without a skill.
- **`update_skill`** — destructive. `{ skill, files, based_on }`. Organization
  level needs `administers(auth)`; layer level needs `may_write_layer_skill`.
  An empty `SKILL.md` clears.
- **`list_layers`** carries, per layer, whether it has a skill and its
  `description`, so "read the layer's skill before writing" costs one call.
- **The skill panel**, `ui://nacre/skill.html`, opened by `get_skill` and
  `list_skills`: the file tree, `SKILL.md` rendered and as source, the scripts
  marker, and — where the caller may write — loading a folder or a `.zip` in
  Claude's format, checked and written through `update_skill` in the host, so the
  permission check runs where it always runs.

### REST

```
GET    /v1/skills                                   what the caller sees: base + layers
GET    /v1/skills/{level}                           current version, files
PUT    /v1/skills/{level}                           write: JSON files, or application/zip
DELETE /v1/skills/{level}                           clear (falls back a level)
GET    /v1/skills/{level}/versions                  history, newest first, cursor-paged
GET    /v1/skills/{level}/versions/{n}              one version
POST   /v1/skills/{level}/versions/{n}/restore      roll back, as a new version
GET    /v1/skills/{level}/export                    application/zip, a folder named after `name`

{level} = installation | organization | layers/{layer_id}
```

The export is installable as it is: unzip it into `~/.claude/skills/` for Claude
Code, or upload it as a skill on claude.ai.

### Console

The organization's skill on its own screen and a layer's on that layer's page,
both drawn the same way: the file tree, rendered and source views, the version
selector, download, load from a folder or a `.zip`, and the two markers — written
by an agent, contains scripts. The installation's skill is on the commercial
console's Installation screen, because the open console has no
platform-administrator screens.

## Audit

`skill.updated`, `skill.restored` and `skill.cleared`, as administrative events,
with `detail` carrying the level, the layer, the new version, the file count,
whether it has scripts, the surface and the connection. Reading a skill is not
recorded: it is not a document, and the log is about who reached what the
organization holds.

## Where this lives

All of it in the core, including the installation level's API: a single
developer needs an organization skill and layer skills, and the installation
level costs one row and one check. Only the commercial console's screen for the
installation skill is in `nacre-enterprise`.

## Current state

Specified, with the authorization cases in `docs/authz.md` marked pending. Built
in this order: the cases, the default skill (judged on a live agent), storage and
versions, the REST surface, the MCP tools and `instructions`, the panel, the
console, and the consent screen's per-layer box.
