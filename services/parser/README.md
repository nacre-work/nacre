# parser

A Python sidecar. One of two — `services/embedding_adapter` is the other.

The contract is deliberately narrow so the component stays replaceable:

```
POST /parse   bytes + content-type  →  { text, blocks[], metadata }
```

**Two dependencies, `pdf-inspector` and `anydoc`, pinned exactly.** This
process runs attacker-supplied bytes through whatever it depends on, so each
extractor is chosen for dependency surface before anything else;
`services/parser/requirements.txt` argues both choices at length, including
why the pure-Python parser the first replaced was given up and why PDF does
not go through the second. The formats it reads are the rows of `FORMATS` in
`app.py`, held against the core's `packages/core/formats.ts` by its own suite.
Nothing about either leaks outward, and if a good enough TypeScript
equivalent shows up this service gets swapped wholesale with no changes
anywhere else.
