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

import hashlib
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
    """
    The vendor refused, or did not answer.

    Carries the status where there was one, because 401 and 403 mean something
    the other statuses do not: the credential this adapter holds was rejected,
    and the operator's next step is a variable rather than a status page.
    """

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        # Log-only, never sent. The reply is read through something that bounds
        # it and a log line is not, so this is where anything the message has no
        # room for goes. Set by `_credential_context`.
        self.fields: dict[str, object] = {}


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
        raise UpstreamError(f"{vendor} answered {error.code}", status=error.code) from error
    except urllib.error.URLError as error:
        raise UpstreamError(f"{vendor} could not be reached: {error.reason}") from error
    except (TimeoutError, OSError) as error:
        raise UpstreamError(f"{vendor} did not answer within {UPSTREAM_TIMEOUT_SECONDS}s") from error
    except json.JSONDecodeError as error:
        raise UpstreamError(f"{vendor} answered something that is not JSON") from error


def _openai_shaped(url: str, texts: list[str], model: str, api_key: str, vendor: str) -> list[list[float]]:
    """
    `{model, input}` in, `{data: [{index, embedding}]}` out.

    Shared by two vendors rather than copied, because the `index` sort below is
    the part that must not drift: it is the difference between a batch that came
    back in order and one that silently did not.
    """
    body = _post_json(url, {"model": model, "input": texts}, {"authorization": f"Bearer {api_key}"}, vendor)
    rows = body.get("data")
    if not isinstance(rows, list):
        raise UpstreamError(f"{vendor} answered without a `data` array")

    # Sorted by `index` rather than trusted in arrival order. The field exists
    # in the contract precisely because the order is not promised, and a
    # reordered batch attaches the wrong vector to the wrong chunk — which
    # nothing downstream can detect, because every vector is the right shape.
    try:
        rows = sorted(rows, key=lambda r: int(r["index"])) if all("index" in r for r in rows) else rows
    except (TypeError, ValueError) as error:
        raise UpstreamError(f"{vendor} answered with an unreadable `index`") from error

    return [r.get("embedding") for r in rows]


def _openai(texts: list[str], model: str, cfg: dict) -> list[list[float]]:
    """
    Anything speaking OpenAI's embeddings contract.

    Named for the protocol rather than for the company, because that is what it
    is: Together, DeepInfra, vLLM and a self-hosted TEI all answer here, which is
    why the endpoint is required configuration rather than a default pointing at
    one vendor.
    """
    return _openai_shaped(
        cfg["endpoint"].rstrip("/") + "/embeddings",
        texts,
        model,
        cfg["api_key"],
        "openai-compatible",
    )


def _voyage(texts: list[str], model: str, cfg: dict) -> list[list[float]]:
    """
    Voyage AI, whose embeddings endpoint is OpenAI-shaped.

    It has its own entry rather than being a note under `openai-compatible`
    because of **who asks for it**: Anthropic publishes no embeddings API at all
    and points at Voyage instead, so "embeddings from Anthropic" resolves here.
    A vendor nobody can find is a vendor nobody uses, and the endpoint is not
    something an operator should have to know to type.

    Naming the vendor is choosing the endpoint, exactly as it is for `cloudflare`
    and `google`. That is not the "no silent defaults for URLs" rule being bent:
    that rule is about `NACRE_DEFAULT_EMBEDDING_ENDPOINT`, where a default would
    guess *which company* sees the documents. Here the operator wrote the name.
    """
    return _openai_shaped("https://api.voyageai.com/v1/embeddings", texts, model, cfg["api_key"], "voyage")


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
    "voyage": {
        "call": _voyage,
        "key": ("NACRE_EMBED_VOYAGE_API_KEY", "NACRE_EMBED_VOYAGE_API_KEY_FILE"),
        "settings": {},
        "batch": 128,
    },
}


