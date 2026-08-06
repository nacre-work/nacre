# Backing up, and restoring

There is no backup command. This page is the procedure, and it is written out
rather than automated because the pieces are `pg_dump` and your object store's
own client, and wrapping two standard tools would mostly hide which one failed.

Read the first section before writing a script. The **order** is the part that
is not obvious, and getting it wrong produces a backup that restores without an
error and is missing document bodies.

## What holds state

Three stores, and only two of them are backed up.

| | | |
|---|---|---|
| **PostgreSQL** | organizations, users, groups, grants, layers, document rows, the audit log, OAuth connections | **back it up** |
| **Object storage** | document bytes, where `NACRE_S3_*` is configured | **back it up** |
| **Qdrant** | vectors | **derived — do not** |

Qdrant is left out on purpose and it is the one that surprises people. Every
vector can be recomputed: `organizations.vector_collection` names the
collection, each layer names its slot and its provider, and the document bodies
are in Postgres or in the bucket. Backing it up means storing a large derived
artifact that can go stale against the thing it was derived from, and a stale
vector store is worse than an absent one, because an absent one is rebuilt and a
stale one answers.

If object storage is **not** configured — which is the default, and the whole
`minimal` profile — then document bytes live in `documents.source_ref` and
Postgres is the only thing to back up.

## Taking a backup

**Postgres first, then the bucket.** Not the other way round, and the reason is
in the ingest path: a document's bytes are written to the bucket *before* its
row is written to Postgres. So a dump taken first can only ever reference
objects that already exist, and the bucket copy that follows will include them.

Reverse the order and you get rows whose objects were never captured —
documents that restore into a database that says they exist, fail when
something reads them, and are not noticed until somebody opens one.

```bash
# 1. The database. Custom format, so a restore can be parallel and selective.
pg_dump --format=custom --file=nacre.dump "$NACRE_PG_URL"

# 2. The roles, which pg_dump does not include and a restore needs.
pg_dumpall --roles-only --file=roles.sql "$NACRE_PG_URL"

# 3. The bucket, after the dump. Any client; this is the AWS CLI.
aws s3 sync "s3://$NACRE_S3_BUCKET" ./objects --endpoint-url "$NACRE_S3_ENDPOINT"
```

`pg_dumpall --roles-only` is the step people leave out. `nacre_app`,
`nacre_worker` and the owning role are cluster-level objects, not database
objects, so a `pg_dump` restored into a fresh cluster fails on the first
`GRANT ... TO nacre_app`. Restoring into the *same* cluster does not need it,
which is exactly why it goes missing — the rehearsal that mattered was the one
nobody did.

The dump does not have to be taken with the stack stopped. Postgres gives it a
consistent snapshot, and a document ingested during the dump is either fully in
it or not in it at all.

### The dump is the most sensitive artifact this product produces

It contains password hashes, refresh-token hashes, service-account key hashes,
every OAuth connection, and the complete audit log — one file that describes who
may read what and what they have read. Encrypt it at rest, and do not put the
key beside it. Treat losing the backup as a breach, not as an inconvenience.

## Restoring

Postgres, then the bucket, then Qdrant. That chain is one-way: Qdrant can be
rebuilt from Postgres, and Postgres cannot be rebuilt from anything.

```bash
# 1. Roles, if the cluster is a new one.
psql --file=roles.sql "$ADMIN_PG_URL"

# 2. The database, as the owning role.
pg_restore --dbname="$NACRE_PG_URL_OWNER" --clean --if-exists nacre.dump

# 3. The bucket, if the deployment has one.
aws s3 sync ./objects "s3://$NACRE_S3_BUCKET" --endpoint-url "$NACRE_S3_ENDPOINT"

# 4. Qdrant, per organization. Recreates the collection and requeues every
#    live document; the worker does the embedding.
node packages/api/dist/rebuild-collection.js --org acme
```

Restore as the **owning** role, not as `nacre_app`. The dump carries table
ownership, row-level security policies and grants, and `nacre_app` cannot create
a table — the same split the migrator needs, arriving from the other side.

Step 4 runs once per organization. Until it finishes, search returns nothing for
that organization while everything else — sign-in, layers, grants, the audit log
— already works, because only the vectors were missing.

Documents that were mid-flight when the dump was taken come back as `queued` or
`parsing`. The worker's lease reclaims a `parsing` document after
`NACRE_INDEX_LEASE` and it is picked up again; nothing needs doing by hand.

### Check the restore, do not assume it

A backup nobody has restored is a belief. The cheapest real check, on a scratch
deployment rather than on production:

```bash
# The schema matches the image — this is what /v1/ready refuses on.
curl -fsS localhost:8080/v1/ready

# Sign in as an administrator who existed before the backup.
# Then, per organization, a search that used to return something:
curl -fsS -X POST localhost:8080/v1/search \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query":"something you know is indexed","top_k":5}'
```

An empty result after step 4 has finished means the rebuild did not finish or
the embedding provider is misconfigured — not that the backup was bad.

## Restoring into a different installation

It works, with two consequences worth knowing before rather than after.

**Every issued token stops verifying**, because the new installation signs with
different keys. That is correct: a token is bound to the installation that
minted it. People sign in again and applications go back through consent.

**`NACRE_CANONICAL_URL` and the OAuth client registrations** point at the old
host. Registered clients are in the dump and their redirect URIs are theirs, not
yours; connections made against the old host are ended by the token change
anyway.

If the object storage endpoint changes, nothing in the database needs editing:
`documents.source_ref` holds a key, not a URL.

## What this page does not cover

Scheduling, encryption key management, and verifying that a backup restores are
deliberately not here. They are the parts an organization with a retention
policy needs, and they are what the commercial `admin-global` module adds. The
procedure above is complete without them, and a deployment that runs it on a
timer and checks the result has a working backup.
