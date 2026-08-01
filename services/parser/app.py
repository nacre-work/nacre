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

import json
import os
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BYTES = 50 * 1024 * 1024
FETCH_TIMEOUT_SECONDS = 30


class ParseError(Exception):
    """Something about the input, not about us."""


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
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            # A file:// or gopher:// URL here would read the container's disk.
            # The allowlist is the check; urllib will happily do the rest.
            raise ParseError("url must be http or https")
        with urllib.request.urlopen(url, timeout=FETCH_TIMEOUT_SECONDS) as response:  # noqa: S310
            raw = response.read(MAX_BYTES + 1)
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
