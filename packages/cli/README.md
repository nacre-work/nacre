# @nacre.work/cli

The command line client for a [Nacre](https://nacre.work) installation.

Longer than its sibling packages' READMEs on purpose: the others are libraries
an application imports and this is the one thing a person runs, so this page is
where they land.

```bash
npx @nacre.work/cli login --url https://api.example
npx @nacre.work/cli layers create handbook --name Handbook
npx @nacre.work/cli ingest ./docs --layer handbook
npx @nacre.work/cli search "when do new hires get access"
```

## Commands

| | |
|---|---|
| `login --url <url>` | sign in and remember the session. `--email`, `--org` optional |
| `whoami` | which principal this session is, and where |
| `layers` | the layers you can read |
| `layers create <slug>` | `--name`, `--description`, `--workspace`, `--provider` |
| `grant <permission> <scope> --to <principal>` | see below |
| `ingest <file\|dir>... --layer <slug>` | index text files and wait. `--watch` keeps going |
| `search <query>` | `--layer`, `--top-k` |
| `eval --layer <slug>` | score the layer's reference queries. `--top-k`, `--floor` |

`--json` prints the response as JSON for a script rather than a person.

A **scope** is `layer:<slug>`, `workspace:<slug>` or `document:<id>`. A
**principal** is `user:<id>`, `group:<id>` or `service_account:<id>`.

## Administering an organization

All of these need `org_admin`, and a member gets the same `404` for them as for
anything else invisible.

| | |
|---|---|
| `users` | everyone, with role and state |
| `users create <email>` | `--admin` for `org_admin`. The password is **generated** and shown once |
| `users password <id>` | issue a new one, shown once |
| `users role <id> <member\|org_admin>` | |
| `users disable <id>` | the row is kept — the access log names that id |
| `groups` | teams a grant can name |
| `groups create <name>` / `groups delete <id>` | deleting takes the group's grants with it |
| `groups members <id>` | |
| `groups add\|remove <id> <user:id\|group:id>` | |
| `service-accounts` | keys, with prefix and last use |
| `service-accounts create <name>` | the key is shown once |
| `service-accounts revoke <id>` | |
| `audit` | the access log. `--action`, `--actor`, `--result`, `--from`, `--to`, `--limit` |

**A password is never given, only generated.** `--password` is refused rather
than passed on: an argument ends up in a shell history, and a password an
administrator chose is a password they know. The same applies to a service
account key — it exists in the response that created it and nowhere afterwards,
because what is stored is a hash.

**`audit --limit` counts records, not pages.** It follows the cursor to the end
of what was asked for. Asking for one page cannot tell a working cursor from a
stuck one, and this API's pagination has shipped broken in both directions —
once repeating a row forever, once skipping everything between a truncated bound
and the real value.

## The session

`login` writes `~/.config/nacre/config.json` at mode `0600`, in a directory at
`0700`. It holds a refresh token, which renews itself and so outlives the access
token beside it; on a shared machine a default umask would leave that readable
by everyone.

`NACRE_API_URL` and `NACRE_TOKEN` override the file. That is what CI uses: there
is no terminal to sign in from and nothing that could write a renewed token
down, so the environment is the whole session — and the file's refresh token is
deliberately not paired with it.

## Exit codes

| | |
|---|---|
| `0` | it worked |
| `1` | the request was refused, or a document failed to index |
| `2` | the invocation was wrong, and repeating it will fail the same way |

A script that cannot tell `1` from `2` retries the second one forever. **An
ingest where any document failed exits `1`** with the per-document summary still
on stdout, so a nightly pass cannot report success having indexed nothing.

## Two things that are not bugs

**Permissions are not a ladder.** `write` does not imply `read`; `admin` implies
both. An ingest-only service account holds `write` and cannot search back what
it wrote.

**"Not found" and "not allowed to see it" are the same answer.** The server
returns `404` for both, deliberately and everywhere, so this client cannot tell
you which one happened and does not guess.

## What it does not do

- **Upload binaries.** Text files only; a PDF goes through
  `POST /v1/documents` as `multipart/form-data`.
- **Delete anything while watching.** A file disappearing is indistinguishable
  from the first half of how every editor saves, so `--watch` never removes a
  document. That is `DELETE /v1/documents/{id}`, by hand.
- **Administer an installation.** Creating organizations, users and service
  accounts is the API and the admin UI.

Apache 2.0. Full documentation at
[github.com/nacre-work/nacre](https://github.com/nacre-work/nacre/tree/main/docs).
