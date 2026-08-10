# parser

A Python sidecar. One of two — `services/embedding_adapter` is the other.

The contract is deliberately narrow so the component stays replaceable:

```
POST /parse   bytes + content-type  →  { text, blocks[], metadata }
```

**One dependency, `pdf-inspector`, pinned exactly.** This process runs
attacker-supplied bytes through whatever it depends on, so the extractor is
chosen for dependency surface before anything else; `services/parser/requirements.txt`
argues the choice at length, including why the pure-Python parser it replaced
was given up. Nothing about it leaks outward, and if a good enough TypeScript
equivalent shows up this service gets swapped wholesale with no changes
anywhere else.
