-- Stage 3v: update intervals on open tickets.
--
-- Zendesk's Periodic Update metric measures the gap between public agent
-- comments. The public/private flag is only on /tickets/{id}/comments.json —
-- one call per ticket — so this is scoped to open tickets, which is where the
-- question matters anyway. A ticket that went quiet in March and has since
-- closed cannot be recovered without a nine-day backfill.
--
-- Two timestamps because there are two questions:
--   last_public_agent_at — when the customer was last told anything
--   last_agent_at        — whether anyone is working it, internal notes included
--
--   psql "$DATABASE_URL" -f migrations/004_comment_summary.sql

BEGIN;

CREATE TABLE IF NOT EXISTS ticket_comment_summary (
  ticket_id                  BIGINT PRIMARY KEY,
  comment_count              INTEGER NOT NULL DEFAULT 0,
  agent_comment_count        INTEGER NOT NULL DEFAULT 0,
  public_agent_comment_count INTEGER NOT NULL DEFAULT 0,
  last_public_agent_at       TIMESTAMPTZ,
  last_agent_at              TIMESTAMPTZ,
  synced_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comment_summary_public
  ON ticket_comment_summary (last_public_agent_at);
CREATE INDEX IF NOT EXISTS idx_comment_summary_agent
  ON ticket_comment_summary (last_agent_at);

-- Update targets per priority, from section 2 of the workflow guide. These sit
-- alongside sla_targets rather than in it because comm_objective_minutes there
-- describes the same policy but nothing has ever read it — keeping the update
-- rule separate makes it clear which one this metric uses.
ALTER TABLE sla_targets
  ADD COLUMN IF NOT EXISTS update_interval_minutes INTEGER;

UPDATE sla_targets SET update_interval_minutes = comm_objective_minutes
 WHERE update_interval_minutes IS NULL;

COMMIT;
