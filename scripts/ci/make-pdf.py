#!/usr/bin/env python3
"""Write a real, valid, one-page PDF carrying a line of text.

The end-to-end smoke needs an actual PDF — one pypdf will open and extract
from — and generating it here keeps a binary fixture out of the repository.
Hand-built rather than produced by a library for the same reason the parser
sidecar is stdlib-only: this script is CI's, and a dependency it needed would
have to be installed on the runner before the stack could be tested.

The xref offsets are computed, not guessed. A PDF with a wrong xref is exactly
the sort of almost-valid input a test must not accidentally come to depend on,
and pypdf's recovery for one would mean the smoke was proving something other
than what it says.

    make-pdf.py <path> <text>
"""

import sys


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


def main() -> int:
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
