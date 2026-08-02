"""
Tests for the parser sidecar.

Mostly about what it refuses to fetch. `POST /v1/documents` takes a URL and
hands it here, so this is the one component in the system that an authenticated
tenant can point at an address of their choosing — and the response comes back
as document text, which is indexed and searchable. Without the guard that is an
exfiltration channel for the cloud metadata endpoint, the API next to it, and
the vector store, which has no per-tenant authorization of its own.

Standard library only, like the service. Run with `python -m unittest discover
-s services/parser`.
"""

from __future__ import annotations

import socket
import unittest
from unittest import mock

from services.parser import app


def resolves_to(*addresses: str):
    """Stand in for DNS, so the tests do not depend on a name resolving."""

    def fake(host, port, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ARG001
        return [
            (
                socket.AF_INET6 if ":" in a else socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                (a, port),
            )
            for a in addresses
        ]

    return mock.patch.object(socket, "getaddrinfo", side_effect=fake)


class SchemeTests(unittest.TestCase):
    def test_only_http_and_https(self) -> None:
        for url in ("file:///etc/passwd", "gopher://x/", "ftp://x/", "data:text/plain,x"):
            with self.subTest(url=url), self.assertRaises(app.ParseError) as caught:
                app._check_reachable(url)
            self.assertIn("http", str(caught.exception))

    def test_a_url_with_no_host_is_refused(self) -> None:
        with self.assertRaises(app.ParseError):
            app._check_reachable("http:///nowhere")


class AddressTests(unittest.TestCase):
    def test_the_cloud_metadata_endpoint_is_refused(self) -> None:
        # 169.254.169.254. The single most valuable thing reachable from inside
        # a container, and it needs no credentials to read.
        with resolves_to("169.254.169.254"), self.assertRaises(app.ParseError):
            app._check_reachable("http://metadata.example/latest/meta-data/")

    def test_loopback_and_private_ranges_are_refused(self) -> None:
        for address in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "::1", "fd00::1"):
            with self.subTest(address=address), resolves_to(address):
                with self.assertRaises(app.ParseError):
                    app._check_reachable("http://internal.example/doc")

    def test_a_public_address_is_allowed(self) -> None:
        with resolves_to("93.184.216.34"):
            app._check_reachable("https://example.com/doc.txt")

    def test_one_private_answer_among_public_ones_is_refused(self) -> None:
        # A name that resolves to both is the whole trick: checking only the
        # first answer lets the connection land on the other one.
        with resolves_to("93.184.216.34", "127.0.0.1"), self.assertRaises(app.ParseError):
            app._check_reachable("http://split.example/doc")

    def test_a_name_that_does_not_resolve_is_refused_as_input(self) -> None:
        with mock.patch.object(socket, "getaddrinfo", side_effect=socket.gaierror):
            with self.assertRaises(app.ParseError):
                app._check_reachable("http://nowhere.invalid/doc")

    def test_the_escape_hatch_is_off_unless_asked_for(self) -> None:
        # A deployment indexing an internal wiki needs this; it is off by
        # default because turning it on hands every tenant the container's
        # network position.
        self.assertFalse(app.ALLOW_PRIVATE)

        with mock.patch.object(app, "ALLOW_PRIVATE", True), resolves_to("10.0.0.5"):
            app._check_reachable("http://wiki.internal/doc")


class RedirectTests(unittest.TestCase):
    def test_a_redirect_into_a_private_address_is_refused(self) -> None:
        handler = app._GuardedRedirects()

        # A public URL answering 302 to the metadata endpoint is the same
        # attack with one more step, and it is the one a scheme check misses.
        with resolves_to("169.254.169.254"), self.assertRaises(app.ParseError):
            handler.redirect_request(
                mock.Mock(), mock.Mock(), 302, "Found", {}, "http://metadata.example/latest/"
            )


class ParseSourceTests(unittest.TestCase):
    def test_exactly_one_of_content_or_url(self) -> None:
        for source in ({}, {"content": "a", "url": "http://example.com"}):
            with self.subTest(source=source), self.assertRaises(app.ParseError):
                app.parse_source(source)

    def test_inline_content_is_returned_with_its_byte_count(self) -> None:
        result = app.parse_source({"content": "layers"})
        self.assertEqual(result["text"], "layers")
        self.assertEqual(result["metadata"]["bytes"], 6)
        # Empty rather than fabricated: a consumer seeing an empty list knows
        # there is no structure, and one seeing a single block does not.
        self.assertEqual(result["blocks"], [])

    def test_a_fetch_failure_does_not_describe_what_it_could_not_reach(self) -> None:
        import urllib.error

        with mock.patch.object(app, "fetch", side_effect=urllib.error.URLError("connection refused to 10.0.0.5")):
            with self.assertRaises(app.ParseError) as caught:
                app.parse_source({"url": "http://example.com/doc"})

        # Otherwise the error message is a port scanner: the difference between
        # "refused" and "timed out" maps the network this container sits in.
        self.assertNotIn("10.0.0.5", str(caught.exception))

    def test_a_document_over_the_limit_is_refused(self) -> None:
        with mock.patch.object(app, "fetch", return_value=b"x" * (app.MAX_BYTES + 1)):
            with self.assertRaises(app.ParseError):
                app.parse_source({"url": "http://example.com/big"})


if __name__ == "__main__":
    unittest.main()