# ─────────────────────────── reranking ───────────────────────────
#
# A cross-encoder scores (query, text) pairs. Three vendors answer in one shape
# and Cloudflare in another; all four are reduced to **one score per input, in
# input order**, which is what `packages/api/src/rerank.ts` reads.
#
# This service answers TEI's `/rerank` rather than a shape of its own, so the
# core needs no code at all: `NACRE_RERANKER_ENDPOINT` points here instead of at
# a TEI container and nothing else changes. A second protocol in the API would
# have been a second thing to keep in step with the first, for no gain — the
# whole argument that put the vendor differences in a sidecar.
#
# Scores are the vendors' normalized relevance rather than TEI's raw logits, and
# that is safe for one reason worth stating: the caller uses them to **order**
# an already-permitted candidate set and never as a threshold. `raw_scores` is
# accepted and ignored, because there is no raw score to give.


def _rerank_relevance(url: str, body: dict, headers: dict, vendor: str, field: str) -> list[tuple[int, float]]:
    """
    The `[{index, relevance_score}]` family: Cohere, Jina and Voyage.

    They differ in the name of the array and in nothing else this reads.
    """
    answer = _post_json(url, body, headers, vendor)
    rows = answer.get(field)
    if not isinstance(rows, list):
        raise UpstreamError(f"{vendor} answered without a `{field}` array")

    scored: list[tuple[int, float]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise UpstreamError(f"{vendor} answered with a result that is not an object")
        index, score = row.get("index"), row.get("relevance_score")
        if not isinstance(index, int) or isinstance(index, bool) or not isinstance(score, (int, float)):
            raise UpstreamError(f"{vendor} answered with a result carrying no index and relevance_score")
        scored.append((index, float(score)))
    return scored


def _rerank_cohere(query: str, texts: list[str], model: str, cfg: dict) -> list[tuple[int, float]]:
    return _rerank_relevance(
        "https://api.cohere.com/v2/rerank",
        {"model": model, "query": query, "documents": texts},
        {"authorization": f"Bearer {cfg['api_key']}"},
        "cohere",
        "results",
    )


def _rerank_jina(query: str, texts: list[str], model: str, cfg: dict) -> list[tuple[int, float]]:
    return _rerank_relevance(
        "https://api.jina.ai/v1/rerank",
        {"model": model, "query": query, "documents": texts},
        {"authorization": f"Bearer {cfg['api_key']}"},
        "jina",
        "results",
    )


def _rerank_voyage(query: str, texts: list[str], model: str, cfg: dict) -> list[tuple[int, float]]:
    return _rerank_relevance(
        "https://api.voyageai.com/v1/rerank",
        {"model": model, "query": query, "documents": texts},
        {"authorization": f"Bearer {cfg['api_key']}"},
        "voyage",
        "data",
    )


def _rerank_cloudflare(query: str, texts: list[str], model: str, cfg: dict) -> list[tuple[int, float]]:
    """
    Cloudflare Workers AI, which answers `{result: {response: [{id, score}]}}`.

    `id` is the position in `contexts`, so it plays the part `index` plays for
    the other three.
    """
    answer = _post_json(
        f"https://api.cloudflare.com/client/v4/accounts/{quote(cfg['account'], safe='')}"
        f"/ai/run/{quote(model, safe='/@.')}",
        {"query": query, "contexts": [{"text": text} for text in texts]},
        {"authorization": f"Bearer {cfg['api_key']}"},
        "cloudflare",
    )
    # 200 with `success: false` for a model that does not exist, as on the
    # embeddings path — the status alone is not the verdict.
    if answer.get("success") is False:
        raise UpstreamError(f"cloudflare refused the rerank request for model {model}")
    result = answer.get("result")
    rows = result.get("response") if isinstance(result, dict) else None
    if not isinstance(rows, list):
        raise UpstreamError("cloudflare answered without a `result.response` array")

    scored: list[tuple[int, float]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise UpstreamError("cloudflare answered with a result that is not an object")
        index, score = row.get("id"), row.get("score")
        if not isinstance(index, int) or isinstance(index, bool) or not isinstance(score, (int, float)):
            raise UpstreamError("cloudflare answered with a result carrying no id and score")
        scored.append((index, float(score)))
    return scored


RERANKERS = {
    "cloudflare": {
        "call": _rerank_cloudflare,
        "key": ("NACRE_RERANK_CLOUDFLARE_API_KEY", "NACRE_RERANK_CLOUDFLARE_API_KEY_FILE"),
        "settings": {"account": "NACRE_RERANK_CLOUDFLARE_ACCOUNT"},
    },
    "cohere": {
        "call": _rerank_cohere,
        "key": ("NACRE_RERANK_COHERE_API_KEY", "NACRE_RERANK_COHERE_API_KEY_FILE"),
        "settings": {},
    },
    "jina": {
        "call": _rerank_jina,
        "key": ("NACRE_RERANK_JINA_API_KEY", "NACRE_RERANK_JINA_API_KEY_FILE"),
        "settings": {},
    },
    "voyage": {
        "call": _rerank_voyage,
        "key": ("NACRE_RERANK_VOYAGE_API_KEY", "NACRE_RERANK_VOYAGE_API_KEY_FILE"),
        "settings": {},
    },
}

# Refused rather than split, which is the opposite of the embeddings path and
# deliberately so.
#
# Splitting a batch of embeddings is safe because each vector is computed from
# one text and nothing else. A reranker is not promised to be: a vendor that
# normalizes scores across the documents it was given in one call would produce
# two sets that cannot be compared, and the result is a **silently** wrong
# ordering — the failure mode this whole file is written against. A refusal
# names the limit; a split would not.
#
# Well above `NACRE_RERANK_CANDIDATES`, which is 50 by default, and below every
# one of the four vendors' own document limits.
MAX_RERANK_TEXTS = 512


def _credential_context(error: UpstreamError, cfg: dict) -> UpstreamError:
    """
    Attach what the log should carry and the message must not.

    The message is read through the core, which bounds it at 200 characters; a
    log line here has no bound and is JSON. So the guidance and both variable
    names in full go on it as fields, rather than as prose competing for those
    200 characters with the two facts that have to arrive.
    """
    if error.status in (401, 403):
        error.fields = {
            "credential": cfg["key_fingerprint"],
            "variables": list(cfg["key_vars"]),
            "hint": (
                "the vendor rejected this credential rather than the request. Compare the "
                "fingerprint with sha256sum of the token you deployed, cut to twelve characters: "
                "equal means this container holds what you think and the credential itself is "
                "the problem, different means the rotation did not reach it."
            ),
        }
    return error


def _rejected_credential(error: UpstreamError, cfg: dict) -> UpstreamError:
    """
    Turn a vendor's 401 or 403 into the variable an operator has to look at.

    `cloudflare answered 401` is already the whole of what this service knows,
    and it is still one step short: a 401 from a *vendor* is not the 401 the
    core's own helper explains — that one means "this endpoint wants a
    credential and Nacre sends none", and this one means the opposite, that the
    credential this adapter holds was rejected. The two read alike and point
    opposite ways.

    Which variable holds it is not derivable from the vendor's name. Cloudflare
    is in both tables, so a rerank failure naming NACRE_EMBED_CLOUDFLARE_API_KEY
    sends the reader to a variable that is not the one in play. `key_vars` is
    carried from the table entry that resolved the credential for that reason.

    Only 401 and 403. A 429 is a quota and a 500 is the vendor's own outage, and
    a paragraph about credentials on either would be noise on the failures an
    operator can do nothing about.
    """
    if error.status not in (401, 403):
        return error
    inline, from_file = cfg["key_vars"]
    # Facts only, and in the order a reader needs them. This is read through
    # the core's log, and the core bounds an endpoint's reason at 200
    # characters because a *vendor's* message can quote the input it rejected —
    # a bound that applies to ours too, since nothing on that side can tell the
    # two apart. `NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY_FILE` is 42 characters
    # on its own, so prose here is what gets cut off the end, and the end is
    # where the last thing added always goes. What to *do* with the fingerprint
    # lives in the log line beside this one, which has no bound, and in
    # docs/config.md. `[_FILE]` rather than both spellings for the same reason.
    return UpstreamError(
        f"{error}, rejecting this adapter's credential {cfg['key_fingerprint']} from {inline}[_FILE]",
        status=error.status,
    )


def rerank(cfg: dict | None, query: str, texts: list[str]) -> list[float]:
    """
    One score per text, in input order.

    The completeness check is the point. `HttpReranker` refuses an answer that
    scores fewer inputs than it sent, because a missing score sinks that chunk
    to the bottom of the results — a quality loss with no error anywhere. This
    makes the same check one hop earlier, where the vendor can be named.
    """
    if cfg is None:
        raise RouteError(
            "this adapter has no reranker configured. Set NACRE_RERANK_VENDOR and "
            f"NACRE_RERANK_MODEL; vendors: {', '.join(sorted(RERANKERS))}. See docs/config.md.",
        )

    vendor = cfg["vendor"]
    try:
        scored = RERANKERS[vendor]["call"](query, texts, cfg["model"], cfg)
    except UpstreamError as error:
        raise _credential_context(_rejected_credential(error, cfg), cfg) from error

    scores: list[float | None] = [None] * len(texts)
    for index, score in scored:
        if index < 0 or index >= len(texts):
            raise UpstreamError(f"{vendor} scored index {index} for {len(texts)} inputs")
        if scores[index] is not None:
            raise UpstreamError(f"{vendor} scored index {index} twice")
        scores[index] = score

    missing = sum(1 for s in scores if s is None)
    if missing:
        raise UpstreamError(
            f"{vendor} scored {len(texts) - missing} of {len(texts)} inputs. "
            "Every candidate must be scored: an unscored one sinks to the bottom of the results "
            "with no error anywhere.",
        )

    return [s for s in scores if s is not None]


# ─────────────────────────── configuration ───────────────────────────


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _secret(vendor: str, inline_var: str, file_var: str, named_by: str = "a route") -> str:
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
        return _usable(secret, file_var)
    if inline:
        return _usable(inline, inline_var)

    # `named_by` rather than always "a route", because reranking has none: it is
    # selected by NACRE_RERANK_VENDOR, and a refusal saying "a route names the
    # cloudflare vendor" sends the reader looking through NACRE_EMBED_ROUTES for
    # something that is not there. Found by starting the container with the
    # credentials still empty, which is the state every first run is in.
    raise ConfigError(
        f"{named_by} names the {vendor} vendor and neither {inline_var} nor {file_var} is set. "
        "See docs/config.md.",
    )


def _usable(secret: str, variable: str) -> str:
    """
    Refuse a credential that cannot work as a bearer token, at startup, by name.

    Both of these produce a `401` from a credential that is perfectly valid
    where it came from, which is the most expensive kind of failure this
    service can have: nothing on the vendor's side is wrong, nothing in the
    dashboard looks off, and the operator checks the token five times.

    **Surrounding quotes.** `_env` strips whitespace and not quotes, so
    `NACRE_..._API_KEY="cf-token"` written where quoting is not removed —
    a Kubernetes manifest value, a `docker run -e VAR='"x"'`, a wrapper that
    re-exports — sends `Authorization: Bearer "cf-token"`. No vendor's token
    contains a quote character, so this is a quoting accident every time and
    guessing at the intent by stripping them would hide it.

    **Anything a header cannot carry.** A control character or a byte outside
    latin-1 raises inside the HTTP client, several layers from the variable that
    holds it — a newline in the middle of a pasted secret is the usual way.
    Refusing here names the variable instead.
    """
    if len(secret) > 1 and secret[0] == secret[-1] and secret[0] in "\"'":
        raise ConfigError(
            f"{variable} is wrapped in {secret[0]} quotes. The quotes are part of the value here "
            "and would be sent as part of the credential, which is a 401 from a token that is "
            "otherwise correct — no vendor's token contains a quote character. Remove them "
            "rather than relying on this service to guess.",
        )
    try:
        secret.encode("latin-1")
    except UnicodeEncodeError as error:
        raise ConfigError(
            f"{variable} holds a character an HTTP header cannot carry, at position "
            f"{error.start}. A credential pasted with a line break or a non-ASCII character "
            "fails inside the HTTP client rather than here, several layers from this variable.",
        ) from error
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in secret):
        raise ConfigError(
            f"{variable} holds a control character. A credential pasted with a line break in the "
            "middle is the usual way, and it fails inside the HTTP client rather than here.",
        )
    return secret


def _fingerprint(secret: str) -> str:
    """
    Which credential this process is holding, without printing it.

    The core already answers this question for the JWT signing key and logs
    `"jwt_key":"sha256:dfdff7afb059"` at startup. This service, which holds a
    third party's billing credential, answered it for nothing — and that is the
    one question an operator cannot resolve any other way. A rotated token and a
    redeployed container fail *identically* whether the new token is wrong or
    the old one is still in the environment: same 401, same message, same
    everything. `docker compose` config precedence and a Deployment that did not
    roll both produce the second, and neither is visible from outside.

    Compare it with `sha256sum` of the token you meant to deploy, cut to twelve
    characters. Equal means the container has what you think and the credential
    itself is the problem; different means the deploy did not take.

    Twelve hex characters of SHA-256, and it is not a way in. Deriving the token
    from it is a preimage search; *confirming* one needs the token already, and
    anyone holding that has whatever it opens. Same argument the core's key line
    rests on, which is why the format is the same.
    """
    return "sha256:" + hashlib.sha256(secret.encode("utf-8")).hexdigest()[:12]


def _vendor_credentials(vendor: str, spec: dict, named_by: str = "a route") -> dict:
    """The credential and the settings one vendor entry requires, or a refusal."""
    api_key = _secret(vendor, *spec["key"], named_by=named_by)
    cfg = {
        "vendor": vendor,
        "api_key": api_key,
        # Kept so a 401 can name them. The pair is not derivable from the vendor
        # name: `cloudflare` appears in both tables with different variables —
        # NACRE_EMBED_CLOUDFLARE_API_KEY and NACRE_RERANK_CLOUDFLARE_API_KEY —
        # which is the same confusion `named_by` above exists for.
        "key_vars": tuple(spec["key"]),
        # From the value already read, never by reading again: a second read of
        # a file is a second answer, and a fingerprint of something other than
        # the credential in use is worse than none.
        "key_fingerprint": _fingerprint(api_key),
    }
    for setting, variable in spec["settings"].items():
        value = _env(variable)
        if not value:
            raise ConfigError(f"{named_by} names the {vendor} vendor and {variable} is not set.")
        cfg[setting] = value
    return cfg


def load_reranker() -> dict | None:
    """
    Read `NACRE_RERANK_VENDOR` and `NACRE_RERANK_MODEL`, or answer None.

    **One reranker per adapter, not a routing table**, and that asymmetry with
    embeddings is forced rather than chosen: TEI's `/rerank` request carries a
    query and texts and **no model name**, because a TEI container is one model.
    There is therefore no routing key in the request to dispatch on. Inventing
    one would mean changing the core's reranker client, which is the thing this
    service exists to avoid.

    Half-configured is refused rather than half-honoured. A vendor with no model
    would have to guess which cross-encoder, and a model with no vendor has
    nowhere to go.
    """
    vendor = _env("NACRE_RERANK_VENDOR")
    model = _env("NACRE_RERANK_MODEL")

    if not vendor and not model:
        return None
    if not vendor or not model:
        missing, given = ("NACRE_RERANK_VENDOR", "NACRE_RERANK_MODEL") if not vendor else (
            "NACRE_RERANK_MODEL",
            "NACRE_RERANK_VENDOR",
        )
        raise ConfigError(
            f"{given} is set and {missing} is not. Reranking needs both — a vendor with no model "
            "would be a guess about which cross-encoder, and a model with no vendor has nowhere "
            "to go.",
        )
    if vendor not in RERANKERS:
        raise ConfigError(
            f"NACRE_RERANK_VENDOR names `{vendor}`, which does not exist. "
            f"Rerank vendors: {', '.join(sorted(RERANKERS))}. "
            "OpenAI, Anthropic and Google publish no reranking API, so none of them can be one.",
        )

    cfg = _vendor_credentials(vendor, RERANKERS[vendor], named_by="NACRE_RERANK_VENDOR")
    cfg["model"] = model
    return cfg


def load_routes(required: bool = True) -> dict[str, dict]:
    """
    Read `NACRE_EMBED_ROUTES` and everything the vendors it names require.

    Validated here in full and never per request, which is the rule the core
    states for its own configuration: a deployment that is wrong should fail
    where somebody is watching, not on the first document somebody indexes.

    `required=False` is how `serve` asks for a rerank-only adapter: the two jobs
    are independent, and a deployment that reranks through a vendor and embeds
    locally should not have to invent an embedding route to start.
    """
    raw = _env("NACRE_EMBED_ROUTES")
    if not raw:
        if not required:
            return {}
        raise ConfigError(
            "NACRE_EMBED_ROUTES is not set, and routing is the whole of this service's job. "
            "It is a comma-separated list of `model=vendor`, for example "
            "`text-embedding-3-small=openai-compatible`. There is deliberately no default: "
            "which vendor sees your documents is not a decision this container makes. "
            f"Vendors: {', '.join(sorted(VENDORS))}. "
            "A rerank-only adapter is the other way to start: set NACRE_RERANK_VENDOR and "
            "NACRE_RERANK_MODEL instead. See docs/config.md.",
        )

    routes: dict[str, dict] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "=" not in entry:
            raise ConfigError(f"NACRE_EMBED_ROUTES entry `{entry}` is not `model=vendor`")
        model, _, rest = entry.partition("=")
        # `model=vendor` or `model=vendor:upstream-model`.
        #
        # The second form exists because the routing key and the vendor's own
        # model id are not always the same string, and a deployment cannot
        # always change the first. A layer's named vector is derived from the
        # model — `v_{model}_{dimensions}` — so an installation indexed against
        # `bge-m3` that wants Cloudflare's copy of the same weights has two bad
        # options without this: rename the model and reindex every layer to move
        # the vectors into a differently-named slot, or stay where it is. The
        # weights are identical; only the vendor's spelling differs.
        #
        # Written as a suffix on the vendor rather than a third field, so an
        # existing `model=vendor` stays exactly what it was.
        vendor, sep, upstream = rest.strip().partition(":")
        model, vendor, upstream = model.strip(), vendor.strip(), upstream.strip()
        if sep and not upstream:
            raise ConfigError(
                f"NACRE_EMBED_ROUTES entry `{entry}` ends in a colon with no upstream model. "
                "Write `model=vendor` or `model=vendor:upstream-model`.",
            )
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

        cfg = _vendor_credentials(vendor, VENDORS[vendor])
        # The name to send upstream, which is the routing key unless one was
        # given. Stored rather than resolved per request, so the substitution is
        # visible in `/health` and decided once, at startup, with everything
        # else this file validates.
        cfg["upstream_model"] = upstream or model
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
        # The empty case is its own sentence, found by starting a rerank-only
        # adapter and asking it to embed: "This installation routes: ." is a
        # message that answers nothing at the moment somebody needs it most.
        routed = (
            f"This installation routes: {', '.join(sorted(routes))}."
            if routes
            else "This adapter has no embedding routes at all — it is configured for reranking only."
        )
        raise RouteError(
            f"no route for the model `{model}`. {routed} Add it to NACRE_EMBED_ROUTES — there is "
            "no default vendor, because which one sees your documents is not a guess this "
            "service makes.",
        )

    spec = VENDORS[cfg["vendor"]]
    size = spec["batch"] or len(texts) or 1

    # What the vendor is asked for, which is the caller's model unless the route
    # named a different one. The caller's string stays the routing key and stays
    # what comes back in the response, so nothing downstream learns that a
    # substitution happened.
    upstream = cfg.get("upstream_model") or model

    vectors: list[list[float]] = []
    for start in range(0, len(texts), size):
        chunk = texts[start : start + size]
        try:
            got = spec["call"](chunk, upstream, cfg)
        except UpstreamError as error:
            raise _credential_context(_rejected_credential(error, cfg), cfg) from error
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
    reranker: dict | None = None

    # `list` as well as `dict`, because TEI's /rerank answers a bare array.
    def _reply(self, status: int, body: dict | list) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _log(self, level: str, message: str, **fields: object) -> None:
        print(json.dumps({"level": level, "msg": message, **fields}), flush=True)

    def _refuse(self, status: int, message: str, **fields: object) -> None:
        # OpenAI-shaped, because the whole contract is: a caller that can read
        # this service's success can read its failure without a second branch.
        #
        # And logged, which it was not. This container's whole log was the line
        # it printed at startup: `log_message` is silenced deliberately, and no
        # refusal wrote anything — so a deployment whose vendor started
        # answering 429 had the reason nowhere. The caller's log said `answered
        # 502`, naming this service, which is the one process in the chain that
        # did not decide anything.
        #
        # Every message reaching here is safe to log for the same reason it is
        # safe to send: `_post_json` never puts a vendor's body in an error, so
        # each is a literal or one of this file's own exceptions. That is the
        # rule rather than a judgement per call site — what may go on the wire
        # may go in the log, and nothing else does either.
        self._log("error" if status >= 500 else "warn", message, status=status, **fields)
        self._reply(status, {"error": {"message": message}})

    def _body(self) -> dict | None:
        """The request body, or None having already refused."""
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._refuse(400, "body is not JSON")
            return None
        if not isinstance(body, dict):
            self._refuse(400, "body is not an object")
            return None
        return body

    def _rerank(self) -> None:
        """
        TEI's `/rerank`: `{query, texts}` in, `[{index, score}]` out.

        The response is a bare array and not an object, because that is what TEI
        answers and what `packages/api/src/rerank.ts` parses — this endpoint is
        a drop-in for a TEI container or it is nothing.
        """
        body = self._body()
        if body is None:
            return

        query = body.get("query")
        texts = body.get("texts")
        if not isinstance(query, str) or not query:
            self._refuse(400, "`query` is required")
            return
        if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
            self._refuse(400, "`texts` must be an array of strings")
            return
        if not texts:
            # TEI answers an empty list for an empty input and the caller never
            # sends one; matching it costs a line and avoids a vendor call.
            self._reply(200, [])
            return
        if len(texts) > MAX_RERANK_TEXTS:
            self._refuse(413, f"`texts` carries {len(texts)} items; the limit is {MAX_RERANK_TEXTS}")
            return

        try:
            scores = rerank(self.reranker, query, texts)
        except RouteError as error:
            self._refuse(404, str(error))
            return
        except UpstreamError as error:
            self._refuse(502, str(error), **error.fields)
            return
        except Exception as error:  # noqa: BLE001
            # The type and never the text, on the same argument the body makes:
            # this process holds every document's text in memory and a traceback
            # is the last place it should surface. A class name is not text, and
            # it is the difference between a bug here and a container out of
            # memory.
            self._refuse(
                500,
                "the rerank request could not be completed",
                exception=type(error).__name__,
            )
            return

        self._reply(200, [{"index": i, "score": s} for i, s in enumerate(scores)])

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            # The routed models are worth answering with: an operator whose
            # `NACRE_EMBED_ROUTES` did not parse the way they meant finds out
            # here rather than from a document that will not index. They are
            # model names, which are not secret; no credential is reported.
            self._reply(
                200,
                {
                    "status": "ok",
                    "models": sorted(self.routes),
                    # Where a route sends something other than its own name.
                    # An operator whose substitution did not parse the way they
                    # meant finds out here rather than from a 400 at the vendor.
                    "upstream_models": {
                        m: c["upstream_model"]
                        for m, c in sorted(self.routes.items())
                        if c.get("upstream_model") not in (None, m)
                    },
                    # The vendor and model, never the credential. An operator
                    # whose reranker is not the one they meant finds out here
                    # rather than from search results that quietly did not move.
                    "rerank": (
                        {
                            "vendor": self.reranker["vendor"],
                            "model": self.reranker["model"],
                            "credential": self.reranker["key_fingerprint"],
                        }
                        if self.reranker
                        else None
                    ),
                    # Which credential is loaded, per vendor, never the
                    # credential. An operator who rotated a token and
                    # redeployed has no other way to tell whether the container
                    # took it — the failure is identical either way.
                    "credentials": {
                        cfg["vendor"]: cfg["key_fingerprint"] for cfg in self.routes.values()
                    },
                },
            )
        else:
            self._refuse(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        # Both spellings of each path, because `endpointUrl` appends to whatever
        # base an operator configured and both are ones they will write.
        path = self.path.rstrip("/")
        if path in ("/rerank", "/v1/rerank"):
            self._rerank()
            return
        if path not in ("/embeddings", "/v1/embeddings"):
            self._refuse(404, "not found")
            return

        body = self._body()
        if body is None:
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
            self._refuse(502, str(error), **error.fields)
            return
        except Exception as error:  # noqa: BLE001
            # Never the exception text. This process holds every document's text
            # in memory and a traceback is the last place it should surface. The
            # type is not text, and it separates a bug here from a container out
            # of memory.
            self._refuse(
                500,
                "the embedding request could not be completed",
                exception=type(error).__name__,
            )
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
        # The reranker first, because whether it is configured decides whether
        # an empty NACRE_EMBED_ROUTES is a refusal or a rerank-only adapter.
        reranker = load_reranker()
        routes = load_routes(required=reranker is None)
    except ConfigError as error:
        # Before there is a logger and before there is a port: a deployment
        # that cannot route has nothing to serve, and the operator is watching
        # the container start.
        print(json.dumps({"level": "error", "msg": str(error)}), flush=True)
        raise SystemExit(1) from error

    Handler.routes = routes
    Handler.reranker = reranker
    port = int(os.environ.get("PORT", "8091"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)  # noqa: S104
    print(
        json.dumps(
            {
                "level": "info",
                "msg": "embedding adapter listening",
                "port": port,
                "models": sorted(routes),
                "rerank": f"{reranker['vendor']}:{reranker['model']}" if reranker else None,
                # Not the credentials — their fingerprints, so a rotation that
                # did not reach this container is visible in the first line of
                # its log rather than in a 401 an hour later.
                "credentials": {cfg["vendor"]: cfg["key_fingerprint"] for cfg in routes.values()}
                | ({f"rerank:{reranker['vendor']}": reranker["key_fingerprint"]} if reranker else {}),
                "note": "text routed through this service leaves this installation",
            },
        ),
        flush=True,
    )
    server.serve_forever()
