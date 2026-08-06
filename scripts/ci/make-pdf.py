#!/usr/bin/env python3
"""Write a real, valid, one-page PDF: text by default, a scan with --scan.

The end-to-end smoke needs an actual PDF — one the extractor will open and pull
text from — and generating it here keeps a binary fixture out of the repository.
Hand-built rather than produced by a library for the same reason the parser
sidecar is stdlib-only: this script is CI's, and a dependency it needed would
have to be installed on the runner before the stack could be tested.

The xref offsets are computed, not guessed. A PDF with a wrong xref is exactly
the sort of almost-valid input a test must not accidentally come to depend on,
and pypdf's recovery for one would mean the smoke was proving something other
than what it says.

`--scan` writes the other case: one page whose only content is an image, with
no text operators anywhere. That is a document the extractor can read perfectly
and still find nothing in, which is what makes it worth having — it used to be
accepted, chunked to nothing and reported `indexed`, and the smoke now asserts
it lands in `failed` instead.

    make-pdf.py <path> <text>
    make-pdf.py <path> --scan
"""

import sys
import zlib


def _assemble(objects: list[bytes]) -> bytes:
    """The xref and trailer, computed rather than guessed.

    A PDF with a wrong xref is exactly the sort of almost-valid input a test
    must not accidentally come to depend on: an extractor's recovery for one
    would mean the smoke was proving something other than what it says.
    """
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_at}\n%%EOF\n"
    ).encode()
    return bytes(out)


def minimal_pdf(text: str) -> bytes:
    stream = f"BT /F1 12 Tf 72 712 Td ({text}) Tj ET".encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    return _assemble(objects)


def scanned_pdf() -> bytes:
    """One page whose only content is an image: a scan, with no text layer.

    Deliberately not "a PDF with the text removed" — the point is a document
    that is structurally valid and legible to a person, where the extractor has
    nothing to find because there is nothing there to find.
    """
    pixels = zlib.compress(bytes(8 * 8))
    stream = b"q 200 0 0 200 0 0 cm /Im0 Do Q"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
        b"/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray "
        b"/BitsPerComponent 8 /Filter /FlateDecode /Length "
        + str(len(pixels)).encode()
        + b" >>\nstream\n"
        + pixels
        + b"\nendstream",
    ]
    return _assemble(objects)


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[2] == "--scan":
        with open(sys.argv[1], "wb") as handle:
            handle.write(scanned_pdf())
        return 0

    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2

    path, text = sys.argv[1], sys.argv[2]
    # Parentheses and backslashes are the PDF string escapes, and a text
    # argument carrying one would produce a file that is not the document the
    # caller asked for. Refused rather than escaped: the smoke picks its own
    # phrase, and a silent difference between what was written and what was
    # searched for is the failure this whole test exists to catch.
    if any(c in text for c in "()\\"):
        print("the text may not contain a parenthesis or a backslash", file=sys.stderr)
        return 2

    with open(path, "wb") as handle:
        handle.write(minimal_pdf(text))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
