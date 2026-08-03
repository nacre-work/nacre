# Security Policy

## What counts as a vulnerability

First and foremost, anything that breaks one of the six access-control
invariants:

1. One organization's data appears in another organization's results.
2. Post-filtering instead of pre-filtering: results stripped after ranking.
3. A permission evaluation failure grants access instead of denying it.
4. A response reveals the existence of an object the caller cannot see.
5. A deleted document is still returned.
6. `write` permission grants the ability to read.

Also: MCP authorization bypass, token forgery or replay, injection into the
vector query filter, and leakage of document contents through logs, metrics,
or error messages.

## Reporting

**Do not open a public issue.** Use
[GitHub Security Advisories](https://github.com/nacre-work/nacre/security/advisories/new)
or email security@nacre.work.

Where possible, include the version, your configuration, a minimal
reproduction, and your assessment of the impact.

## What we commit to

| Stage | Target |
|---|---|
| Acknowledgment | 3 business days |
| Initial assessment | 10 business days |
| Fix for a critical issue | 30 days from confirmation |
| Public disclosure | after the fix ships, coordinated with you |

We credit reporters in the advisory unless you'd rather we didn't. There is
no bug bounty at this time.

## Supported versions

The project is pre-1.0, so there is no "previous major" yet and any `0.x`
release may carry breaking changes. Security fixes ship for the latest `0.x`
release; a deployment on an older `0.x` upgrades forward to receive them. Once
`1.0` ships this becomes the current major and the previous one, supported for
six months after each new major is released.
