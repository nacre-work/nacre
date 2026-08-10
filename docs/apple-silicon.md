# Nacre on Apple Silicon

An M-series Mac — M1 through M4 — is arm64, and running an amd64 container on
one means emulation. This page is the arrangement that avoids it, and an honest
account of the one part that cannot.

Most of the stack was never the problem: Compose builds this repository's images
locally, so they have always been native here, and every third-party image in
every profile ships arm64 except one. The two things this page is actually for
are that one exception — the embedder — and the published images, which a Helm
deployment pulls and which were amd64-only until 0.5.2.

> **What has been checked, and how.** Every architecture claim below was read
> off the registry with `docker buildx imagetools inspect`, not from a README —
> the table is a transcript. The images this repository publishes are built for
> both architectures by the release workflow, and CI builds the arm64 image on
> every pull request, **starts it under emulation** and asserts that it reaches
> configuration validation, so a cross-build that produces an image nobody can
> run fails here rather than on somebody's laptop.
>
> What has **not** happened is a run on actual Apple hardware — there is none in
> CI, and there is none behind this page. Where that matters the text says so
> rather than implying otherwise.

## What is native and what is not

| Image | Architectures | On an M-series Mac |
|---|---|---|
| `ghcr.io/nacre-work/nacre` | amd64, arm64 | native, from 0.5.2 — and see below |
| `ghcr.io/nacre-work/nacre-parser` | amd64, arm64 | native, from 0.5.2 — and see below |
| `postgres:17-alpine` | 386, amd64, arm, **arm64**, ppc64le, riscv64, s390x | native |
| `qdrant/qdrant:v1.18.3` | amd64, **arm64** | native |
| `redis:7-alpine` | 386, amd64, arm, **arm64**, ppc64le, riscv64, s390x | native |
| `nginx:alpine` (the admin UI) | 386, amd64, arm, **arm64**, … | native |
| `minio/minio`, `minio/mc` (`full`) | amd64, **arm64**, ppc64le | native |
| `quay.io/keycloak/keycloak:26.0` (`airgapped`) | amd64, **arm64** | native |
| `ghcr.io/huggingface/text-embeddings-inference:cpu-1.6` | amd64 | **emulated** |

One row is different, and it is the embedder and the reranker — the same image
serves both. Text Embeddings Inference publishes no arm64 build: not for
`cpu-1.6`, not for `cpu-1.7`, `cpu-1.8` or `cpu-latest`, and there is no
`arm64`, `aarch64` or `metal` tag in the repository. TEI's own answer for Apple
Silicon is to build it from source with `--features metal`, which is a Rust
toolchain on your laptop rather than something to pull.

**Compose does not use the first two rows at all**, and that is worth being
exact about because the first version of this page was not. No service in
`docker-compose.yml` carries an `image:` key — all six of `api`, `mcp`,
`migrate`, `parser`, `web` and `worker` have a `build:` and are compiled from
the Dockerfiles into locally tagged images (`nacre-api`, `nacre-mcp`, …). A
local build is a build for the machine doing it, so **`docker compose up` has
always produced arm64 images on an M-series Mac**, before 0.5.2 and after it.

What was amd64-only through 0.5.1 is the *published* image, and it is emulated
wherever something actually pulls it: the Helm chart, which names those tags in
its defaults; a `docker pull ghcr.io/nacre-work/nacre`; an arm64 node in a
cluster or a CI runner. That is the defect 0.5.2 fixes, and the failure it
produced was a slow container rather than an error, which is the kind nobody
reports. It is not a defect the Compose path here ever had.

## Two arrangements, and which one you want

Both avoid emulation. The difference is where your documents' text goes, and
that is the only question worth asking first.

| | Embedder | Text leaves the installation | Setup |
|---|---|---|---|
| **A — host-native** | Ollama or LM Studio on macOS, on Metal | no | `minimal` + three lines in `.env` |
| **B — hosted vendor** | OpenAI, Voyage, Cloudflare, Google | **yes** | `hosted` + a route and a key |

**A is the default recommendation** and the rest of this page is mostly about
it. Take B if you would rather not run a model at all and the documents are
ones you are willing to send to a third party.

