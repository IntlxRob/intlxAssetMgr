-- Stage 3a: derived fields the UI filters on.
--
-- Scope is deliberately narrow. Six columns backing two of the eight filters
-- in applyFilters(), all of them pure per-ticket computations with no open
-- semantic questions.
--
-- Deliberately NOT included:
--   sla_status      - the browser computes 76.5% compliance while
--                     analytics_daily reports 99.2%. Two definitions are in
--                     play and one of them is on a dashboard people trust.
--                     Freezing either into a column before that is settled
--                     would make the wrong one official.
--   visualize_tier  - reads organizations.organization_fields.active_subscriptions,
--                     which the org sync has never written. Also has a
--                     precedence bug (bare 'basic' matched before 'premium',
--                     so "Basic Support, Visualize Premium" resolves to basic)
--                     and two same-named functions where hoisting decides the
--                     winner. Needs a sync change and two decisions first.
--
-- Safe to run more than once. Additive only.
--
--   psql "$DATABASE_URL" -f migrations/002_derived_fields.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Request type
-- ---------------------------------------------------------------------------
-- Custom field 22563831352855 when set (and not '-'), else derived from tags
-- as alarm_virsae / alarm_alarmtraq / alarm_checkmk in that precedence.
--
-- Named _derived to sit alongside the existing request_type column rather than
-- colliding with it. 17 distinct values across 114k tickets.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS request_type_derived TEXT;

-- ---------------------------------------------------------------------------
-- 2. Alarm source flags
-- ---------------------------------------------------------------------------
-- Three independent booleans rather than one enum: the UI filter tests each
-- source separately (exclude-alarmtraq, exclude-virsae, exclude-checkmk) and
-- a ticket can carry more than one tag.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS has_alarmtraq BOOLEAN;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS has_virsae    BOOLEAN;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS has_checkmk   BOOLEAN;

-- ---------------------------------------------------------------------------
-- 3. Timing, in minutes
-- ---------------------------------------------------------------------------
-- metric_set first (already minutes), falling back to custom fields
-- 35345064770327 / 35345460512663 which are in SECONDS.
--
-- These are distinct from the existing first_resolution_time_minutes /
-- full_resolution_time_minutes columns, which come straight from metric_set
-- during sync. The derived versions include the custom-field fallback and the
-- business-or-calendar behaviour the UI has always used, so they are what the
-- SLA card actually reads.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_reply_minutes INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_minutes  INTEGER;

-- Audit trail, matching the billing columns.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS derived_computed_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------
-- Sized to the measured distributions rather than added uniformly.

-- 17 distinct values, queried by equality. Plain btree.
CREATE INDEX IF NOT EXISTS idx_tickets_request_type_derived
  ON tickets (request_type_derived);

-- alarmtraq is on 82.4% of tickets, so an index on true is nearly the whole
-- table and not worth having. The filter that matters is "exclude alarmtraq",
-- which selects the 17.6% that are false.
CREATE INDEX IF NOT EXISTS idx_tickets_not_alarmtraq
  ON tickets (id) WHERE has_alarmtraq = false;

-- virsae 6.6% and checkmk 0.03% are both selective enough for partial indexes
-- on true.
CREATE INDEX IF NOT EXISTS idx_tickets_virsae
  ON tickets (id) WHERE has_virsae = true;

CREATE INDEX IF NOT EXISTS idx_tickets_checkmk
  ON tickets (id) WHERE has_checkmk = true;

-- Finds rows the backfill has not reached.
CREATE INDEX IF NOT EXISTS idx_tickets_derived_pending
  ON tickets (id) WHERE derived_computed_at IS NULL;

COMMIT;
