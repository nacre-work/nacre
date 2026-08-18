-- An account that more than one person holds is not a person.
--
-- The product's whole argument for `/v1/me` is that a second factor is a thing
-- the *person* holds — which is why an administrator can reset a password and
-- deliberately cannot touch a factor. A published demo login breaks that
-- premise: several strangers hold one credential, so "the person" is not a
-- thing, and the first of them to enrol a factor locks out every other one
-- permanently, with no administrative route back.
--
-- Until 0.19.0 a deployment had an accidental switch: with no `NACRE_2FA_KEY`
-- the whole surface answered 404. WebAuthn needs no key, so that switch is
-- gone — correctly, because it was installation-wide and the property is not.
-- An installation may have one shared account and a hundred people.
--
-- So it is a column on the row it is about. A shared account:
--   * cannot enrol or remove a second factor,
--   * cannot change its own password,
--   * is issued no password-reset token.
-- An administrator still sets its password through `POST /v1/users/{id}/password`,
-- which is how whoever publishes such a credential rotates it. The account's
-- credentials are *administered* rather than held, which is the whole of what
-- this column says.
--
-- `false` for every existing row, so nothing changes for any account that
-- belongs to somebody.
ALTER TABLE users ADD COLUMN shared boolean NOT NULL DEFAULT false;

-- A shared account has no factor, and this is the structural half rather than
-- a second copy of the route check.
--
-- The routes refuse first and answer 404, which is what a caller sees. This is
-- what holds when a route is added later and forgets: an INSERT is refused by
-- the database whichever surface issued it, so the worst a forgotten check can
-- produce is a 500 rather than a locked-out demonstration. A check constraint
-- cannot do it — the fact lives in another table — so it is a trigger.
CREATE OR REPLACE FUNCTION refuse_factor_on_shared_account() RETURNS trigger
LANGUAGE plpgsql
-- The function reads `users`, which is FORCE'd, so it runs as the owner and
-- pins its search path — the same shape every SECURITY DEFINER here follows.
SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users
     WHERE id = NEW.user_id AND org_id = NEW.org_id AND shared
  ) THEN
    RAISE EXCEPTION 'a shared account cannot hold a second factor'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_second_factors_not_shared
  BEFORE INSERT ON user_second_factors
  FOR EACH ROW EXECUTE FUNCTION refuse_factor_on_shared_account();
