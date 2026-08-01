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

We use the DCO. Sign off your commits with `git commit -s`. No CLA is
required for contributions to the core.
