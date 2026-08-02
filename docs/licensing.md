# Licensing

## This repository

Apache 2.0. `LICENSE` holds the full text, `NOTICE` the attribution required by
section 4(d) — keep both when you redistribute.

Apache 2.0 covers the data model, ingest, chunking, embeddings, hybrid search,
reranking, the MCP server, the REST API, basic RBAC, single-organization
deployment, email and password authentication, and the Docker Compose
distribution.

## What is not here

The commercial modules live in a separate private repository under a separate
license and are not distributed with this one:

multi-tenancy and collection isolation · SSO (OIDC/SAML) and SCIM ·
document-level ACLs with deny rules · Enterprise-Managed Authorization and
ID-JAG · audit log and SIEM export · global admin · quotas · HA Helm charts.

The line between the two is one question: **does a security team pay for it, or
a developer?** If a single developer on a laptop needs it, it belongs here. The
`boundary` job in CI enforces the mechanical half of that rule — this repository
must build and test with no access to the private one.

## Contributions

**A CLA, not a DCO** — [CLA.md](../CLA.md), enforced by the `cla` job.
Contributors keep their copyright; the agreement adds a sublicence right on top
of the Apache 2.0 grant.

That right is the reason it is a CLA. Nothing in the plan above needs it: the
core stays Apache 2.0 and the money is in the private repository, which the
core's licence does not touch. It is there for the one move that cannot be made
retroactively — changing the core's licence, the usual trigger being someone
reselling it as a managed service. Under a DCO that decision needs permission
from every past contributor whose code is still in the tree; every company that
has actually made the move had a CLA, which is why they could.

It costs something real. Some people will not sign, and the drive-by fixes they
would have sent do not arrive. That is the trade being made deliberately.

Already-released versions are unaffected in any scenario: the Apache 2.0 grant
is irrevocable, so a licence change reaches future releases only.

## Third-party components

Nacre ships as a set of containers and does not link any of these into its own
binaries — each runs as a separate service over a network protocol. Their
licenses still matter, because a buyer's legal review reads the whole
`docker-compose.yml`, not just ours.

| Component | License | Notes |
|---|---|---|
| PostgreSQL | PostgreSQL License | permissive, no constraints |
| Qdrant | Apache 2.0 | permissive, no constraints |
| Redis | RSALv2 / SSPLv1 / AGPLv3, your choice | tri-licensed since Redis 8; pick RSALv2 where AGPL is stop-listed |
| MinIO | AGPLv3 | **optional, off by default** |

**MinIO is the one that needs a deliberate answer.** It is AGPLv3 and it is a
storage server, which is exactly the shape of dependency a regulated buyer's
policy flags. This is why `NACRE_S3_ENDPOINT` points at an external
S3-compatible endpoint by default and MinIO appears only in the `full` Compose
profile. Keep it that way: an AGPL component on the default path turns a
five-minute legal review into a six-week one.

Redis is the same question with an easier answer — the tri-license means a
buyer who cannot accept AGPLv3 simply selects RSALv2 instead. Do not describe
Redis as AGPL-only.

Dependency licenses for the JavaScript tree: `pnpm licenses list`.