**What you cannot do is point the endpoint straight at a vendor.** That is the
obvious thing to try and it fails: the request carries no `Authorization`
header and `embedding_providers` has no column to hold a key — deliberately,
because a vendor credential there would reach every database dump. The adapter
in B is what holds the key. The refusal says so now, but it is cheaper to read
it here.

### B, in full

Set this **before the first `init`** — it writes the endpoint into
`embedding_providers` and a re-run will not change it.

```ini
# .env
NACRE_DEFAULT_EMBEDDING_ENDPOINT=http://embedding-adapter:8091
NACRE_DEFAULT_EMBEDDING_MODEL=text-embedding-3-small
NACRE_DEFAULT_EMBEDDING_DIM=1536

NACRE_EMBED_ROUTES=text-embedding-3-small=openai-compatible
NACRE_EMBED_OPENAI_COMPATIBLE_ENDPOINT=https://api.openai.com/v1
NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY=sk-…
```

```bash
docker compose --profile hosted up -d
```

Three things to get right. `NACRE_DEFAULT_EMBEDDING_MODEL` must be a model
`NACRE_EMBED_ROUTES` names — routing is by model name, there is no default
vendor and no fallback, and an unrouted model is refused by name.
`NACRE_DEFAULT_EMBEDDING_DIM` must match the vendor's model rather than
bge-m3's 1024: `text-embedding-3-small` is 1536 and `-3-large` is 3072. And the
vendor list is four — `openai-compatible` (named for the protocol, so Together,
DeepInfra and vLLM go here too, with a different `_ENDPOINT`), `cloudflare`,
`google`, `voyage`. [config.md](./config.md) has the whole surface, including
why there is no `anthropic`.

## Arrangement A: `minimal`, with the embedder on the host

Everything in `minimal` is arm64. The embedder is not in `minimal` at all — that
is what keeps the profile runnable on a laptop with no GPU — so on a Mac you
supply one, and the one you supply runs on macOS against Metal. That is both the
way around the missing image and, by a wide margin, the faster arrangement:
Metal on the machine's own GPU against an emulated x86 CPU build is not a close
comparison.

### 1. An embedding server on the host

