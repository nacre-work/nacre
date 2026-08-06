"""
The parser sidecar: bytes -> {text, blocks, metadata}.

Python because that is where the document-parsing libraries live, and a
separate process because this is the one component that runs untrusted input
through a large C dependency tree. It holds no credentials and reaches no
database. If it is compromised, there is nothing here to reach.

One dependency, taken deliberately: `pdf-inspector`, pinned in
requirements.txt. This service was stdlib-only until the binary-ingest work,
and the bar for adding anything here is dependency surface first — it runs
hostile input through whatever it depends on, which is why there is still no
web framework and why everything else stays standard library.

That dependency was `pypdf` and is not, and the swap is a judgement worth
stating rather than a version bump. pypdf is pure Python, which was the whole
argument for it; `pdf-inspector` is Rust behind a PyO3 binding, which is native
code on the hostile-input path and the thing this file has refused twice — it
is why `cryptography` was left out. What makes it a different question is that
the failure mode of a memory-safe parser is a panic rather than a corrupted
heap, and what makes it worth answering differently is that it closes a defect
pypdf structurally cannot: it says whether a PDF *has* a text layer.

Without that, a scanned document extracted to `""`, chunked to nothing, and was
reported `indexed` — accepted, searchable by nobody, and visible only as a
`chunk_count` of zero that nothing reads. Checked by building a one-page PDF
whose only content is an image: pypdf returns `""` and raises nothing, and this
library returns `scanned` at 0.95 confidence and names the page.

Both parsers were run against the same inputs before the swap: identical text
on a text PDF, and an explicit refusal from each on garbage and on an encrypted
document — so nothing this file relied on was given up. The three hostile shapes
the pypdf pin was about — a cyclic `/Pages` tree, a stream declaring four
gigabytes, an incomplete ASCII85 inline image — return in milliseconds rather
than hanging, which matters because a worker is strictly serial and one hang is
indexing stopped for every tenant.
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


def _decode(raw: bytes) -> str:
    """Bytes to text, or a refusal.

    This used to be ``raw.decode("utf-8", errors="replace")``, which never
    fails and is the worst possible behaviour for the input it exists to
    handle. A PDF fetched by URL came back as a string of replacement
    characters — six of them in the first fifty-eight bytes of a minimal file —
    and that string was chunked, embedded, stored as the document body and
    reported as ``indexed``. The document was not readable, the search results
    were noise, and nothing anywhere said so.

    Refusing is the honest answer because this parser extracts no binary
    formats and is not going to: it is stdlib-only on purpose, since it runs
    hostile input through whatever it depends on. A PDF needs a real extractor,
    and adding one here is a decision about this process's dependency surface
    rather than a missing branch.

    So the failure names what happened and what would fix it, and the document
    lands in ``failed`` with that reason where an operator can see it.
    """
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ParseError(
            "the document is not UTF-8 text. This parser extracts no binary "
            "formats — a PDF, a Word file or an image needs an extractor this "
            "service deliberately does not carry."
        ) from error


def parse_pdf(raw: bytes) -> dict:
    """PDF bytes to text, or a refusal that says why.

    The magic is checked here as well as at the API edge — this process must
    hold its own line, because the edge is not the only caller and a sidecar
    that trusts its callers is a sidecar whose checks live somewhere else.

    pypdf is imported lazily so a deployment that never sends a PDF never
    loads it, and a missing install fails the one request that needed it with
    a reason instead of failing the whole process at import.

    Failure text never carries the exception message: pypdf errors can quote
    the bytes they choked on, and the failure path is part of the attack
    surface. The class name says what kind of failure it was; the document
    lands in `failed` with that, where an operator can see it.
    """
    if not raw.startswith(b"%PDF-"):
        raise ParseError("the body does not start with the %PDF- magic; it is not a PDF")

    try:
        import pdf_inspector
    except ImportError as error:  # pragma: no cover - an install problem, not input
        raise ParseError(
            "the PDF extractor is not installed; the parser image is missing pdf-inspector"
        ) from error

    # Classification and extraction are two calls because they answer two
    # questions, and the first is the cheap one — the library documents it as
    # lightweight and it does no extraction. Both are needed even when text
    # comes back: a fifty-page document with forty scanned pages extracts the
    # other ten and would otherwise report success while four fifths of it is
    # missing, which is the same silent-partial defect one level down.
    try:
        found = pdf_inspector.classify_pdf_bytes(raw)
        text = pdf_inspector.extract_text_bytes(raw)
    except Exception as error:  # noqa: BLE001 - hostile input, reason class only
        raise ParseError(_pdf_failure(error)) from error

    # A PDF that declares no pages at all. It reaches here as `scanned`, which
    # would be a lie in the refusal — there is nothing to scan. Found by feeding
    # in a `/Pages` tree that points at itself.
    if found.page_count == 0:
        raise ParseError("the PDF declares no pages")

    # Nothing came out, and the classification is what turns that from a silent
    # empty document into an answer. This is the case that used to be accepted:
    # zero chunks, zero points, status `indexed`, and no search would ever
    # return it.
    if text.strip() == "":
        if found.pdf_type == "scanned":
            raise ParseError(
                "the PDF has no text layer — it is a scan, and this build does no OCR"
            )
        raise ParseError("no text could be extracted from the PDF")

    return {
        "text": text,
        "blocks": [],
        "metadata": {
            "bytes": len(raw),
            "pages": found.page_count,
            "pdf_type": found.pdf_type,
            # Empty for an ordinary document, and the point of carrying it is
            # the partial case: these pages contributed nothing, and a reader
            # who wonders why an answer is missing has somewhere to look.
            "pages_needing_ocr": list(found.pages_needing_ocr),
        },
    }


def _pdf_failure(error: Exception) -> str:
    """Our wording for a parser failure, never the parser's.

    The rule is unchanged and is why this exists: an exception message from a
    PDF library can quote the bytes it choked on, and the failure path is part
    of the attack surface. So the message is matched against — never echoed —
    and anything unrecognised falls back to the class name, which says what kind
    of failure it was without saying what was in the file.
    """
    known = {
        "encrypted": "the PDF is encrypted, and this parser holds no passwords",
        "invalid pdf": "the PDF structure could not be read",
    }
    lowered = str(error).lower()
    for marker, reason in known.items():
        if marker in lowered:
            return reason
    return f"the PDF could not be parsed ({type(error).__name__})"


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
        text = _decode(raw)

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

        # The body's declared type decides the branch. JSON carries the
        # {content|url} contract the deployed callers already speak; a PDF
        # arrives as its own raw bytes, because base64-in-JSON would carry the
        # same bytes at four-thirds the size. Anything else is refused by name
        # — new binary formats extend this dispatch, they never fall through
        # to a guess.
        declared = (self.headers.get("content-type") or "").split(";")[0].strip().lower()

        if declared == "application/pdf":
            raw = self.rfile.read(length)
            try:
                self._reply(200, parse_pdf(raw))
            except ParseError as error:
                self._reply(422, {"error": str(error)})
            except Exception:  # noqa: BLE001
                self._reply(500, {"error": "the document could not be parsed"})
            return

        if declared not in ("", "application/json"):
            self._reply(
                415,
                {"error": "unsupported content type; this parser takes application/json or application/pdf"},
            )
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
