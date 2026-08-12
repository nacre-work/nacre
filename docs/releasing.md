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

The way through it, once — and **`pnpm pack` first is not optional**:

```bash
pnpm --filter @nacre.work/<name> pack --pack-destination /tmp
npm publish --access public /tmp/<name>-<version>.tgz
```

Then open the package on npmjs.com and add the trusted publisher for this
repository and the `release` workflow. Every later version publishes itself.

### Why not a bare `npm publish` from the package directory

Because it produces a package nobody can install, and it does it silently.

A workspace dependency is written `"@nacre.work/sdk": "workspace:*"`, and
**`pnpm pack` is what rewrites that into a concrete version**. npm does not
understand the protocol and does not try: it publishes the manifest as written,
`workspace:*` and all, and then every `npm install` and every `npx` fails on
resolution. Nothing about the publish itself fails — the tarball uploads, the
page renders, the version appears.

This is not hypothetical and it is not a hypothetical this document invented.
`@nacre.work/cli@0.14.3` was published exactly this way, from a version of this
page that said `npm publish --access public` and nothing else. The registry
holds it with `{"@nacre.work/sdk":"workspace:*"}` while every package the
pipeline published carries `{"@nacre.work/core":"0.14.3"}`.

The knowledge already existed, in a comment in `.github/workflows/release.yml`
above the two commands the pipeline runs:

> `pnpm pack` still packs, because it is what rewrites `workspace:*` into a
> concrete version. npm publishes the manifest as written, protocol and all,
> and every install then fails on resolution.

A rule that lives only in a comment does not travel to the next file, which is
this repository's own stated lesson about `workflow_dispatch`. It travels now:
`lint:publish` holds this page's procedure against the workflow's, so a
divergence fails rather than being discovered on the registry.

### Fixing a manifest that reached the registry

Do not unpublish. Removing the only version of a package takes the name out of
circulation for 24 hours and the trusted publisher configured against it with
it, which turns a bad manifest into a bad manifest *and* no way to replace it.

Bump the version across every publishable manifest and merge — the pipeline
republishes all of them correctly, because it packs with pnpm. Then mark the
broken one so nobody installs it by pin:

```bash
npm deprecate @nacre.work/<name>@<version> "broken manifest, use <next>"
```

**Check it worked from outside**, not from the machine that published it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/@nacre.work%2F<name>
```

`200` is published and public. **`404` is not "not yet propagated"** — it is
either not published or published `restricted`, and those are the two states
this whole section exists to keep apart. An authenticated `npm view` cannot tell
you which, because it can see a restricted package; an anonymous request is the
only thing that answers the question a user will be asking.
