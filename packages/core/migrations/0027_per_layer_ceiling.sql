-- 0027 — a delegation's ceiling may differ per layer.
--
-- 0025 gave a person the layers, 0026 gave them the permissions, and the screen
-- asked the two as independent questions — so what it could express was their
-- product. A person does not mean a product. They mean "read the handbook,
-- write to scratch", and until now that had to be approximated as "write", to
-- everything.
--
-- The specification is docs/authz.md, "The permission ceiling".

-- NULL means **this layer inherits the connection's ceiling**, which is what
-- every row written before this migration meant and still means. Deliberately a
-- different value from the empty array, which would be a layer the delegation
-- may do nothing in — and a layer it may do nothing in is a layer that should
-- not be in the narrowing at all. The CHECK refuses one, on the same rule 0026
-- applies to `oauth_consents.permissions` and 0025 to the narrowing itself: a
-- restriction that restricts everything is not a restriction anybody wrote.
ALTER TABLE oauth_consent_layers
  ADD COLUMN permissions text[];

ALTER TABLE oauth_consent_layers
  ADD CONSTRAINT oauth_consent_layers_permissions_shape CHECK (
    permissions IS NULL
    OR (cardinality(permissions) > 0
        AND permissions <@ ARRAY['read', 'write', 'admin']::text[])
  );

-- What this column is **not**, and the reason it needs no other constraint here.
--
-- It never widens. `oauth_consents.permissions` stays the ceiling on everything
-- the token may exercise at all, applied by the resolver before rule 3, and a
-- value here is intersected with it rather than replacing it. So a set naming a
-- permission the connection's ceiling excludes would be a control that does
-- nothing — which is why `POST /v1/oauth/consent` refuses one, naming both
-- sets, rather than storing it and letting the resolver quietly win.
--
-- That refusal is not a CHECK because it spans two tables, and a trigger to
-- enforce it would put the argument somewhere nobody reading either table would
-- look. It is in the store, with the test that proves it.
--
-- And it never confers organization-wide authority. Minting a user or a service
-- account is gated on the role and on the connection's ceiling — never on this,
-- because a permission granted *inside one layer* is not authority over the
-- organization that holds it.
