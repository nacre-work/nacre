"""
Tests for the embedding adapter.

The two properties worth most of this file are the ones a green suite would
otherwise be silent about: **an unrouted model never falls through to whichever
vendor happens to be configured**, and **a batch split across upstream requests
comes back in the order it went out**. The first is the promise the whole
service makes about where documents go; the second is the failure nothing
downstream can detect, because a reordered batch is full of correctly-shaped
vectors attached to the wrong chunks.
"""

from __future__ import annotations

import http.client
import io
import json
import os
import re
import tempfile
import threading
import unittest
import urllib.error
from contextlib import contextmanager, redirect_stdout
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from services.embedding_adapter import app


@contextmanager
def env(**values: str | None):
    """
    Set exactly these NACRE_ variables, clearing every other one.

    The prefix is `NACRE_` and not `NACRE_EMBED_`, which it was: reranking added
    `NACRE_RERANK_*`, and a helper that clears one family and not the other lets
    a developer's own environment decide what a test sees.
    """
    saved = dict(os.environ)
    for key in list(os.environ):
        if key.startswith("NACRE_"):
            del os.environ[key]
    for key, value in values.items():
        if value is not None:
            os.environ[key] = value
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


class _Response(io.BytesIO):
    """What `urlopen` returns, as far as this service reads it."""

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
        return False


def upstream(answers):
    """
    Stub `urlopen`, recording every request.

    `answers` is a list of dicts, one per expected call, so a test that splits a
    batch can give each chunk a different answer and assert on the order the
    results come back in.
    """
    calls = []
    remaining = list(answers)

    def fake(request, timeout=None):  # noqa: ANN001, ARG001
        calls.append(
            {
                "url": request.full_url,
                "body": json.loads(request.data),
                "headers": {k.lower(): v for k, v in request.header_items()},
            },
        )
        if not remaining:
            raise AssertionError("more upstream calls than the test provided answers for")
        answer = remaining.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return _Response(json.dumps(answer).encode())

    return patch.object(app.urllib.request, "urlopen", fake), calls


@contextmanager
def running(routes=None, reranker=None):
    """
    The adapter on a real port, with everything it prints captured.

    Driven over HTTP rather than by calling the handler, because what is being
    tested is what an operator reads in `docker logs` — and that is produced by
    `_refuse`, which nothing reaches except through a request. `http.client` and
    not `urllib`, because the upstream stub replaces `urllib.request.urlopen`
    and a test client going through it would answer its own request.
    """

    class Isolated(app.Handler):
        pass

    Isolated.routes = routes or {}
    Isolated.reranker = reranker

    server = ThreadingHTTPServer(("127.0.0.1", 0), Isolated)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    printed = io.StringIO()
    try:
        # The shutdown is inside the redirect: a line printed while the server
        # is stopping still belongs to the test that caused it.
        with redirect_stdout(printed):
            try:
                yield server.server_address[1], printed
            finally:
                server.shutdown()
    finally:
        server.server_close()


