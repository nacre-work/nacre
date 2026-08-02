# Contributing

## Language

**English, American spelling, everywhere.** Code, comments, commit messages,
branch names, issues, pull requests, and documentation. Contributors come
from everywhere; a single language keeps the history readable for all of them.

## Before you write code

For anything substantial, open an issue or a discussion first. Especially if
it touches the permission model — we're conservative there and will ask you
to justify the change.

## Non-negotiables

**Changes under `packages/core/authz` require two maintainer approvals** and
must come with tests. The `acl-invariants` CI job is required: it runs the
T1–T15 suite plus a property-based test against the reference resolver.
If your PR turns it red, that isn't a flake — go read the failure.

Never, in any PR:

- filter search results after they come back from the vector database;
- accept `org_id` from a request body, path, or header;
- return `403` where the object is invisible — it must be `404`;
- log document contents or full query text.

## Process

1. Fork, branch from `main`.
2. `pnpm install && pnpm test`.
3. Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`.
4. Open a PR using the template. One PR, one topic.
5. Squash merge, linear history.

## Local development

```bash
pnpm install
docker compose --profile minimal up -d postgres qdrant redis
pnpm --filter @nacre.work/api dev
```

## Contribution license

Contributions are covered by the **Contributor License Agreement** in
[CLA.md](./CLA.md). Read it once and sign it once; it then covers everything you
send afterwards.

**You keep the copyright in what you write.** This is not an assignment. What
the agreement adds on top of Apache 2.0 is the right to sublicense — which is
what lets the core's licence change in the future without tracking down every
past contributor for permission. It cannot take back any licence already
granted: every Apache 2.0 release stays Apache 2.0, permanently.

If your employer has rights to what you write — which is more often true than
people expect — section 4 of the agreement is the one to read before you sign.

### Signing

No third-party service, no account, nothing that leaves this repository. Open a
pull request that adds you to `.github/cla/signatures.json` and changes nothing
else:

```json
{
  "github": "your-github-username",
  "name": "Your Full Name",
  "emails": ["every@address.you", "author@commits.from"],
  "version": "1.0",
  "date": "2026-08-02"
}
```

with this in the body:

> I have read the Nacre Contributor License Agreement version 1.0 and I agree to
> it for my present and future Contributions to Nacre.

List every address you commit from. The `cla` job compares commit metadata, not
GitHub accounts, so an unlisted address reads as an unsigned contributor — which
is the point: the commit is what carries the copyright.

A pull request touching only that file skips the `cla` job, because otherwise
signing would be blocked by the check it exists to satisfy. That is safe: the
job reads the signature list from the base branch and never from the pull
request under test, so a contribution cannot approve itself.

Your actual work can be opened before or after signing — it just will not merge
until the signature does.

### This replaced a DCO that nothing enforced

The previous rule was "sign off with `git commit -s`, no CLA required", and no
job ever checked for a `Signed-off-by` line. A requirement stated and not in
force is worth nothing legally and worse than nothing in practice: it reads as
though provenance is being tracked when it is not. The `cla` job is why this
line is different.
