"""
The embedding adapter: one protocol in, several vendors out.

A self-hoster on a laptop has no good embedder. bge-m3 under emulation blows
the worker's budget, and "run a GPU" is not an answer for the person trying the
product. Hosted APIs are, and the question this service answers is *where the
vendor differences live*.

Not in the worker. The indexing path already speaks exactly one protocol —
`{model, input}` in, `{data: [{embedding}]}` out — and TEI, vLLM, Together,
Voyage and DeepInfra all answer it, so the OpenAI-shaped half of the world
already works by pointing `embedding_providers.endpoint` somewhere else. The
obvious extension is a `protocol` column, an `api_key_ref` column and a
three-way branch in the worker, and it is the wrong shape three times over: a
vendor credential's name reaches Postgres and therefore every dump; the least
observable loop in the system grows three response shapes and three error
vocabularies; and the next vendor is a migration.

So it is a sidecar, the way `services/parser` is: a job the core should not
learn. **Routing needs no schema at all** — the request already carries `model`,
and `embedding_providers.model` is a string an operator already fills in, so it
is the routing key. Two organizations can sit on two vendors with nothing new,
and swapping one is a container environment change.

## What this service is not allowed to do

**Nothing has a default.** No vendor, no endpoint, no route. An unrouted model
is refused by name and never falls through to whichever vendor happens to be
configured, because a fallback is a decision made on the operator's behalf about
where their documents go. With no routes at all the process refuses to start:
routing is the whole of its job, and one that cannot route is a container that
can only answer 400.

**It is absent from the `airgapped` profile rather than disabled in it.** That
profile's rule is no outbound connection at all, and a rule enforced by a
runtime check is a check that has to be right; a service that is not there
cannot connect to anything. `lint:compose` asserts the absence.

The trade this exists to make is not hidden anywhere: routing a model to a
hosted vendor means **the text of your documents leaves your installation.**
`docs/config.md` says it in those words. A person who wants that is not confused
about it; a person who does not must never get it by accident.

## Zero dependencies, deliberately

Standard library only. This process sees the text of every document indexed
through it, which is the same argument that keeps `services/parser` at one
dependency and put the S3 signer in the core by hand. There is one operation
here — embed a batch — and LiteLLM in front of the existing endpoint remains the
documented escape hatch for anyone who would rather have the dependency, since
anything OpenAI-shaped needs no code from us at all.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote

# Bounded, and below the worker's own 120 s budget: an upstream that accepts a
# connection and never answers must fail here, where the message can name the
# vendor, rather than as the worker's timeout, where it cannot.
UPSTREAM_TIMEOUT_SECONDS = 90

# What a caller may ask for at once. Not a vendor limit — those are handled by
# splitting below — but a bound on how much text one request can carry.
MAX_INPUTS = 2048


class ConfigError(Exception):
    """The deployment is wrong. Raised at startup, never per request."""


class RouteError(Exception):
    """The caller asked for a model this installation does not route."""


class UpstreamError(Exception):
    """The vendor refused, or did not answer."""


# ─────────────────────────── the vendors ───────────────────────────
#
# Each is (request -> vectors). Adding one is a function and a table entry; it
# is deliberately not a migration and not a column value.


def _post_json(url: str, body: dict, headers: dict[str, str], vendor: str) -> dict:
    """One upstream call. Never puts the request body in an error."""
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(  # noqa: S310 - scheme is fixed by the vendor table
        url,
        data=data,
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:  # noqa: S310
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        # The status and nothing from the body: a vendor's error message can
        # quote the input it rejected, and the input is document text.
        raise UpstreamError(f"{vendor} answered {error.code}") from error
    except urllib.error.URLError as error:
        raise UpstreamError(f"{vendor} could not be reached: {error.reason}") from error
    except (TimeoutError, OSError) as error:
        raise UpstreamError(f"{vendor} did not answer within {UPSTREAM_TIMEOUT_SECONDS}s") from error
    except json.JSONDecodeError as error:
        raise UpstreamError(f"{vendor} answered something that is not JSON") from error


def _openai(texts: list[str], model: str, cfg: dict) -> list[list[float]]:
    """
    Anything speaking OpenAI's embeddings contract.

    Named for the protocol rather than for the company, because that is what it
    is: Together, Voyage, DeepInfra, vLLM and a self-hosted TEI all answer here,
    which is why the endpoint is required configuration rather than a default
    pointing at one vendor.
    """
    body = _post_json(
        cfg["endpoint"].rstrip("/") + "/embeddings",
        {"model": model, "input": texts},
        {"authorization": f"Bearer {cfg['api_key']}"},
        "openai-compatible",
    )
    rows = body.get("data")
    if not isinstance(rows, list):
        raise UpstreamError("openai-compatible answered without a `data` array")

    # Sorted by `index` rather than trusted in arrival order. The field exists
    # in the contract precisely because the order is not promised, and a
    # reordered batch attaches the wrong vector to the wrong chunk — which
    # nothing downstream can detect, because every vector is the right shape.
    try:
        rows = sorted(rows, key=lambda r: int(r["index"])) if all("index" in r for r in rows) else rows
    except (TypeError, ValueError) as error:
        raise UpstreamError("openai-compatible answered with an unreadable `index`") from error

    return [r.get("embedding") for r in rows]


def _cloudflare(texts: list[str], model: str, cfg: dict) -> list[list[float]]:
    """Cloudflare Workers AI. `{text: [...]}` in, `{result: {data: [[...]]}}` out."""
    body = _post_json(
        f"https://api.cloudflare.com/client/v4/accounts/{quote(cfg['account'], safe='')}"
        f"/ai/run/{quote(model, safe='/@.')}",
        {"text": texts},
        {"authorization": f"Bearer {cfg['api_key']}"},
        "cloudflare",
    )
    # Cloudflare answers 200 with `success: false` for a model that does not
    # exist, so the status alone is not the verdict.
    if body.get("success") is False:
        raise UpstreamError(f"cloudflare refused the request for model {model}")
    result = body.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise UpstreamError("cloudflare answered without a `result.data` array")
    return result["data"]


def _google(texts: list[str], model: str, cfg: dict) -> list[list[float]]:
    """
    Google's Generative Language API.

    The model name is qualified with `models/` where the caller did not, since
    that is how the API addresses one and `embedding_providers.model` is a
    string a person typed.
    """
    qualified = model if model.startswith("models/") else f"models/{model}"
    body = _post_json(
        f"https://generativelanguage.googleapis.com/v1beta/{quote(qualified, safe='/')}"
        f":batchEmbedContents?key={quote(cfg['api_key'], safe='')}",
        {
            "requests": [
                {"model": qualified, "content": {"parts": [{"text": text}]}} for text in texts
            ],
        },
        {},
        "google",
    )
    rows = body.get("embeddings")
    if not isinstance(rows, list):
        raise UpstreamError("google answered without an `embeddings` array")
    return [r.get("values") for r in rows]


# Every variable name spelled out rather than composed from the vendor's name.
#
# Composing them read as tidier and cost two things. Somebody reading this file
# to find out what to set had to do the string algebra in their head; and
# `lint:config` — which asserts that every variable a shipped container reads is
# in `docs/config.md` — could see literals and not f-strings, so the adapter's
# whole configuration surface would have been exempt from the one check that
# exists to stop a variable being invisible to whoever deploys this.
VENDORS = {
    "openai-compatible": {
        "call": _openai,
        "key": ("NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY", "NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY_FILE"),
        "settings": {"endpoint": "NACRE_EMBED_OPENAI_COMPATIBLE_ENDPOINT"},
        # None passes the caller's batch straight through: this vendor is the
        # protocol the worker already speaks, so its behaviour must not change.
        "batch": None,
    },
    "cloudflare": {
        "call": _cloudflare,
        "key": ("NACRE_EMBED_CLOUDFLARE_API_KEY", "NACRE_EMBED_CLOUDFLARE_API_KEY_FILE"),
        "settings": {"account": "NACRE_EMBED_CLOUDFLARE_ACCOUNT"},
        "batch": 100,
    },
    "google": {
        "call": _google,
        "key": ("NACRE_EMBED_GOOGLE_API_KEY", "NACRE_EMBED_GOOGLE_API_KEY_FILE"),
        "settings": {},
        "batch": 100,
    },
}


# ─────────────────────────── configuration ───────────────────────────


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _secret(vendor: str, inline_var: str, file_var: str) -> str:
    """
    A vendor credential, from a file where the platform has a secret store.

    Both forms set is refused rather than resolved by precedence, on the same
    argument the core makes about a JWT secret beside a key reference: two
    answers to one question leaves the losing one configured, apparently in use,
    and ignored.
    """
    inline = _env(inline_var)
    path = _env(file_var)

    if inline and path:
        raise ConfigError(
            f"both {inline_var} and {file_var} are set. "
            "Two answers to which credential to use; set one.",
        )
    if path:
        try:
            with open(path, encoding="utf-8") as handle:
                secret = handle.read().strip()
        except OSError as error:
            raise ConfigError(f"{file_var} names {path}, which could not be read: {error}") from error
        if not secret:
            raise ConfigError(f"{file_var} names {path}, which is empty")
        return secret
    if inline:
        return inline

    raise ConfigError(
        f"a route names the {vendor} vendor and neither {inline_var} nor {file_var} is set. "
        "See docs/config.md.",
    )


def load_routes() -> dict[str, dict]:
    """
    Read `NACRE_EMBED_ROUTES` and everything the vendors it names require.

    Validated here in full and never per request, which is the rule the core
    states for its own configuration: a deployment that is wrong should fail
    where somebody is watching, not on the first document somebody indexes.
    """
    raw = _env("NACRE_EMBED_ROUTES")
    if not raw:
        raise ConfigError(
            "NACRE_EMBED_ROUTES is not set, and routing is the whole of this service's job. "
            "It is a comma-separated list of `model=vendor`, for example "
            "`text-embedding-3-small=openai-compatible`. There is deliberately no default: "
            "which vendor sees your documents is not a decision this container makes. "
            f"Vendors: {', '.join(sorted(VENDORS))}. See docs/config.md.",
        )

    routes: dict[str, dict] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "=" not in entry:
            raise ConfigError(f"NACRE_EMBED_ROUTES entry `{entry}` is not `model=vendor`")
        model, _, vendor = entry.partition("=")
        model, vendor = model.strip(), vendor.strip()
        if not model or not vendor:
            raise ConfigError(f"NACRE_EMBED_ROUTES entry `{entry}` is not `model=vendor`")
        if vendor not in VENDORS:
            raise ConfigError(
                f"NACRE_EMBED_ROUTES names the vendor `{vendor}`, which does not exist. "
                f"Vendors: {', '.join(sorted(VENDORS))}.",
            )
        if model in routes:
            raise ConfigError(
                f"NACRE_EMBED_ROUTES routes the model `{model}` twice. One model, one vendor — "
                "the second entry would be silently unreachable.",
            )

        spec = VENDORS[vendor]
        cfg = {"vendor": vendor, "api_key": _secret(vendor, *spec["key"])}
        for setting, variable in spec["settings"].items():
            value = _env(variable)
            if not value:
                raise ConfigError(
                    f"a route names the {vendor} vendor and {variable} is not set.",
                )
            cfg[setting] = value
        routes[model] = cfg

    if not routes:
        raise ConfigError("NACRE_EMBED_ROUTES is set and contains no route")
    return routes


# ─────────────────────────── the request ───────────────────────────


def embed(routes: dict[str, dict], model: str, texts: list[str]) -> list[list[float]]:
    """
    Route one batch, and check what comes back before anyone can store it.

    The count check is the important one and it is not defensive programming: a
    short or reordered batch attaches the wrong vector to the wrong chunk, every
    vector is still the right shape, and nothing downstream can tell. The worker
    makes the same check for the same reason; this one is here because splitting
    a batch across upstream requests is done here and nowhere else.
    """
    cfg = routes.get(model)
    if cfg is None:
        raise RouteError(
            f"no route for the model `{model}`. This installation routes: "
            f"{', '.join(sorted(routes))}. Add it to NACRE_EMBED_ROUTES — there is no default "
            "vendor, because which one sees your documents is not a guess this service makes.",
        )

    spec = VENDORS[cfg["vendor"]]
    size = spec["batch"] or len(texts) or 1

    vectors: list[list[float]] = []
    for start in range(0, len(texts), size):
        chunk = texts[start : start + size]
        got = spec["call"](chunk, model, cfg)
        if not isinstance(got, list) or len(got) != len(chunk):
            raise UpstreamError(
                f"{cfg['vendor']} returned {len(got) if isinstance(got, list) else 'no'} vectors "
                f"for {len(chunk)} inputs",
            )
        vectors.extend(got)

    for i, vector in enumerate(vectors):
        if not isinstance(vector, list) or not vector or not all(isinstance(n, (int, float)) for n in vector):
            raise UpstreamError(f"{cfg['vendor']} returned something that is not a vector at position {i}")

    return vectors


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    routes: dict[str, dict] = {}

    def _reply(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _refuse(self, status: int, message: str) -> None:
        # OpenAI-shaped, because the whole contract is: a caller that can read
        # this service's success can read its failure without a second branch.
        self._reply(status, {"error": {"message": message}})

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            # The routed models are worth answering with: an operator whose
            # `NACRE_EMBED_ROUTES` did not parse the way they meant finds out
            # here rather than from a document that will not index. They are
            # model names, which are not secret; no credential is reported.
            self._reply(200, {"status": "ok", "models": sorted(self.routes)})
        else:
            self._refuse(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        # `/embeddings` and `/v1/embeddings` both, because `endpointUrl` appends
        # to whatever base an operator configured and both spellings are ones
        # they will write.
        if self.path.rstrip("/") not in ("/embeddings", "/v1/embeddings"):
            self._refuse(404, "not found")
            return

        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._refuse(400, "body is not JSON")
            return

        model = body.get("model")
        raw_input = body.get("input")
        if not isinstance(model, str) or not model:
            self._refuse(400, "`model` is required and decides which vendor answers")
            return

        # A single string is the contract's other form and the worker never
        # sends it; accepting it costs one line and refusing it would make this
        # service subtly not the thing it claims to be a drop-in for.
        texts = [raw_input] if isinstance(raw_input, str) else raw_input
        if not isinstance(texts, list) or not texts or not all(isinstance(t, str) for t in texts):
            self._refuse(400, "`input` must be a string or a non-empty array of strings")
            return
        if len(texts) > MAX_INPUTS:
            self._refuse(413, f"`input` carries {len(texts)} items; the limit is {MAX_INPUTS}")
            return

        try:
            vectors = embed(self.routes, model, texts)
        except RouteError as error:
            self._refuse(404, str(error))
            return
        except UpstreamError as error:
            # 502: the caller's request was fine and somebody else's service was
            # not. A worker reading this knows to retry rather than to give up
            # on the document.
            self._refuse(502, str(error))
            return
        except Exception:  # noqa: BLE001
            # Never the exception text. This process holds every document's text
            # in memory and a traceback is the last place it should surface.
            self._refuse(500, "the embedding request could not be completed")
            return

        self._reply(
            200,
            {
                "object": "list",
                "model": model,
                "data": [
                    {"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vectors)
                ],
            },
        )

    def log_message(self, fmt: str, *args: object) -> None:
        # The default logs the request line. Here that is a path and a model
        # name rather than document text — but the body is the text, and a
        # logger that grows one line is how it ends up next to it.
        del fmt, args


def serve() -> None:
    try:
        routes = load_routes()
    except ConfigError as error:
        # Before there is a logger and before there is a port: a deployment
        # that cannot route has nothing to serve, and the operator is watching
        # the container start.
        print(json.dumps({"level": "error", "msg": str(error)}), flush=True)
        raise SystemExit(1) from error

    Handler.routes = routes
    port = int(os.environ.get("PORT", "8091"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)  # noqa: S104
    print(
        json.dumps(
            {
                "msg": "embedding adapter listening",
                "port": port,
                "models": sorted(routes),
                "note": "text routed through this service leaves this installation",
            },
        ),
        flush=True,
    )
    server.serve_forever()
