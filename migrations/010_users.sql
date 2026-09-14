-- End users, for requester names. Agents live in their own table and are
-- synced separately; this is everyone, because Zendesk's /users.json does not
-- usefully separate them and the overlap costs nothing at four thousand rows.

CREATE TABLE IF NOT EXISTS users (
  id               BIGINT PRIMARY KEY,
  name             TEXT,
  email            TEXT,
  role             TEXT,
  organization_id  BIGINT,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users (organization_id);
