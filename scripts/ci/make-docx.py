#!/usr/bin/env python3
"""Write a real, minimal Word document carrying one paragraph of text.

The end-to-end smoke needs an actual `.docx` — an archive the extractor opens
and finds `word/document.xml` in — and generating it here keeps a binary
fixture out of the repository, the way `make-pdf.py` does for PDF. Standard
library only, for the same reason: this script is CI's, and a dependency it
needed would have to be installed on the runner before the stack could be
tested.

Three parts and nothing else: the content types, the package relationship
that points at the main part, and the main part with one run of text. That
is the least a reader needs, which is what makes it the right fixture — a
document a word processor produced carries styles, settings and theme parts
that would prove the extractor tolerates them, not that it reads the text.

Usage: make-docx.py OUT.docx "the text"
"""

import sys
import zipfile
from xml.sax.saxutils import escape

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)
RELS = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    "</Relationships>"
)


def document(text: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body><w:p><w:r><w:t>{escape(text)}</w:t></w:r></w:p></w:body></w:document>"
    )


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: make-docx.py OUT.docx TEXT")
    out, text = sys.argv[1], sys.argv[2]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", RELS)
        archive.writestr("word/document.xml", document(text))


if __name__ == "__main__":
    main()
