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

import io
import json
import os
import tempfile
import unittest
import urllib.error
from contextlib import contextmanager
from unittest.mock import patch

from services.embedding_adapter import app


@contextmanager
def env(**values: str | None):
    """Set exactly these NACRE_EMBED_ variables, clearing every other one."""
    saved = dict(os.environ)
    for key in list(os.environ):
        if key.startswith("NACRE_EMBED_"):
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


if __name__ == "__main__":
    unittest.main()
