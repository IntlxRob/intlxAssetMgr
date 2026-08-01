-- Stage 1: make the database the billing source of truth.
--
-- Safe to run more than once. Adds only; drops nothing; changes no existing
-- values. Run inside a transaction so a partial apply cannot happen.
--
--   psql "$DATABASE_URL" -f migrations/001_billing_columns.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Columns that routes/analytics.js already reads but nothing ever wrote.
-- ---------------------------------------------------------------------------

-- Whether the ticket is billable, resolved from the Zendesk custom field at
-- sync time. NULL means "not yet computed" and is deliberately distinct from
-- FALSE ("computed, and not billable") so the backfill can find unprocessed
-- rows and so partial backfills are visible rather than silent.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_billable BOOLEAN;

-- ACTUAL tracked minutes. Never rounded.
--
-- Rounding is a billing *policy*, not a fact about the ticket, and policies
-- change (the 30 -> 15 question). Storing rounded values would bake today's
-- policy into history and make re-running an old report produce numbers that
-- disagree with the invoice already sent. Rounding is applied at query time
-- from billing_policies below.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS billable_time_minutes INTEGER;

-- Denormalised display names. Populated set-based after each sync (see
-- refreshDenormalisedNames in services/billing.js) rather than per-row, since
-- the ticket payload does not carry them.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assignee_name TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS organization_name TEXT;

-- Audit trail: which field ID and logic version produced is_billable. Without
-- this, a change in field resolution is undetectable after the fact.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS billing_computed_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS billing_field_id BIGINT;

-- ---------------------------------------------------------------------------
-- 2. Indexes for the analytics queries that are about to go live.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_tickets_billable
  ON tickets (is_billable) WHERE is_billable = true;

CREATE INDEX IF NOT EXISTS idx_tickets_org_created
  ON tickets (organization_id, created_at);

CREATE INDEX IF NOT EXISTS idx_tickets_billing_pending
  ON tickets (id) WHERE is_billable IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Rounding policy as effective-dated configuration.
-- ---------------------------------------------------------------------------
--
-- organization_id NULL = the default policy for orgs with no specific terms.
-- Rows are never updated in place; a change is a new row with a later
-- effective_from. That way a report over a past period can reproduce the
-- policy that was actually in force, and a rate change cannot silently rewrite
-- an invoice you already sent.

CREATE TABLE IF NOT EXISTS billing_policies (
  id                  BIGSERIAL PRIMARY KEY,
  organization_id     BIGINT,
  rounding_increment  INTEGER NOT NULL DEFAULT 30,
  minimum_minutes     INTEGER NOT NULL DEFAULT 0,
  hourly_rate         NUMERIC(10,2),
  effective_from      DATE    NOT NULL,
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_policies_increment_positive CHECK (rounding_increment > 0),
  CONSTRAINT billing_policies_minimum_sane       CHECK (minimum_minutes >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_policies_unique
  ON billing_policies (COALESCE(organization_id, -1), effective_from);

-- Seed the current behaviour so nothing changes on deploy: ceil to 30, no
-- minimum, backdated far enough to cover all history.
INSERT INTO billing_policies (organization_id, rounding_increment, minimum_minutes, effective_from, note)
SELECT NULL, 30, 0, DATE '2000-01-01', 'Legacy default carried over from iframe.html getRoundedTime()'
WHERE NOT EXISTS (
  SELECT 1 FROM billing_policies WHERE organization_id IS NULL
);

-- ---------------------------------------------------------------------------
-- 4. Resolve the policy in force for a ticket, then apply it.
-- ---------------------------------------------------------------------------
--
-- Org-specific policy wins over the default; among candidates the latest
-- effective_from not after the reference date wins.

CREATE OR REPLACE FUNCTION billing_policy_for(p_org_id BIGINT, p_on DATE)
RETURNS billing_policies AS $$
  SELECT *
    FROM billing_policies
   WHERE effective_from <= p_on
     AND (organization_id = p_org_id OR organization_id IS NULL)
   ORDER BY (organization_id IS NOT NULL) DESC, effective_from DESC
   LIMIT 1;
$$ LANGUAGE sql STABLE;

-- Mirrors iframe.html getRoundedTime exactly — ceil to the increment — with an
-- added minimum floor that the legacy code did not have. minimum_minutes
-- defaults to 0, so seeded behaviour is byte-identical to today.
CREATE OR REPLACE FUNCTION apply_rounding(p_minutes INTEGER, p_increment INTEGER, p_minimum INTEGER)
RETURNS INTEGER AS $$
  SELECT CASE
    WHEN p_minutes IS NULL OR p_minutes <= 0 THEN 0
    ELSE GREATEST(CEIL(p_minutes::numeric / p_increment)::integer * p_increment, p_minimum)
  END;
$$ LANGUAGE sql IMMUTABLE;

-- Convenience view: every ticket with its billed minutes under the policy that
-- was in force on its creation date. This is what the analytics endpoints
-- should read instead of computing rounding themselves.
CREATE OR REPLACE VIEW tickets_billed AS
SELECT
  t.*,
  p.rounding_increment,
  p.minimum_minutes,
  p.hourly_rate,
  CASE WHEN t.is_billable
       THEN apply_rounding(t.billable_time_minutes, p.rounding_increment, p.minimum_minutes)
       ELSE 0
  END AS billed_minutes
FROM tickets t
LEFT JOIN LATERAL billing_policy_for(t.organization_id, t.created_at::date) p ON TRUE;

COMMIT;