[Ollama](https://ollama.com) is the shortest path — a native arm64 app that
serves the OpenAI-compatible route this needs.

```bash
brew install ollama          # or the .dmg from ollama.com
ollama serve                 # listens on 127.0.0.1:11434
ollama pull bge-m3           # 1024 dimensions, the default this repository ships
```

LM Studio works the same way with its local server switched on, at port 1234.
Anything else that serves `POST …/embeddings` with `{model, input}` and answers
`{data: [{embedding: […]}]}` is fine — that is the whole contract.

**Ollama listens on the loopback address by default**, which a container cannot
reach even with `host.docker.internal` resolving. Give it the host's other
interfaces:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

On macOS that exposes the port to your local network, so do it on a laptop you
control and not on a café's wifi.

### 2. Point Nacre at it

```bash
git clone https://github.com/nacre-work/nacre && cd nacre
cp .env.example .env
```

In `.env`:

```ini
NACRE_DEFAULT_EMBEDDING_ENDPOINT=http://host.docker.internal:11434/v1
NACRE_DEFAULT_EMBEDDING_MODEL=bge-m3
NACRE_DEFAULT_EMBEDDING_DIM=1024
```

**The `/v1` matters, and before 0.5.2 it was discarded.** Every call built its
route with `new URL('/embeddings', endpoint)`, which is origin-relative — so
`http://host.docker.internal:11434/v1` became
`http://host.docker.internal:11434/embeddings` and Ollama answered `404`. It
held for as long as it did because the `full` profile's TEI serves the route at
the root and has no path to lose. Fixed: the route resolves under whatever path
you configure, so a base URL with `/v1` keeps it and a base URL without one is
unchanged.

`NACRE_DEFAULT_EMBEDDING_DIM` has to match the model. `bge-m3` is 1024 and that
is what ships; `nomic-embed-text` is 768 and needs the line changed. A mismatch
is refused rather than stored — the search path's embedder client checks the
width itself and names both numbers, and on the ingest path Qdrant rejects the
point — so it fails loudly. It fails at the first document and the first search,
though, not at startup: nothing at boot knows what the model will return.

### 3. Start it

```bash
docker compose --profile minimal up -d
```

That is the whole command, and it is the same one a Linux server runs. **There
is nothing on this page to select, no `COMPOSE_FILE`, and no second compose
file.**

There was until recently, and the reason it is gone is worth one paragraph
because the arrangement looked reasonable. A `docker-compose.apple-silicon.yml`
overlay carried two keys — `host.docker.internal` made to resolve, and
`platform: linux/amd64` on the two TEI services — and an operator selected it
with `COMPOSE_FILE` in `.env`. But **both keys are harmless where they are not
needed**: Docker on Linux supports `host-gateway`, and naming the platform an
amd64 host already has does nothing. So the overlay bought a second file, a
command that differed by machine, and a trap — naming `COMPOSE_FILE` replaces
Compose's default file resolution, which silently switches off any
[`docker-compose.override.yml`](./config.md#local-overrides) the same person had
written. Both keys are in `docker-compose.yml` now and every platform runs one
command.

The `host.docker.internal` half is what lets `api`, `mcp` and `worker` reach out
of the Compose network to the embedder you started above. Docker Desktop
provides that name on its own and the line changes nothing there; it is for
Colima, Rancher Desktop, OrbStack and podman, which do not all agree, and where
the failure without it is an `EAI_AGAIN` in a log that names no cause. It is on
the shared anchor rather than on a list of services — the overlay named `api`
and `worker`, and `mcp` runs searches too, so MCP search would have failed on
exactly those runtimes while REST search worked.

From here the [quickstart](./quickstart.md) applies unchanged: `init`, a layer,
a grant, a document, a search. Nothing on that page is architecture specific,
and "unchanged" is now literally true.

## Changing the endpoint after `init`

`init` writes the endpoint into `embedding_providers` and a re-run keeps the
existing row — deliberately, so re-running it cannot reconfigure a live
installation behind your back. The consequence is worth knowing before you hit
it: **editing `NACRE_DEFAULT_EMBEDDING_ENDPOINT` in `.env` after the first
`init` changes nothing.** The worker and the search path both read the provider
row, not the environment.

If the first `init` ran against the wrong endpoint, correct the row:

```bash
docker compose exec postgres psql -U nacre -d nacre -c \
  "UPDATE embedding_providers SET endpoint = 'http://host.docker.internal:11434/v1' WHERE org_id IS NULL"
```

Then restart `api` and `worker` — the API keeps one embedder client per provider
id and builds it once. Managing providers through an endpoint rather than
through `psql` is the `admin-global` module's job and is commercial; that this
leaves the open product with SQL as the only route is a gap and is named here as
one rather than left to be discovered.

### The endpoint, and **only** the endpoint

That `UPDATE` is safe for the address and for nothing else. **Do not change
`model` or `dimensions` in a provider row a layer is using**, and the reason is
not caution — it is that the row is not where the model is recorded.

A layer's named vector is derived from the model: `v_{model}_{dimensions}`, so
`bge-m3` at 1024 is the slot `v_bge_m3_1024` and `@cf/baai/bge-m3` at 1024 is a
*different* slot. Qdrant cannot add a named vector to a collection that exists,
so editing the row leaves every layer pointing at a slot that is not there —
which is the "layers naming a vector that did not exist" failure, arriving from
the operator's side. Ingest fails on every document, forever, and the API
answers `queued` while it does.

**Changing the model is a reindex, and the product does it for you.** Create a
provider and move each layer onto it:

```bash
curl -X POST "$NACRE/v1/embedding-providers" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"cloudflare","endpoint":"http://embedding-adapter:8091",
       "model":"@cf/baai/bge-m3","dimensions":1024}'

curl -X POST "$NACRE/v1/layers/$LAYER/reindex" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"provider_id":"…"}'
```

That replaces the collection with one carrying both slots, copies every point
across without recomputing an embedding, moves the pointer, and re-embeds one
layer at a time. Search stays available throughout, the old collection stays as
the rollback window (`NACRE_COLLECTION_RETENTION_DAYS`), and a layer with a
reference query set is gated on recall before it switches. The admin UI has the
same thing on the layer screen.

This section only told you to change the endpoint, and somebody changing the
*vendor* read it as covering that too — the endpoint and the model move together
when the vendor does, because a vendor's model id is its own. It cost a
half-broken installation to find out.

## Why not `--profile full`

`full` adds MinIO, an embedder and a reranker. MinIO is arm64. The other two are
the TEI image, and there is no arm64 of it.

`docker-compose.yml` states `platform: linux/amd64` on both, so the amd64 image
is pulled and run under emulation. Without that key the pull would fail with
`no matching manifest for linux/arm64/v8`, because there is no arm64 to resolve
and Compose asks for the host's.

**That has now been run, and it works** — reported from a Docker Desktop install
with Rosetta, where both TEI services come up and stay up alongside the rest of
the stack. This page previously said it had not been tried and would not pretend
otherwise; it has, so the sentence is replaced rather than left standing.

It is still not the arrangement to choose. In that same run the reranker sat
near a full core with nothing being searched, and Rosetta 2 does not implement
AVX — an x86 build compiled with vector instructions can fault rather than run
slowly, and a Docker runtime using QEMU instead will execute it and be slower
still. So "it works" is a report about one runtime and not a property of the
architecture, and the embedder is on the request path for every ingest and every
search.

Use arrangement A or B from the top of this page — `minimal` with a host-native
embedder, or `hosted` with the adapter. `full` is neither, and the section
above is only here so that "why not just use the profile that brings its own
embedder" has a written answer.

If you want object storage without the rest of `full`, MinIO is arm64 and can be
started on its own:

```bash
docker compose --profile minimal up -d
docker compose --profile full up -d minio minio-init
```

The second line names the two services rather than the profile's whole set, so
the TEI images are never pulled — `--profile full` selects `minio`,
`minio-init`, `embedder` and `reranker`, and only the first two are arm64. Then
set `NACRE_S3_*` as [config.md](./config.md) describes.

That pair is the one-off form, and it has to be typed right every time: a later
plain `docker compose --profile full up -d` starts the emulated pair after all.
The durable form is a [local override](./config.md#local-overrides) holding
`scale: 0` on `embedder` and `reranker`, which leaves `--profile full` meaning
"everything in `full` except the two images this architecture has none of" for
every command from then on.

### Reranking

Off, and it is the default. `NACRE_RERANKER_ENABLED=false` ships that way, and a
search without a reranker answers in fusion order — reranking changes which
permitted results come back, never how many, so nothing about the permission
model depends on it.

Turning it on wants a cross-encoder behind TEI's `/rerank`, which Ollama does
not serve; it has no reranking API. If you have a reranker on the host that
does, `NACRE_RERANKER_ENDPOINT` takes any base URL and the route now resolves
under its path the same way the embedder's does.

## Kubernetes on a Mac

Docker Desktop's Kubernetes, k3d, kind and minikube on an M-series Mac all give
you an arm64 node, and the chart in
[nacre-infra](https://github.com/nacre-work/nacre-infra) needs nothing
architecture-specific once the images carry both — which, from 0.5.2, they do.
There is a `helm/values/apple-silicon.yaml` in that repository sized for a
laptop: replica counts of one, the embedder pointed at the host, and no ingress.

A chart deployed against an image tag of **0.5.1 or earlier will still be
emulated**, because the manifest for those tags has one architecture in it. That
is a property of the published tag and no values file can change it; move
`image.tag` forward.

## If something is emulated and you want to know which

```bash
docker compose ps --format '{{.Name}}' | while read -r c; do
  printf '%-28s %s\n' "$c" "$(docker inspect --format '{{.Image}}' "$c" | xargs docker image inspect --format '{{.Os}}/{{.Architecture}}')"
done
```

Anything reporting `linux/amd64` on an M-series Mac is running under emulation.
With the arrangement above, nothing should.
