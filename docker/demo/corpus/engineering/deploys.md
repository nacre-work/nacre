# Deploys

Merges to main deploy themselves. There is no button and no deploy window.

A rollout stops if `/v1/ready` refuses, and it refuses while the database schema
is behind the image — a pod started against a database the migrator has not
reached would otherwise report ready and then fail every request. A schema that
is *ahead* stays ready, which is the middle of any rolling upgrade.

Roll back by deploying the previous tag. Do not roll back the database:
migrations are forward-only, and every one of them is written so the previous
image keeps working against the new schema.

Environment variables live in the secret store. `NACRE_S3_ENDPOINT` and
`NACRE_JWT_PRIVATE_KEY_REF` are the two people get wrong most often — the first
because it needs a scheme, the second because it is a file reference and not the
key.
