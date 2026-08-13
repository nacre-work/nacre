# @nacre.work/sdk

The TypeScript client for a [Nacre](https://nacre.work) installation — a
self-hosted knowledge index where **search returns exactly what the caller is
permitted to see**, and nothing else.

```bash
npm install @nacre.work/sdk
```

```ts
import { NacreClient } from '@nacre.work/sdk'

const nacre = new NacreClient({ baseUrl: 'https://api.example', token })

await nacre.documents.add({
  layer: 'handbook',
  externalId: 'onboarding.md',
  title: 'Onboarding',
  content: text,
})

const hits = await nacre.search('when do new hires get access', { topK: 5 })
//    ^ five results this caller may read. Not five filtered down to two.
```

Zero dependencies. `fetch` is in every runtime this targets, and a client for a
security product is the wrong place to inherit a dependency tree.

## What it reaches

Every operation in the REST contract: documents, search, layers, workspaces,
grants, users, groups, service accounts, connections and their permission
ceilings, embedding providers, reference queries and reindexing, the access log,
and sign-in. A test compares this client against
[`docs/openapi.yaml`](https://github.com/nacre-work/nacre/blob/main/docs/openapi.yaml)
in **both** directions, so an operation in the contract and not here is a build
failure — and so is a method here reaching something the contract does not
describe.

## Three things that surprise people, and none of them is a bug

**`top_k` means `top_k`.** The permission filter runs *inside* the index
traversal rather than over the results, so asking for ten permitted matches
returns ten. Nothing over-fetches and trims.

**No method takes an organization.** Not as an option, not as an administrator
override, not anywhere. The organization comes from the token; the server
refuses a request that names one, which from inside an application would read as
a bug in this library. Making it unrepresentable is cheaper than explaining it.

**`get`-shaped methods answer `undefined`, not an exception, on 404.** The API
returns the same `404` with the same wording for "no such document" and "not
yours" — deliberately, so nobody can probe for what exists. There is no
information here to tell those apart, and `undefined` says exactly what the
server said.

One more, from the model rather than the client: **`write` does not imply
`read`.** `admin` implies both. An ingest-only service account can write into a
layer and cannot search back what it wrote. This is the opposite of most
permission systems and is not something to work around.

## Sessions

`auth.login` returns tokens rather than mutating the client, so which identity a
client object holds never depends on call history. Pass `refreshToken` and
`onTokens` and the client renews itself through its own `fetch` seam — no view
or call site needs to know a session can expire.

## Related

| | |
|---|---|
| [`@nacre.work/cli`](https://www.npmjs.com/package/@nacre.work/cli) | the `nacre` command, built on this client |
| [`@nacre.work/mcp`](https://www.npmjs.com/package/@nacre.work/mcp) | the MCP server an agent connects to |

Apache 2.0. Documentation, the REST contract and the permission model:
[github.com/nacre-work/nacre](https://github.com/nacre-work/nacre/tree/main/docs).
