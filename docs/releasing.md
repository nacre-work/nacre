# Releasing

What ships, from where, and the one part of it that a person has to do.

[upgrading.md](./upgrading.md) is the same event from the other side — what an
operator does when a release comes out. This is what happens inside the
repository to produce one.

## A release is a merge

A version is a string every publishable `packages/*/package.json` agrees on.
Merging that agreement to `main` **is** the release: no tag to push, no button.
`decide` reads the manifests and asks the registry; if the version names
something npm does not have, the pipeline runs every gate a pull request runs,
publishes, and writes the `v{version}` tag and the GitHub release **after** the
artifacts exist.

That means a release does not always need a version bump. Publishing is decided
by *what the registry is missing*, so a package added at the current version is
published on the next merge to `main` without one.

## What is published

| Package | Registry | |
|---|---|---|
| `@nacre.work/core` | npm, public | data model, resolver, shared types |
| `@nacre.work/api` | npm, public | REST API and authorization service |
| `@nacre.work/mcp` | npm, public | MCP server, and the `nacre-mcp` STDIO binary |
| `@nacre.work/sdk` | npm, public | the TypeScript client an application installs |
| `@nacre.work/cli` | npm, public | the `nacre` command a person runs |
| `@nacre.work/worker` | **not published** | reached through the image's entry point |
| `@nacre.work/admin` | **not published** | a static bundle the `web` front door serves |

`lint:publish` holds this table against the manifests: a package that is
publishable and absent here fails, and so does one listed here that has become
`private`. The table is not decoration — it is the thing that made somebody read
the section below.

Images are separate and are listed in [upgrading.md](./upgrading.md).

## Adding a publishable package

Four things, and **the last one is not automatic**.

1. **`publishConfig: { "access": "public" }`.** A scoped package defaults to
   `restricted` on npm. Without this the first publish either creates a private
   package — which anonymous `npx` cannot reach, and which returns `404` to
   anyone not logged in, so it looks like it was never published at all — or is
   refused outright depending on the account's plan.
2. **`files`, plus `LICENSE` and `NOTICE`.** Run `pnpm sync:legal`. Apache 2.0
   §4(a) and §4(d) travel with anything redistributed and npm collects them only
   from a package's own root, so a workspace with one copy at the repository
   root publishes neither. `lint:legal` fails without them.
3. **The same version as everything else.** They ship together and reference
   each other by exact version; one left behind publishes a tree that resolves
   to two different cores. `lint:publish` fails on a disagreement.
4. **Configure trusted publishing for the new name, by hand, on npmjs.com —
   before merging.**

### Why the fourth one cannot be automatic

The pipeline authenticates to npm with a short-lived token exchanged from a
GitHub OIDC token. Trusted publishing is configured **per package**, on the
package's own settings page — which does not exist until the package does. So
the very first publish of a new name is the one publish the pipeline cannot
perform.

The failure is worth recognising because it does not say what it is: npm falls
through to publishing unauthenticated and the registry answers **`404`, claiming
the package does not exist**. It reads as a typo in the name or a broken
registry. The publish step runs `npm publish --loglevel verbose` for exactly
this reason — the token exchange failing is logged at that level and nowhere
else.

And it fails **after** the merge, on `main`, on the commit that is already the
release. That is the shape this repository takes most seriously, which is why
this section exists rather than a comment somewhere.

The way through it, once:

```bash
# from the package directory, with a granular publish token
npm publish --access public
```

Then open the package on npmjs.com and add the trusted publisher for this
repository and the `release` workflow. Every later version publishes itself.

**Check it worked from outside**, not from the machine that published it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/@nacre.work%2F<name>
```

`200` is published and public. **`404` is not "not yet propagated"** — it is
either not published or published `restricted`, and those are the two states
this whole section exists to keep apart. An authenticated `npm view` cannot tell
you which, because it can see a restricted package; an anonymous request is the
only thing that answers the question a user will be asking.
