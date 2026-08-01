# parser

A Python sidecar — the only Python in the project.

The contract is deliberately narrow so the component stays replaceable:

```
POST /parse   bytes + content-type  →  { text, blocks[], metadata }
```

Internally it uses PyMuPDF, docling, and unstructured. None of that leaks
outward. If a good enough TypeScript equivalent shows up, this service gets
swapped wholesale with no changes anywhere else.
