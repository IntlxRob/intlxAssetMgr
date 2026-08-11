-- Stage 4g: the curated "where can we improve" list.
--
-- Wording lives here rather than in code because the framing is most of the
-- value - "resolution is 76%" invites a defence, "setting Awaiting 3rd Party
-- stops the clock" gives someone something to do. Editing an item is an
-- UPDATE, not a deploy.
--
-- metric_key must match a case in GET /api/analytics/ops/improvements. The
-- numbers are code; only the words are data.
--
--   psql "$DATABASE_URL" -f migrations/006_ops_improvements.sql

BEGIN;

CREATE TABLE IF NOT EXISTS ops_improvements (
  key           TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  -- What the fix would move. Separate from body so it can be dropped once the
  -- team knows it, without rewriting the explanation.
  impact        TEXT,
  metric_key    TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'medium',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ops_improvements (key,title,body,impact,metric_key,severity,sort_order) VALUES ('on_hold_unused','On-hold statuses are going unused','Tickets that ran past target with no on-hold time recorded. When we are waiting on a vendor or a customer, setting Awaiting 3rd Party stops the clock - so resolution compliance reflects our work rather than someone else''s delay.','Would move resolution compliance from 76% toward the 96% Zendesk reports.','on_hold_unused','medium',1) ON CONFLICT (key) DO NOTHING;
INSERT INTO ops_improvements (key,title,body,impact,metric_key,severity,sort_order) VALUES ('update_slipping','Customer updates are slipping','A ten-point slide over the year, with no single break point. Some open tickets are past their update target right now - and a number of those have a recent internal note, so someone is working them and the customer just has not been told.','The tickets with a recent internal note are the quickest win on the board.','update_compliance','high',2) ON CONFLICT (key) DO NOTHING;
INSERT INTO ops_improvements (key,title,body,impact,metric_key,severity,sort_order) VALUES ('p1_alerting','P1 response is an alerting gap, not an effort gap','Half of all P1s get a reply well inside the 15-minute target. The misses are a small tail - which points at alerts nobody saw rather than anyone working too slowly.','Worth checking overnight and weekend alert routing.','p1_response','low',3) ON CONFLICT (key) DO NOTHING;

COMMIT;
