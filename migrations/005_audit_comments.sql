-- Stage 3z: public comment history from the audit stream.
--
-- /api/v2/ticket_audits.json is a single cursor-paged stream covering every
-- ticket, and unlike incremental/ticket_events it carries the `public` flag —
-- the one field the update metric depends on.
--
-- One row per comment rather than a per-ticket summary: a trend needs to know
-- when each update happened, not only the most recent one. That is what makes
-- "was update compliance better in Q1" answerable.
--
--   psql "$DATABASE_URL" -f migrations/005_audit_comments.sql

BEGIN;

CREATE TABLE IF NOT EXISTS ticket_public_comments (
  audit_id    BIGINT PRIMARY KEY,
  ticket_id   BIGINT NOT NULL,
  author_id   BIGINT,
  is_public   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ticket plus time is the access pattern: "the gaps between updates on this
-- ticket, in order". Partial index on public because the metric only counts
-- comments the customer could see.
CREATE INDEX IF NOT EXISTS idx_public_comments_ticket
  ON ticket_public_comments (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_public_comments_public
  ON ticket_public_comments (ticket_id, created_at) WHERE is_public;
CREATE INDEX IF NOT EXISTS idx_public_comments_created
  ON ticket_public_comments (created_at);

-- Cursor storage. The audit stream is cursor-paged rather than timestamped, so
-- resuming needs the opaque token rather than a date.
CREATE TABLE IF NOT EXISTS sync_cursors (
  name       TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