def post(port: int, path: str, body: dict):
    """One request, returning `(status, parsed body)`."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("POST", path, json.dumps(body), {"content-type": "application/json"})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def lines(printed: io.StringIO) -> list[dict]:
    """Every log line, parsed. One JSON object per line is the whole format."""
    return [json.loads(line) for line in printed.getvalue().splitlines() if line.strip()]


class Configuration(unittest.TestCase):
    def test_no_routes_refuses_to_start(self):
        with env(), self.assertRaises(app.ConfigError) as caught:
            app.load_routes()
        # Naming the variable is the point: this is the first thing an operator
        # who started the profile without configuring it will read.
        self.assertIn("NACRE_EMBED_ROUTES", str(caught.exception))
        self.assertIn("no default", str(caught.exception))

    def test_unknown_vendor_names_the_ones_that_exist(self):
        with env(NACRE_EMBED_ROUTES="m=azure"), self.assertRaises(app.ConfigError) as caught:
            app.load_routes()
        self.assertIn("azure", str(caught.exception))
        self.assertIn("cloudflare", str(caught.exception))

    def test_a_model_routed_twice_is_refused(self):
        with env(
            NACRE_EMBED_ROUTES="m=google,m=cloudflare",
            NACRE_EMBED_GOOGLE_API_KEY="k",
            NACRE_EMBED_CLOUDFLARE_API_KEY="k",
            NACRE_EMBED_CLOUDFLARE_ACCOUNT="a",
        ), self.assertRaises(app.ConfigError) as caught:
            app.load_routes()
        self.assertIn("twice", str(caught.exception))

    def test_a_vendor_without_its_credential_is_refused(self):
        with env(NACRE_EMBED_ROUTES="m=google"), self.assertRaises(app.ConfigError) as caught:
            app.load_routes()
        self.assertIn("NACRE_EMBED_GOOGLE_API_KEY", str(caught.exception))

    def test_a_vendor_without_its_setting_is_refused(self):
        with env(
            NACRE_EMBED_ROUTES="m=openai-compatible",
            NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY="k",
        ), self.assertRaises(app.ConfigError) as caught:
            app.load_routes()
        self.assertIn("NACRE_EMBED_OPENAI_COMPATIBLE_ENDPOINT", str(caught.exception))

    def test_a_credential_comes_from_a_file(self):
        with tempfile.NamedTemporaryFile("w", suffix=".key", delete=False) as handle:
            handle.write("  from-the-store\n")
            path = handle.name
        with env(NACRE_EMBED_ROUTES="m=google", NACRE_EMBED_GOOGLE_API_KEY_FILE=path):
            routes = app.load_routes()
        os.unlink(path)
        self.assertEqual(routes["m"]["api_key"], "from-the-store")

    def test_both_forms_of_a_credential_is_refused(self):
        # Two answers to one question. Resolving it by precedence would leave
        # the losing one configured, apparently in use, and ignored — the same
        # argument the core makes about a JWT secret beside a key reference.
        with env(
            NACRE_EMBED_ROUTES="m=google",
            NACRE_EMBED_GOOGLE_API_KEY="inline",
            NACRE_EMBED_GOOGLE_API_KEY_FILE="/nowhere",
        ), self.assertRaises(app.ConfigError) as caught:
            app.load_routes()
        self.assertIn("Two answers", str(caught.exception))

    def test_an_unreadable_credential_file_is_refused_by_name(self):
        with env(
            NACRE_EMBED_ROUTES="m=google",
            NACRE_EMBED_GOOGLE_API_KEY_FILE="/nowhere/at/all",
        ), self.assertRaises(app.ConfigError) as caught:
            app.load_routes()
        self.assertIn("/nowhere/at/all", str(caught.exception))


class Routing(unittest.TestCase):
    def routes(self):
        with env(
            NACRE_EMBED_ROUTES="text-embedding-3-small=openai-compatible",
            NACRE_EMBED_OPENAI_COMPATIBLE_ENDPOINT="https://api.example.com/v1",
            NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY="sk-test",
        ):
            return app.load_routes()

    def test_an_unrouted_model_never_falls_through(self):
        """
        The property the whole service is about.

        With exactly one vendor configured, a model nobody routed must be
        refused — not sent to the one that happens to be there. A fallback
        would be this container deciding, on the operator's behalf, that a
        document may leave the installation.
        """
        patcher, calls = upstream([])
        with patcher, self.assertRaises(app.RouteError) as caught:
            app.embed(self.routes(), "bge-m3", ["hello"])
        self.assertEqual(calls, [], "an unrouted model reached an upstream")
        self.assertIn("bge-m3", str(caught.exception))
        self.assertIn("text-embedding-3-small", str(caught.exception))

    def test_it_sends_what_the_worker_sends_and_returns_what_it_reads(self):
        patcher, calls = upstream([{"data": [{"index": 0, "embedding": [1.0, 2.0]}]}])
        with patcher:
            got = app.embed(self.routes(), "text-embedding-3-small", ["hello"])
        self.assertEqual(got, [[1.0, 2.0]])
        self.assertEqual(calls[0]["url"], "https://api.example.com/v1/embeddings")
        self.assertEqual(calls[0]["body"], {"model": "text-embedding-3-small", "input": ["hello"]})
        self.assertEqual(calls[0]["headers"]["authorization"], "Bearer sk-test")

    def test_a_reordered_answer_is_put_back_in_order(self):
        # `index` is in the contract precisely because arrival order is not
        # promised. Trusting it attaches the wrong vector to the wrong chunk,
        # and every vector is still the right shape.
        patcher, _ = upstream(
            [
                {
                    "data": [
                        {"index": 2, "embedding": [3.0]},
                        {"index": 0, "embedding": [1.0]},
                        {"index": 1, "embedding": [2.0]},
                    ],
                },
            ],
        )
        with patcher:
            got = app.embed(self.routes(), "text-embedding-3-small", ["a", "b", "c"])
        self.assertEqual(got, [[1.0], [2.0], [3.0]])

    def test_a_short_batch_is_a_failure_and_not_a_partial_answer(self):
        patcher, _ = upstream([{"data": [{"index": 0, "embedding": [1.0]}]}])
        with patcher, self.assertRaises(app.UpstreamError) as caught:
            app.embed(self.routes(), "text-embedding-3-small", ["a", "b"])
        self.assertIn("1 vectors for 2 inputs", str(caught.exception))

    def test_an_upstream_error_body_is_never_echoed(self):
        # A vendor's error message can quote the input it rejected, and the
        # input is document text.
        failure = urllib.error.HTTPError(
            "https://api.example.com/v1/embeddings",
            400,
            "Bad Request",
            {},
            io.BytesIO(b'{"error":{"message":"could not embed: the quarterly revenue was"}}'),
        )
        patcher, _ = upstream([failure])
        with patcher, self.assertRaises(app.UpstreamError) as caught:
            app.embed(self.routes(), "text-embedding-3-small", ["the quarterly revenue was"])
        self.assertIn("400", str(caught.exception))
        self.assertNotIn("quarterly", str(caught.exception))


class Cloudflare(unittest.TestCase):
    def routes(self):
        with env(
            NACRE_EMBED_ROUTES="@cf/baai/bge-m3=cloudflare",
            NACRE_EMBED_CLOUDFLARE_ACCOUNT="acc123",
            NACRE_EMBED_CLOUDFLARE_API_KEY="cf-test",
        ):
            return app.load_routes()

    def test_it_speaks_the_vendors_shape(self):
        patcher, calls = upstream([{"success": True, "result": {"data": [[1.0, 2.0]]}}])
        with patcher:
            got = app.embed(self.routes(), "@cf/baai/bge-m3", ["hello"])
        self.assertEqual(got, [[1.0, 2.0]])
        self.assertEqual(
            calls[0]["url"],
            "https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/baai/bge-m3",
        )
        self.assertEqual(calls[0]["body"], {"text": ["hello"]})

    def test_a_200_that_says_it_failed_is_a_failure(self):
        # Cloudflare answers 200 with `success: false` for a model that does not
        # exist, so the status alone is not the verdict.
        patcher, _ = upstream([{"success": False, "errors": [{"message": "no such model"}]}])
        with patcher, self.assertRaises(app.UpstreamError):
            app.embed(self.routes(), "@cf/baai/bge-m3", ["hello"])

    def test_a_batch_over_the_vendor_limit_is_split_and_stays_in_order(self):
        # 250 inputs against a limit of 100: three calls, and the result has to
        # read as one list in the order it was sent.
        texts = [f"t{i}" for i in range(250)]
        answers = [
            {"success": True, "result": {"data": [[float(i)] for i in range(0, 100)]}},
            {"success": True, "result": {"data": [[float(i)] for i in range(100, 200)]}},
            {"success": True, "result": {"data": [[float(i)] for i in range(200, 250)]}},
        ]
        patcher, calls = upstream(answers)
        with patcher:
            got = app.embed(self.routes(), "@cf/baai/bge-m3", texts)
        self.assertEqual(len(calls), 3)
        self.assertEqual([len(c["body"]["text"]) for c in calls], [100, 100, 50])
        self.assertEqual(got, [[float(i)] for i in range(250)])


class Google(unittest.TestCase):
    def routes(self):
        with env(
            NACRE_EMBED_ROUTES="gemini-embedding-001=google",
            NACRE_EMBED_GOOGLE_API_KEY="g-test",
        ):
            return app.load_routes()

    def test_it_qualifies_the_model_and_reads_values(self):
        patcher, calls = upstream([{"embeddings": [{"values": [1.0]}, {"values": [2.0]}]}])
        with patcher:
            got = app.embed(self.routes(), "gemini-embedding-001", ["a", "b"])
        self.assertEqual(got, [[1.0], [2.0]])
        self.assertIn("models/gemini-embedding-001:batchEmbedContents", calls[0]["url"])
        self.assertEqual(calls[0]["body"]["requests"][0]["content"]["parts"][0]["text"], "a")

    def test_the_credential_is_not_in_a_header_this_vendor_does_not_read(self):
        # Google takes the key as a query parameter. Sending it as a bearer
        # token as well would put it somewhere it is not needed.
        patcher, calls = upstream([{"embeddings": [{"values": [1.0]}]}])
        with patcher:
            app.embed(self.routes(), "gemini-embedding-001", ["a"])
        self.assertNotIn("authorization", calls[0]["headers"])
        self.assertIn("key=g-test", calls[0]["url"])


class TwoVendorsAtOnce(unittest.TestCase):
    def test_each_model_reaches_its_own_vendor(self):
        # The arrangement the schema has offered since 0001 and the product
        # could not reach: two organizations on two vendors, with no new
        # machinery beyond a string an operator already fills in.
        with env(
            NACRE_EMBED_ROUTES="a=google,b=cloudflare",
            NACRE_EMBED_GOOGLE_API_KEY="g",
            NACRE_EMBED_CLOUDFLARE_API_KEY="c",
            NACRE_EMBED_CLOUDFLARE_ACCOUNT="acc",
        ):
            routes = app.load_routes()

        patcher, calls = upstream(
            [
                {"embeddings": [{"values": [1.0]}]},
                {"success": True, "result": {"data": [[2.0]]}},
            ],
        )
        with patcher:
            self.assertEqual(app.embed(routes, "a", ["x"]), [[1.0]])
            self.assertEqual(app.embed(routes, "b", ["x"]), [[2.0]])
        self.assertIn("generativelanguage.googleapis.com", calls[0]["url"])
        self.assertIn("api.cloudflare.com", calls[1]["url"])


class Voyage(unittest.TestCase):
    """
    The vendor that exists because Anthropic's does not.

    Anthropic publishes no embeddings API and points at Voyage, so this is where
    "embeddings from Anthropic" has to land. Its wire format is OpenAI's, which
    is why it shares a parser and why the test worth writing is that it reaches
    Voyage's own endpoint rather than whatever `openai-compatible` was pointed
    at.
    """

    def routes(self):
        with env(NACRE_EMBED_ROUTES="voyage-3=voyage", NACRE_EMBED_VOYAGE_API_KEY="vk"):
            return app.load_routes()

    def test_reaches_voyage_and_reads_the_openai_shape(self):
        patcher, calls = upstream(
            [{"data": [{"index": 1, "embedding": [2.0]}, {"index": 0, "embedding": [1.0]}]}],
        )
        with patcher:
            vectors = app.embed(self.routes(), "voyage-3", ["a", "b"])

        self.assertEqual(vectors, [[1.0], [2.0]])
        self.assertEqual(calls[0]["url"], "https://api.voyageai.com/v1/embeddings")
        self.assertEqual(calls[0]["headers"]["authorization"], "Bearer vk")
        self.assertEqual(calls[0]["body"]["model"], "voyage-3")

    def test_no_endpoint_variable_is_required(self):
        # Naming the vendor is choosing the endpoint. An operator who had to
        # know `api.voyageai.com` to use the vendor called `voyage` would be
        # doing the adapter's job.
        with env(NACRE_EMBED_ROUTES="voyage-3=voyage", NACRE_EMBED_VOYAGE_API_KEY="vk"):
            routes = app.load_routes()
        self.assertNotIn("endpoint", routes["voyage-3"])


class UpstreamModelMapping(unittest.TestCase):
    """
    `model=vendor:upstream-model`, and the reason it exists.

    A layer's named vector is derived from the model — `v_{model}_{dimensions}`
    — so an installation already indexed against `bge-m3` cannot be pointed at
    Cloudflare's copy of the same weights by renaming the model: that is a
    different slot and a reindex of every layer. The weights are identical and
    only the vendor's spelling differs, so the spelling is what moves.
    """

    def test_the_vendor_is_asked_for_the_upstream_name(self):
        with env(
            NACRE_EMBED_ROUTES="bge-m3=cloudflare:@cf/baai/bge-m3",
            NACRE_EMBED_CLOUDFLARE_API_KEY="k",
            NACRE_EMBED_CLOUDFLARE_ACCOUNT="acc",
        ):
            routes = app.load_routes()

        patcher, calls = upstream([{"success": True, "result": {"data": [[1.0]]}}])
        with patcher:
            self.assertEqual(app.embed(routes, "bge-m3", ["x"]), [[1.0]])

        # The caller's name routes; the vendor's name is what goes out.
        self.assertIn("@cf/baai/bge-m3", calls[0]["url"])
        self.assertNotIn("/ai/run/bge-m3", calls[0]["url"])

    def test_without_a_mapping_the_route_key_is_still_what_is_sent(self):
        with env(
            NACRE_EMBED_ROUTES="@cf/baai/bge-m3=cloudflare",
            NACRE_EMBED_CLOUDFLARE_API_KEY="k",
            NACRE_EMBED_CLOUDFLARE_ACCOUNT="acc",
        ):
            routes = app.load_routes()
        self.assertEqual(routes["@cf/baai/bge-m3"]["upstream_model"], "@cf/baai/bge-m3")

    def test_a_trailing_colon_is_refused(self):
        with env(
            NACRE_EMBED_ROUTES="bge-m3=cloudflare:",
            NACRE_EMBED_CLOUDFLARE_API_KEY="k",
            NACRE_EMBED_CLOUDFLARE_ACCOUNT="acc",
        ), self.assertRaises(app.ConfigError) as caught:
            app.load_routes()
        self.assertIn("upstream model", str(caught.exception))


class RerankConfiguration(unittest.TestCase):
    def test_neither_variable_is_no_reranker_rather_than_an_error(self):
        with env(NACRE_EMBED_ROUTES="m=google", NACRE_EMBED_GOOGLE_API_KEY="g"):
            self.assertIsNone(app.load_reranker())

    def test_half_configured_is_refused_naming_the_missing_half(self):
        with env(NACRE_RERANK_VENDOR="cohere"), self.assertRaises(app.ConfigError) as caught:
            app.load_reranker()
        self.assertIn("NACRE_RERANK_MODEL", str(caught.exception))

        with env(NACRE_RERANK_MODEL="rerank-v3.5"), self.assertRaises(app.ConfigError) as caught:
            app.load_reranker()
        self.assertIn("NACRE_RERANK_VENDOR", str(caught.exception))

    def test_an_unknown_vendor_says_which_ones_cannot_exist(self):
        # The three an operator is most likely to try are the three with no
        # reranking API at all, so the refusal says so rather than only listing
        # the four that work.
        with env(
            NACRE_RERANK_VENDOR="openai",
            NACRE_RERANK_MODEL="whatever",
        ), self.assertRaises(app.ConfigError) as caught:
            app.load_reranker()
        message = str(caught.exception)
        self.assertIn("cohere", message)
        self.assertIn("jina", message)
        self.assertIn("Anthropic", message)

    def test_a_rerank_only_adapter_starts(self):
        # The two jobs are independent. A deployment that embeds locally and
        # reranks through a vendor must not have to invent an embedding route.
        with env(
            NACRE_RERANK_VENDOR="jina",
            NACRE_RERANK_MODEL="jina-reranker-v2-base-multilingual",
            NACRE_RERANK_JINA_API_KEY="jk",
        ):
            self.assertEqual(app.load_routes(required=False), {})
            self.assertIsNotNone(app.load_reranker())

    def test_a_rerank_vendor_without_its_credential_is_refused(self):
        with env(
            NACRE_RERANK_VENDOR="voyage",
            NACRE_RERANK_MODEL="rerank-2",
        ), self.assertRaises(app.ConfigError) as caught:
            app.load_reranker()
        self.assertIn("NACRE_RERANK_VOYAGE_API_KEY", str(caught.exception))

    def test_the_refusal_names_what_selected_the_vendor_and_not_a_route(self):
        # Reranking has no routes. "a route names the cloudflare vendor" sent
        # the reader looking through NACRE_EMBED_ROUTES for something that was
        # never there — found by starting the container with the credentials
        # still empty, which is the state every first run is in.
        with env(
            NACRE_RERANK_VENDOR="cloudflare",
            NACRE_RERANK_MODEL="@cf/baai/bge-reranker-base",
        ), self.assertRaises(app.ConfigError) as caught:
            app.load_reranker()
        message = str(caught.exception)
        self.assertIn("NACRE_RERANK_VENDOR names the cloudflare vendor", message)
        self.assertNotIn("a route", message)


class RejectedCredential(unittest.TestCase):
    """
    A 401 from a vendor names the variable that holds the credential.

    `cloudflare answered 401` was the whole of it, and it is one step short of
    actionable — a 401 from a vendor means the key this adapter holds was
    rejected, which is the opposite of what the core's own 401 helper explains
    ("this endpoint wants a credential and Nacre sends none"). The two read
    alike and point opposite ways.
    """

    def embed_routes(self):
        with env(
            NACRE_EMBED_ROUTES="bge-m3=cloudflare:@cf/baai/bge-m3",
            NACRE_EMBED_CLOUDFLARE_ACCOUNT="acc123",
            NACRE_EMBED_CLOUDFLARE_API_KEY="cf-test",
        ):
            return app.load_routes()

    def rerank_cfg(self):
        with env(
            NACRE_RERANK_VENDOR="cloudflare",
            NACRE_RERANK_MODEL="@cf/baai/bge-reranker-base",
            NACRE_RERANK_CLOUDFLARE_ACCOUNT="acc123",
            NACRE_RERANK_CLOUDFLARE_API_KEY="cf-test",
        ):
            return app.load_reranker()

    @staticmethod
    def refusal(status: int):
        return urllib.error.HTTPError("https://api.cloudflare.com/", status, "", {}, io.BytesIO(b"{}"))

    def test_it_names_the_embedding_variable_on_401(self):
        patcher, _ = upstream([self.refusal(401)])
        with patcher, self.assertRaises(app.UpstreamError) as caught:
            app.embed(self.embed_routes(), "bge-m3", ["hello"])

        said = str(caught.exception)
        self.assertIn("cloudflare answered 401", said)
        # `[_FILE]` rather than both spellings: the core bounds this at 200
        # characters and the pair for `openai-compatible` is 79 of them. Both
        # names in full are on the log line beside it, which has no bound.
        self.assertIn("NACRE_EMBED_CLOUDFLARE_API_KEY[_FILE]", said)
        self.assertIn("sha256:", said)

    def test_the_rerank_path_names_its_own_variable_and_not_the_other(self):
        # The reason `key_vars` is carried rather than derived from the vendor
        # name: `cloudflare` is in both tables under different variables, and a
        # message naming the wrong one sends the reader somewhere with nothing
        # in it. Same defect `named_by` was added for one layer up.
        patcher, _ = upstream([self.refusal(401)])
        with patcher, self.assertRaises(app.UpstreamError) as caught:
            app.rerank(self.rerank_cfg(), "q", ["a"])

        said = str(caught.exception)
        self.assertIn("NACRE_RERANK_CLOUDFLARE_API_KEY", said)
        self.assertNotIn("NACRE_EMBED_CLOUDFLARE_API_KEY", said)

    def test_403_is_the_same_answer(self):
        patcher, _ = upstream([self.refusal(403)])
        with patcher, self.assertRaises(app.UpstreamError) as caught:
            app.embed(self.embed_routes(), "bge-m3", ["hello"])
        self.assertIn("NACRE_EMBED_CLOUDFLARE_API_KEY", str(caught.exception))

    def test_a_quota_or_an_outage_gets_no_paragraph_about_credentials(self):
        # 429 is a quota and 500 is the vendor's own outage. A paragraph about
        # credentials on either is noise on the failures nobody here can fix,
        # and it would be wrong.
        for status in (429, 500, 503):
            patcher, _ = upstream([self.refusal(status)])
            with patcher, self.assertRaises(app.UpstreamError) as caught:
                app.embed(self.embed_routes(), "bge-m3", ["hello"])
            said = str(caught.exception)
            self.assertEqual(said, f"cloudflare answered {status}")
            self.assertNotIn("NACRE_EMBED", said)

    def test_a_failure_with_no_status_is_left_alone(self):
        # An unreachable host has no status, and "check your credential" would
        # be actively misleading.
        patcher, _ = upstream([urllib.error.URLError("nope")])
        with patcher, self.assertRaises(app.UpstreamError) as caught:
            app.embed(self.embed_routes(), "bge-m3", ["hello"])
        self.assertNotIn("NACRE_EMBED", str(caught.exception))


class RefusalsFitTheCoresBound(unittest.TestCase):
    """
    A message this service writes has to survive the core reading it.

    Two ends, and nothing held them together. The adapter composes a refusal;
    `endpointReason` in the core takes one declared field and cuts it at
    `REASON_LIMIT`, because a vendor's error can quote the input it rejected.
    So a message written here longer than that bound is a message an operator
    reads with the end missing — and the end is where the last thing added
    always goes.

    That already happened: the first version of the credential refusal was 337
    characters and lost its final clause, with no margin left before a vendor
    with longer variable names would have lost a variable *name*. Found by
    measuring rather than by reading, which is why this asks every entry in
    both tables rather than the one that prompted it.

    The bound is read out of the core rather than written down here. A number
    copied into a second language is the drift this whole file exists against.
    """

    HERE = os.path.dirname(os.path.abspath(__file__))
    ROOT = os.path.dirname(os.path.dirname(HERE))

    def bound(self) -> int:
        source = os.path.join(self.ROOT, "packages", "core", "endpoint.ts")
        with open(source, encoding="utf-8") as handle:
            found = re.search(r"^const REASON_LIMIT = (\d+)$", handle.read(), re.M)
        self.assertIsNotNone(
            found,
            f"{source} no longer declares REASON_LIMIT. It is the bound this check compares "
            "against; renaming it does not make the messages fit, it makes this stop looking.",
        )
        return int(found.group(1))

    def test_every_credential_refusal_fits(self):
        limit = self.bound()
        # Both tables, because `cloudflare` is in each under different variables
        # and the rerank names are the longer pair. The vendor that prompted
        # this is not the one closest to the bound.
        for table in (app.VENDORS, app.RERANKERS):
            for vendor, spec in table.items():
                cfg = {
                    "vendor": vendor,
                    "key_vars": tuple(spec["key"]),
                    "key_fingerprint": "sha256:0123456789ab",
                }
                # 503 is the widest plausible status; every one is three digits.
                built = app._rejected_credential(app.UpstreamError(f"{vendor} answered 401", 401), cfg)
                said = str(built)
                self.assertLessEqual(
                    len(said),
                    limit,
                    f"the {vendor} credential refusal is {len(said)} characters and the core cuts "
                    f"an endpoint's reason at {limit}. What an operator reads would end "
                    f"mid-sentence: {said[:limit]}…",
                )
                # And the parts that must be inside the bound, rather than only
                # the length being right.
                self.assertIn(spec["key"][0], said)
                self.assertIn("sha256:0123456789ab", said)


class Rerank(unittest.TestCase):
    """
    One score per input, in input order, from four vendors that do not agree
    about the shape of any of that.
    """

    def reranker(self, vendor: str, **extra: str):
        with env(
            NACRE_RERANK_VENDOR=vendor,
            NACRE_RERANK_MODEL="a-model",
            **{f"NACRE_RERANK_{vendor.upper()}_API_KEY": "k"},
            **extra,
        ):
            return app.load_reranker()

    def test_cohere_jina_and_voyage_each_reach_their_own_endpoint(self):
        for vendor, host, field in (
            ("cohere", "api.cohere.com", "results"),
            ("jina", "api.jina.ai", "results"),
            ("voyage", "api.voyageai.com", "data"),
        ):
            with self.subTest(vendor=vendor):
                patcher, calls = upstream(
                    [{field: [{"index": 0, "relevance_score": 0.5}, {"index": 1, "relevance_score": 0.9}]}],
                )
                with patcher:
                    scores = app.rerank(self.reranker(vendor), "q", ["a", "b"])
                self.assertEqual(scores, [0.5, 0.9])
                self.assertIn(host, calls[0]["url"])
                self.assertEqual(calls[0]["body"]["documents"], ["a", "b"])
                self.assertEqual(calls[0]["body"]["query"], "q")

    def test_cloudflare_uses_id_and_contexts(self):
        cfg = self.reranker("cloudflare", NACRE_RERANK_CLOUDFLARE_ACCOUNT="acc")
        patcher, calls = upstream(
            [{"success": True, "result": {"response": [{"id": 1, "score": 0.2}, {"id": 0, "score": 0.7}]}}],
        )
        with patcher:
            scores = app.rerank(cfg, "q", ["a", "b"])

        self.assertEqual(scores, [0.7, 0.2])
        self.assertIn("api.cloudflare.com", calls[0]["url"])
        self.assertIn("acc", calls[0]["url"])
        self.assertEqual(calls[0]["body"]["contexts"], [{"text": "a"}, {"text": "b"}])

    def test_results_out_of_order_are_placed_by_index(self):
        # The failure this exists for: every vendor sorts by score, so the
        # answer arrives in a different order from the request. Trusting arrival
        # order attaches each score to the wrong chunk, and the result is a
        # plausible ranking of the wrong documents — nothing downstream can tell.
        patcher, _ = upstream(
            [
                {
                    "results": [
                        {"index": 2, "relevance_score": 0.9},
                        {"index": 0, "relevance_score": 0.1},
                        {"index": 1, "relevance_score": 0.5},
                    ],
                },
            ],
        )
        with patcher:
            scores = app.rerank(self.reranker("cohere"), "q", ["a", "b", "c"])
        self.assertEqual(scores, [0.1, 0.5, 0.9])

    def test_a_short_answer_is_refused_rather_than_left_unscored(self):
        # `HttpReranker` fills a missing score with -Infinity and refuses; this
        # refuses one hop earlier, where the vendor can be named. A truncating
        # vendor — one honouring a `top_n` nobody sent — would otherwise sink
        # every unscored candidate to the bottom with no error anywhere.
        patcher, _ = upstream([{"results": [{"index": 0, "relevance_score": 0.9}]}])
        with patcher, self.assertRaises(app.UpstreamError) as caught:
            app.rerank(self.reranker("cohere"), "q", ["a", "b", "c"])
        self.assertIn("1 of 3", str(caught.exception))

    def test_an_index_scored_twice_is_refused(self):
        patcher, _ = upstream(
            [{"results": [{"index": 0, "relevance_score": 0.9}, {"index": 0, "relevance_score": 0.1}]}],
        )
        with patcher, self.assertRaises(app.UpstreamError) as caught:
            app.rerank(self.reranker("cohere"), "q", ["a", "b"])
        self.assertIn("twice", str(caught.exception))

    def test_an_index_out_of_range_is_refused(self):
        patcher, _ = upstream(
            [{"results": [{"index": 0, "relevance_score": 0.9}, {"index": 7, "relevance_score": 0.1}]}],
        )
        with patcher, self.assertRaises(app.UpstreamError) as caught:
            app.rerank(self.reranker("cohere"), "q", ["a", "b"])
        self.assertIn("7", str(caught.exception))

    def test_no_reranker_configured_is_a_route_error(self):
        with self.assertRaises(app.RouteError) as caught:
            app.rerank(None, "q", ["a"])
        self.assertIn("NACRE_RERANK_VENDOR", str(caught.exception))

    def test_the_batch_limit_is_above_the_default_candidate_count(self):
        # NACRE_RERANK_CANDIDATES defaults to 50. A limit at or below it would
        # make the shipped configuration refuse every search.
        self.assertGreater(app.MAX_RERANK_TEXTS, 50)


class Documentation(unittest.TestCase):
    """
    Every vendor this service routes to is in both places that list them.

    `VENDORS` and `RERANKERS` are the tables, and two documents copy them: this
    directory's README and `docs/config.md`, which is normative. Adding a vendor
    means editing three files, and `lint:config` sees only part of it — it holds
    the `NACRE_EMBED_*` and `NACRE_RERANK_*` literals against `docs/config.md`,
    so a vendor whose credential variable is documented in a sentence rather
    than in the table passes it, and the README is not a file it reads at all.

    Held from here rather than from a `lint:` script because the tables are
    Python: a check in another language would have to parse this file, and a
    check that parses the thing it is checking gets the answer the parser
    happens to give.
    """

    HERE = os.path.dirname(os.path.abspath(__file__))
    ROOT = os.path.dirname(os.path.dirname(HERE))

    # The first cell of each table's header row, which is what says which table
    # it is. Both documents write them the same way.
    EMBEDDING_HEADER = "`vendor`"
    RERANK_HEADER = "`NACRE_RERANK_VENDOR`"

    @staticmethod
    def _cells(line: str) -> list[str] | None:
        if not line.startswith("|"):
            return None
        return [cell.strip() for cell in line.strip().strip("|").split("|")]

    @classmethod
    def _first_column(cls, markdown: str, header: str) -> list[str] | None:
        """
        The codes in the first column of the table whose header row's first cell
        is `header`, in order, or `None` if there is no such table.

        A header is a row **followed by the `|---|` rule**, and not merely a row
        whose first cell matches. Both documents also carry a table of variables
        where `NACRE_RERANK_VENDOR` is a *row*, and the looser rule read that
        one — reporting the variables as the vendor list, which is a check
        failing on the wrong thing rather than on nothing.
        """
        lines = markdown.splitlines()
        rows: list[str] | None = None
        for index, line in enumerate(lines):
            cells = cls._cells(line)
            if cells is None:
                if rows is not None:
                    break
                continue
            if rows is None:
                below = cls._cells(lines[index + 1]) if index + 1 < len(lines) else None
                if cells[0] == header and below is not None and set(below[0]) <= {"-", ":"}:
                    rows = []
                continue
            if set(cells[0]) <= {"-", ":"}:
                continue
            rows.append(cells[0].strip("`"))
        return rows

    def _document(self, path: str) -> str:
        with open(path, encoding="utf-8") as handle:
            return handle.read()

    def _assert_tables(self, path: str):
        markdown = self._document(path)
        for header, table in (
            (self.EMBEDDING_HEADER, app.VENDORS),
            (self.RERANK_HEADER, app.RERANKERS),
        ):
            listed = self._first_column(markdown, header)
            self.assertIsNotNone(
                listed,
                f"{path} has no table headed {header}. Renaming or removing it does not make "
                f"the vendors documented — it makes this check stop looking.",
            )
            self.assertEqual(
                sorted(listed),
                sorted(table),
                f"{path}'s {header} table and the adapter's own do not agree. A vendor the "
                f"service routes to and no document lists is one nobody can find; a vendor a "
                f"document lists and the service does not route to is refused by name.",
            )

    def test_the_readme_lists_every_vendor(self):
        self._assert_tables(os.path.join(self.HERE, "README.md"))

    def test_the_configuration_reference_lists_every_vendor(self):
        self._assert_tables(os.path.join(self.ROOT, "docs", "config.md"))


class Logging(unittest.TestCase):
    """
    What an operator can find out from this container when it refuses.

    Before these, the answer was nothing at all. `log_message` is silenced
    deliberately — the default logs a request line, and a logger that grows one
    line is how document text ends up beside it — but no refusal wrote anything
    either, so a deployment whose vendor had started answering 429 had a log
    holding exactly the line it printed at startup. The caller's log said `the
    embedding endpoint at http://embedding-adapter:8091/embeddings answered
    502`, which names this service: the one process in the chain that did not
    decide anything.
    """

    def routes(self):
        with env(
            NACRE_EMBED_ROUTES="bge-m3=cloudflare:@cf/baai/bge-m3",
            NACRE_EMBED_CLOUDFLARE_ACCOUNT="acc123",
            NACRE_EMBED_CLOUDFLARE_API_KEY="cf-test",
        ):
            return app.load_routes()

    def test_a_vendor_refusal_names_the_vendor_and_its_status(self):
        failure = urllib.error.HTTPError(
            "https://api.cloudflare.com/", 429, "Too Many Requests", {}, io.BytesIO(b"{}"),
        )
        patcher, _ = upstream([failure])
        with patcher, running(self.routes()) as (port, printed):
            status, body = post(port, "/embeddings", {"model": "bge-m3", "input": ["hello"]})

        self.assertEqual(status, 502)
        self.assertIn("cloudflare answered 429", body["error"]["message"])

        # The same sentence in the log, because a caller that discards the body
        # must not be the only place the fact exists.
        logged = lines(printed)
        self.assertEqual(len(logged), 1, f"expected one line, got {logged}")
        self.assertEqual(logged[0]["level"], "error")
        self.assertEqual(logged[0]["status"], 502)
        self.assertIn("cloudflare answered 429", logged[0]["msg"])

    def test_the_vendors_own_body_reaches_neither_the_reply_nor_the_log(self):
        # The property that makes logging every refusal safe: a vendor's error
        # can quote the input it rejected, and the input is document text.
        failure = urllib.error.HTTPError(
            "https://api.cloudflare.com/",
            400,
            "Bad Request",
            {},
            io.BytesIO(b'{"errors":[{"message":"cannot embed: the quarterly revenue was"}]}'),
        )
        patcher, _ = upstream([failure])
        with patcher, running(self.routes()) as (port, printed):
            _, body = post(port, "/embeddings", {"model": "bge-m3", "input": ["the quarterly revenue was"]})

        self.assertNotIn("quarterly", json.dumps(body))
        self.assertNotIn("quarterly", printed.getvalue())

    def test_a_successful_request_logs_nothing(self):
        # The reason `log_message` is silenced, kept true now that there is a
        # logger to grow: one line per embed is one line per document.
        patcher, _ = upstream([{"success": True, "result": {"data": [[1.0, 2.0]]}}])
        with patcher, running(self.routes()) as (port, printed):
            status, body = post(port, "/embeddings", {"model": "bge-m3", "input": ["hello"]})

        self.assertEqual(status, 200)
        self.assertEqual(body["data"][0]["embedding"], [1.0, 2.0])
        self.assertEqual(printed.getvalue(), "")

    def test_the_callers_own_mistake_is_a_warning_and_not_an_error(self):
        # An unrouted model is a 404 and somebody's configuration; a vendor
        # failing is a 502 and nobody here can fix it. An operator grepping for
        # `"level":"error"` must not find the first.
        patcher, _ = upstream([])
        with patcher, running(self.routes()) as (port, printed):
            status, _ = post(port, "/embeddings", {"model": "not-routed", "input": ["hello"]})

        self.assertEqual(status, 404)
        logged = lines(printed)
        self.assertEqual([entry["level"] for entry in logged], ["warn"])
        self.assertIn("not-routed", logged[0]["msg"])

    def test_a_rejected_credential_is_logged_with_its_fingerprint(self):
        # Over a real socket, because what is being checked is the line an
        # operator reads in `docker logs` — and the fingerprint is the only way
        # to answer "did the token I deployed reach this container", which a
        # rotation that silently did not take makes indistinguishable from a
        # token that is simply wrong.
        failure = urllib.error.HTTPError(
            "https://api.cloudflare.com/", 401, "Unauthorized", {}, io.BytesIO(b"{}"),
        )
        patcher, _ = upstream([failure])
        with patcher, running(self.routes()) as (port, printed):
            status, body = post(port, "/embeddings", {"model": "bge-m3", "input": ["hello"]})

        self.assertEqual(status, 502)
        self.assertIn("rejecting this adapter's credential sha256:", body["error"]["message"])

        logged = lines(printed)[0]
        self.assertTrue(logged["credential"].startswith("sha256:"))
        self.assertEqual(
            logged["variables"],
            ["NACRE_EMBED_CLOUDFLARE_API_KEY", "NACRE_EMBED_CLOUDFLARE_API_KEY_FILE"],
        )
        self.assertIn("sha256sum", logged["hint"])
        # The credential is in neither, which is the whole point of a
        # fingerprint rather than a prefix of the token.
        self.assertNotIn("cf-test", printed.getvalue())
        self.assertNotIn("cf-test", json.dumps(body))

    def test_a_quota_carries_no_extra_fields_at_all(self):
        failure = urllib.error.HTTPError("https://api.cloudflare.com/", 429, "", {}, io.BytesIO(b"{}"))
        patcher, _ = upstream([failure])
        with patcher, running(self.routes()) as (port, printed):
            post(port, "/embeddings", {"model": "bge-m3", "input": ["hello"]})

        logged = lines(printed)[0]
        self.assertNotIn("credential", logged)
        self.assertNotIn("hint", logged)

    def test_an_unexpected_failure_logs_its_type_and_never_its_text(self):
        # The one branch whose message cannot be trusted: it is an exception
        # this file did not raise, and this process holds every document's text.
        def explode(*_args, **_kwargs):
            raise RuntimeError("the quarterly revenue was")

        with patch.object(app, "embed", explode), running(self.routes()) as (port, printed):
            status, body = post(port, "/embeddings", {"model": "bge-m3", "input": ["hello"]})

        self.assertEqual(status, 500)
        self.assertEqual(body["error"]["message"], "the embedding request could not be completed")
        logged = lines(printed)
        self.assertEqual(logged[0]["exception"], "RuntimeError")
        self.assertNotIn("quarterly", printed.getvalue())


if __name__ == "__main__":
    unittest.main()
