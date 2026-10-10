"""
The parser sidecar: bytes -> {text, blocks, metadata}.

Python because that is where the document-parsing libraries live, and a
separate process because this is the one component that runs untrusted input
through a large C dependency tree. It holds no credentials and reaches no
database. If it is compromised, there is nothing here to reach.

Two dependencies, each taken deliberately and pinned in requirements.txt:
`pdf-inspector` reads PDF, and `anydoc` — the same publisher's converter —
reads the Office and OpenDocument formats, RTF and EPUB. This service was
stdlib-only until the binary-ingest work, and the bar for adding anything here
is dependency surface first — it runs hostile input through whatever it
depends on, which is why there is still no web framework and why everything
else stays standard library.

PDF stays on `pdf-inspector` although `anydoc` carries a PDF path of its own,
and that was measured rather than assumed: over the three hostile shapes in
requirements.txt, `anydoc` calls two of them scans — a stream declaring four
gigabytes and a truncated inline image both come back as "needs OCR", which
is the wrong thing to tell an operator about a broken file — it refuses a
document whose pages are *partly* scanned rather than extracting the rest,
and it reports no page count on success. Each of those is a property this
sidecar's PDF contract already promises. So the extractor is chosen per
format, and `anydoc` is always told the format rather than left to sniff it.

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

import http.client
import ipaddress
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_BYTES = 50 * 1024 * 1024
FETCH_TIMEOUT_SECONDS = 30
MAX_REDIRECTS = 5

# The whole fetch, not one read. `FETCH_TIMEOUT_SECONDS` bounds each socket
# operation, so a server sending a byte every twenty-nine seconds kept a fetch —
# and the thread and buffer under it — open for as long as it liked. The page is
# read in chunks against this deadline; past it, the fetch is refused.
FETCH_DEADLINE_SECONDS = 60

# How many documents are parsed at once. Every request holds a thread and up to
# MAX_BYTES of body, and `ThreadingHTTPServer` takes as many as arrive — so the
# bound on this process's memory was however many requests somebody sent. Past
# it a request waits up to SLOT_WAIT_SECONDS and is then answered `503`, which
# the worker reads as `unavailable` and retries later rather than failing the
# document.
PARSE_SLOTS = 8
SLOT_WAIT_SECONDS = 30
_SLOTS = threading.BoundedSemaphore(PARSE_SLOTS)

# Off by default. A deployment that genuinely indexes an internal wiki sets it,
# and does so knowing that any tenant who can call POST /v1/documents can then
# reach anything this container can.
ALLOW_PRIVATE = os.environ.get("NACRE_PARSER_ALLOW_PRIVATE_URLS", "").strip().lower() == "true"


class ParseError(Exception):
    """Something about the input, not about us."""


# The binary formats this sidecar reads: declared media type -> (the format
# named to the extractor, the signature the bytes must begin with). This is the
# Python copy of `packages/core/formats.ts`, and `test_app.py` holds the two
# against each other — an entry here that the edge does not admit is dead code,
# and an entry there that this table lacks is a document queued and failed.
#
# Only the ZIP-based families and RTF beside PDF. The legacy OLE formats
# (`.doc`, `.xls`, `.ppt`) are deliberately absent: the extractor does not
# sniff their signature and nothing here has watched one convert.
_ZIP = b"PK\x03\x04"
FORMATS: dict[str, tuple[str, bytes]] = {
    "application/pdf": ("pdf", b"%PDF-"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ("docx", _ZIP),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ("pptx", _ZIP),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ("xlsx", _ZIP),
    "application/vnd.oasis.opendocument.text": ("odt", _ZIP),
    "application/vnd.oasis.opendocument.presentation": ("odp", _ZIP),
    "application/vnd.oasis.opendocument.spreadsheet": ("ods", _ZIP),
    "application/epub+zip": ("epub", _ZIP),
    "application/rtf": ("rtf", b"{\\rtf"),
}
# A second spelling a client may send for the same format, as the edge admits it.
FORMAT_ALIASES = {"text/rtf": "application/rtf"}


def _is_public(address: str) -> bool:
    """Whether an address is somewhere a tenant may point this service."""
    ip = ipaddress.ip_address(address)
    # `is_global` is false for loopback, link-local (169.254.169.254 — the cloud
    # metadata endpoint), private ranges, multicast, and the reserved blocks.
    # Checking one property rather than a list of CIDRs is deliberate: the list
    # is the thing that gets an entry missed, and IPv6 doubles it.
    return ip.is_global


def _public_addresses(host: str, port: int) -> list[tuple]:
    """
    Every address `host` resolves to, if all of them are public.

    Every answer and not the first: a name resolving to one public address and
    one private one is the whole trick, and picking the public one would leave
    which address a connection uses to the order a resolver returns them in.
    """
    try:
        resolved = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise ParseError("url does not resolve") from error

    usable = [r for r in resolved if r[0] in (socket.AF_INET, socket.AF_INET6)]
    if not usable:
        raise ParseError("url does not resolve")
    for _family, _type, _proto, _canon, sockaddr in usable:
        if not _is_public(sockaddr[0]):
            raise ParseError("url resolves to an address this service will not fetch")
    return usable


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

    This is the early, readable refusal. It is not the guarantee: it resolves,
    and the connection would resolve again, so a name that answers one way to
    this and another to the socket — DNS rebinding — gets past a check that
    stands alone. The guarantee is `_guarded_connection`, which the socket
    itself goes through.
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

    _public_addresses(host, parts.port or (443 if parts.scheme == "https" else 80))


def _guarded_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None, **_kw):  # noqa: ANN001, ANN201
    """
    `socket.create_connection`, connecting only to an address it has judged.

    The name is resolved once, every answer is checked, and the socket connects
    to one of those answers by address — so there is no second resolution for a
    rebinding to land in. TLS is unaffected: `HTTPSConnection` wraps the socket
    with `server_hostname` set to the name, so the certificate is still
    verified against the host the URL named, not against an address. This file
    used to say that closing rebinding "breaks TLS verification"; it does not,
    because the name the handshake presents and the address the socket dials
    are two separate arguments.
    """
    host, port = address[0], address[1]
    last: OSError | None = None
    for _family, _type, _proto, _canon, sockaddr in _public_addresses(host, port):
        try:
            return socket.create_connection((sockaddr[0], port), timeout, source_address)
        except OSError as error:
            last = error
    assert last is not None
    raise last


class _GuardedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
        super().__init__(*args, **kwargs)
        self._create_connection = _guarded_connection


class _GuardedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
        super().__init__(*args, **kwargs)
        self._create_connection = _guarded_connection


class _GuardedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):  # noqa: ANN001, ANN201
        return self.do_open(_GuardedHTTPConnection, req)


class _GuardedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):  # noqa: ANN001, ANN201
        return self.do_open(_GuardedHTTPSConnection, req, context=self._context)


class _GuardedRedirects(urllib.request.HTTPRedirectHandler):
    """Re-check the destination of every redirect."""

    max_redirections = MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        _check_reachable(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _opener() -> urllib.request.OpenerDirector:
    handlers: list = [_GuardedRedirects, urllib.request.ProxyHandler({})]
    # The escape hatch keeps urllib's own connections, since it exists to reach
    # private addresses; everywhere else the socket goes through the guard.
    if not ALLOW_PRIVATE:
        handlers += [_GuardedHTTPHandler, _GuardedHTTPSHandler]
    return urllib.request.build_opener(*handlers)


def fetch(url: str) -> bytes:
    _check_reachable(url)
    # No cookies, no auth, and no proxy — `ProxyHandler({})` rather than the
    # default, which reads the environment's proxy variables: this service holds
    # no credentials and must not start borrowing the environment's, and a proxy
    # would be the one host the guard never sees.
    deadline = time.monotonic() + FETCH_DEADLINE_SECONDS
    with _opener().open(url, timeout=FETCH_TIMEOUT_SECONDS) as response:
        chunks: list[bytes] = []
        size = 0
        while size <= MAX_BYTES:
            if time.monotonic() > deadline:
                raise ParseError(
                    f"the page took longer than {FETCH_DEADLINE_SECONDS} seconds to arrive and was not fetched",
                )
            # `read1`, not `read`: `read(n)` waits for n bytes or the end, so a
            # server dripping a byte at a time held one call open as long as it
            # liked and the deadline was never consulted. `read1` returns what
            # one receive delivered, and each one is bounded by the socket
            # timeout, so this ends within the deadline plus one of those.
            chunk = response.read1(min(64 * 1024, MAX_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        return b"".join(chunks)


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


def parse_document(raw: bytes, declared: str) -> dict:
    """Bytes of a declared binary format to text, or a refusal that says why.

    The signature is checked here as well as at the API edge, for the reason
    `parse_pdf` gives: this process holds its own line. The format is *named*
    to the extractor and never sniffed — a `.docx` declaration over an `.odt`
    archive is refused by the parts the extractor then fails to find, which is
    the second half of "both signals must agree", enforced where the archive is
    actually opened.

    `ocr="reject"` is passed explicitly although it is the default: the
    extractor's other mode sends the document to a hosted service, and this
    sidecar reaches nothing — the `airgapped` profile rests on that, so it is
    pinned here and asked by a test rather than inherited from a default that
    a release of the library could move.

    Failure text never carries the exception message. The extractor's errors
    quote what they choked on — a part name, a decoder's complaint — and the
    failure path is part of the attack surface; the class says what kind of
    failure it was, and `limit` names one of the extractor's fixed limits
    rather than anything out of the file.
    """
    entry = FORMATS.get(FORMAT_ALIASES.get(declared, declared))
    if entry is None:
        raise ParseError("unsupported content type")
    fmt, signature = entry
    if not raw.startswith(signature):
        raise ParseError(f"the body does not start with the signature of a {fmt}; it is not one")
    if fmt == "pdf":
        return parse_pdf(raw)

    try:
        import anydoc
    except ImportError as error:  # pragma: no cover - an install problem, not input
        raise ParseError(
            "the document extractor is not installed; the parser image is missing anydoc"
        ) from error

    try:
        text = anydoc.to_markdown_bytes(raw, format=fmt, ocr="reject")
    except anydoc.EncryptedError as error:
        raise ParseError(f"the {fmt} is encrypted, and this parser holds no passwords") from error
    except anydoc.ResourceLimitError as error:
        limit = getattr(error, "limit", None)
        raise ParseError(
            f"the {fmt} crossed the extractor's {limit} limit" if limit else f"the {fmt} crossed an extractor limit"
        ) from error
    except anydoc.ConvertError as error:
        # MissingPartError and MalformedError — the archive is not the format
        # it was declared as, or is broken. One sentence for both, because the
        # part name the extractor quotes is exactly what must not travel.
        raise ParseError(f"the {fmt} could not be read ({type(error).__name__})") from error
    except Exception as error:  # noqa: BLE001 - hostile input, reason class only
        raise ParseError(f"the {fmt} could not be parsed ({type(error).__name__})") from error

    if text.strip() == "":
        raise ParseError(f"no text could be extracted from the {fmt}")

    return {"text": text, "blocks": [], "metadata": {"bytes": len(raw), "format": fmt}}


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
        # 1.25 refuses a page-less document in `classify_pdf_bytes` where 0.2
        # classified it as a scan with zero pages; the same refusal either way.
        "no readable pages": "the PDF declares no pages",
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
        # Before the body is read, so a request waiting for a slot holds a
        # socket and nothing of the document.
        if not _SLOTS.acquire(timeout=SLOT_WAIT_SECONDS):
            self._reply(503, {"error": "the parser is busy; try again"})
            return
        try:
            self._parse()
        finally:
            _SLOTS.release()

    def _parse(self) -> None:

        length = int(self.headers.get("content-length") or 0)
        if length > MAX_BYTES:
            self._reply(413, {"error": "document exceeds the size limit"})
            return

        # The body's declared type decides the branch. JSON carries the
        # {content|url} contract the deployed callers already speak; a binary
        # document arrives as its own raw bytes under its real type, because
        # base64-in-JSON would carry the same bytes at four-thirds the size.
        # Anything else is refused by name — a new binary format is a row in
        # FORMATS, and nothing falls through to a guess.
        declared = (self.headers.get("content-type") or "").split(";")[0].strip().lower()

        if FORMAT_ALIASES.get(declared, declared) in FORMATS:
            raw = self.rfile.read(length)
            try:
                self._reply(200, parse_document(raw, declared))
            except ParseError as error:
                self._reply(422, {"error": str(error)})
            except Exception:  # noqa: BLE001
                self._reply(500, {"error": "the document could not be parsed"})
            return

        if declared not in ("", "application/json"):
            self._reply(
                415,
                {
                    "error": "unsupported content type; this parser takes application/json or one of: "
                    + ", ".join(sorted(FORMATS))
                },
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
