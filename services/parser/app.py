"""
The parser sidecar: bytes -> {text, blocks, metadata}.

Python because that is where the document-parsing libraries live, and a
separate process because this is the one component that runs untrusted input
through a large C dependency tree. It holds no credentials and reaches no
database. If it is compromised, there is nothing here to reach.

Deliberately dependency-free at this stage: the format handlers are the next
step, and standing up a web framework before there is anything to parse would
just be a dependency to keep patched.
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_BYTES = 50 * 1024 * 1024
FETCH_TIMEOUT_SECONDS = 30
MAX_REDIRECTS = 5

# Off by default. A deployment that genuinely indexes an internal wiki sets it,
# and does so knowing that any tenant who can call POST /v1/documents can then
# reach anything this container can.
ALLOW_PRIVATE = os.environ.get("NACRE_PARSER_ALLOW_PRIVATE_URLS", "").strip().lower() == "true"


class ParseError(Exception):
    """Something about the input, not about us."""


def _is_public(address: str) -> bool:
    """Whether an address is somewhere a tenant may point this service."""
    ip = ipaddress.ip_address(address)
    # `is_global` is false for loopback, link-local (169.254.169.254 — the cloud
    # metadata endpoint), private ranges, multicast, and the reserved blocks.
    # Checking one property rather than a list of CIDRs is deliberate: the list
    # is the thing that gets an entry missed, and IPv6 doubles it.
    return ip.is_global


def _check_reachable(url: str) -> None:
    """
    Refuse a URL that resolves anywhere private.

    The service fetches whatever `POST /v1/documents` was given, so without this
    an authenticated tenant can make it read the cloud metadata endpoint, the
    API next to it, or the vector store — which has no per-tenant authorization
    of its own — and get the response back as document text, indexed and
    searchable. That is an exfiltration channel with a UI.

    Every hop is checked, not only the first: a public URL that answers with a
    302 to 169.254.169.254 is the same attack with one more step.

    Not covered: DNS rebinding. This resolves, checks, and then lets urllib
    resolve again to connect, so a name that answers differently twice can still
    get through. Closing that means connecting to a validated address and
    carrying the hostname in the Host header, which breaks TLS verification —
    the trade is documented rather than made silently.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        # A file:// or gopher:// URL here would read the container's disk.
        raise ParseError("url must be http or https")

    host = parts.hostname
    if not host:
        raise ParseError("url has no host")

    if ALLOW_PRIVATE:
        return

    try:
        resolved = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror as error:
        raise ParseError("url does not resolve") from error

    for family, _type, _proto, _canon, sockaddr in resolved:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        # Every address the name answers with, not the first: a name resolving
        # to one public address and one private one is the whole trick.
        if not _is_public(sockaddr[0]):
            raise ParseError("url resolves to an address this service will not fetch")


class _GuardedRedirects(urllib.request.HTTPRedirectHandler):
    """Re-check the destination of every redirect."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        _check_reachable(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url: str) -> bytes:
    _check_reachable(url)
    opener = urllib.request.build_opener(_GuardedRedirects)
    # No cookies, no proxy handler, no auth: this service holds no credentials
    # and must not start borrowing the environment's.
    with opener.open(url, timeout=FETCH_TIMEOUT_SECONDS) as response:
        return response.read(MAX_BYTES + 1)


def parse_source(source: dict) -> dict:
    content = source.get("content")
    url = source.get("url")

    if (content is None) == (url is None):
        raise ParseError("exactly one of content or url is required")

    if content is not None:
        if not isinstance(content, str):
            raise ParseError("content must be a string")
        text = content
    else:
        if not isinstance(url, str):
            raise ParseError("url must be a string")
        try:
            raw = fetch(url)
        except urllib.error.URLError as error:
            # The reason, not the exception: a URLError's string can carry the
            # target it failed to reach, and this is the one place a caller
            # could use the failure to probe what is reachable from here.
            raise ParseError("the url could not be fetched") from error
        if len(raw) > MAX_BYTES:
            raise ParseError("document exceeds the size limit")
        text = raw.decode("utf-8", errors="replace")

    # Plain text for now. Blocks stay empty rather than fabricated: a consumer
    # that sees an empty list knows there is no structure, and one that sees a
    # single block covering everything does not.
    return {"text": text, "blocks": [], "metadata": {"bytes": len(text.encode("utf-8"))}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _reply(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._reply(200, {"status": "ok"})
        else:
            self._reply(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/parse":
            self._reply(404, {"error": "not found"})
            return

        length = int(self.headers.get("content-length") or 0)
        if length > MAX_BYTES:
            self._reply(413, {"error": "document exceeds the size limit"})
            return

        try:
            source = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._reply(400, {"error": "body is not JSON"})
            return

        try:
            self._reply(200, parse_source(source))
        except ParseError as error:
            self._reply(422, {"error": str(error)})
        except Exception:  # noqa: BLE001
            # Never the exception text: it can contain the document. This
            # process exists to handle hostile input, and the failure path is
            # part of the attack surface.
            self._reply(500, {"error": "the document could not be parsed"})

    def log_message(self, fmt: str, *args: object) -> None:
        # The default logs the request line, which for this service is the
        # closest thing to document content it sees.
        del fmt, args


def serve() -> None:
    port = int(os.environ.get("PORT", "8090"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)  # noqa: S104
    print(json.dumps({"msg": "parser listening", "port": port}), flush=True)
    server.serve_forever()
