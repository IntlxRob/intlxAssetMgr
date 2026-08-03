-- Stage 3d: custom statuses.
--
-- Zendesk returns custom_status_id on every ticket, but the sync has never
-- stored it, so ~20 workflow statuses collapse into 6 base categories. That
-- loses the distinctions the SLA policy is built on:
--
--   Monitoring (open)                    -> SLA runs, agent watching
--   Resolved - Pending Confirmation      -> SLA pauses, customer verifying
--   Awaiting Third Party (hold)          -> vendor delay, excluded from team metrics
--   Awaiting Parts (hold)                -> logistics delay, tracked separately
--
-- Base status cannot tell these apart. This migration adds the column and a
-- lookup table so it can.
--
-- Safe to run more than once. Additive only.
--
--   psql "$DATABASE_URL" -f migrations/003_custom_statuses.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Lookup table, synced from Zendesk alongside orgs and groups.
-- ---------------------------------------------------------------------------
--
-- Currently /api/custom-statuses proxies live to Zendesk on every request and
-- filters out solved/closed. That is fine for a dropdown and useless for
-- reporting: a ticket cannot join to a status name that only exists in an HTTP
-- response. Persisting it also lets that endpoint stop calling Zendesk on every
-- page load.
--
-- Note: solved/closed statuses are NOT filtered here. The API endpoint excludes
-- them because an agent should not manually set them, but historical tickets
-- reference them and reporting needs the labels.

CREATE TABLE IF NOT EXISTS custom_statuses (
  id               BIGINT PRIMARY KEY,
  agent_label      TEXT NOT NULL,
  end_user_label   TEXT,
  status_category  TEXT NOT NULL,
  active           BOOLEAN NOT NULL DEFAULT true,
  is_default       BOOLEAN NOT NULL DEFAULT false,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_custom_statuses_category
  ON custom_statuses (status_category);

-- ---------------------------------------------------------------------------
-- 2. The ticket column.
-- ---------------------------------------------------------------------------
--
-- No foreign key: tickets sync independently of statuses, and a ticket
-- referencing a status that has not synced yet should not fail the whole batch.
-- Joins use LEFT JOIN and tolerate a miss.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS custom_status_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_tickets_custom_status
  ON tickets (custom_status_id);

-- ---------------------------------------------------------------------------
-- 3. SLA behaviour per status category.
-- ---------------------------------------------------------------------------
--
-- From the Zendesk Status & SLA Workflow Guide v3.0, section 4:
--
--   new      Requester Wait Time RUNNING   ball: intlx
--   open     Requester Wait Time RUNNING   ball: intlx
--   pending  Requester Wait Time PAUSED    ball: customer
--   hold     Requester Wait Time RUNNING   ball: vendor, tracked separately
--   solved   Requester Wait Time STOPPED
--   closed   Requester Wait Time STOPPED
--
-- Stored as data rather than hardcoded in queries so the policy can change
-- without a code deploy.

CREATE TABLE IF NOT EXISTS sla_category_behaviour (
  status_category    TEXT PRIMARY KEY,
  wait_time_running  BOOLEAN NOT NULL,
  ball_with          TEXT NOT NULL,
  counts_against_team BOOLEAN NOT NULL,
  note               TEXT
);

INSERT INTO sla_category_behaviour (status_category, wait_time_running, ball_with, counts_against_team, note)
VALUES
  ('new',     true,  'intlx',    true,  'Untouched, clock running'),
  ('open',    true,  'intlx',    true,  'intlx working'),
  ('pending', false, 'customer', false, 'Waiting on customer, wait time pauses'),
  ('hold',    true,  'vendor',   false, 'Third party blocking; on-hold time subtracted from team metrics'),
  ('solved',  false, 'none',     false, 'Complete'),
  ('closed',  false, 'none',     false, 'Complete')
ON CONFLICT (status_category) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Published SLA targets, per the Global intlx 24x7 SLA Policy.
-- ---------------------------------------------------------------------------
--
-- Section 2 of the workflow guide. Priorities map to Zendesk defaults:
--   P1-Critical = urgent, P2-Urgent = high, P3-Important = normal, P4-Minor = low
--
-- Resolution targets for P3/P4 are published in BUSINESS days. Stored here in
-- business minutes (8h day) and must be compared against the .business variant
-- of the Zendesk metric, not calendar time.
--
-- Escalation and communication objective are recorded for completeness; only
-- response and resolution are measured today. Periodic Update enforcement
-- would need ticket event history, which is not currently synced.

CREATE TABLE IF NOT EXISTS sla_targets (
  priority                TEXT PRIMARY KEY,
  label                   TEXT NOT NULL,
  response_minutes        INTEGER NOT NULL,
  resolution_minutes      INTEGER NOT NULL,
  escalation_minutes      INTEGER,
  comm_objective_minutes  INTEGER,
  resolution_is_business  BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO sla_targets (priority, label, response_minutes, resolution_minutes, escalation_minutes, comm_objective_minutes, resolution_is_business)
VALUES
  ('urgent', 'P1-Critical',   15,   240,   60,   30,  false),
  ('high',   'P2-Urgent',     30,   480,  120,   60,  false),
  ('normal', 'P3-Important',  60,  1440, 1440, 1440,  true),
  ('low',    'P4-Minor',    1440,  2400, 4320, 2880,  true)
ON CONFLICT (priority) DO NOTHING;

-- P3 resolution: 1-3 business days, stored as the 3-day ceiling (3 x 8h = 1440
-- business minutes). P4: 5 business days = 2400 business minutes.
-- Tickets with NULL priority (58 of them today) fall back to 'normal' in the
-- view below rather than silently taking the loosest target.

-- ---------------------------------------------------------------------------
-- 5. SLA evaluation view.
-- ---------------------------------------------------------------------------
--
-- Two independent measurements rather than one blended figure, because when a
-- single number moves you cannot tell which half caused it.
--
-- Response  : first reply vs target. Never pauses (workflow guide section 3).
-- Resolution: full resolution MINUS on-hold time vs target. The guide is
--             explicit that agents are not penalised for third-party delays:
--             "Adjusted Requester Wait Time = Requester Wait Time - On-hold Time"
--
-- Only 553 of 114k tickets have on-hold time, so this barely moves the
-- aggregate, but for those tickets it averages ~4 days and is decisive.

CREATE OR REPLACE VIEW tickets_sla AS
SELECT
  t.id,
  t.status,
  t.priority,
  t.organization_id,
  t.created_at,
  cs.agent_label      AS custom_status_label,
  cs.status_category,
  b.ball_with,
  b.wait_time_running,
  tg.label            AS priority_label,
  tg.response_minutes AS response_target,
  tg.resolution_minutes AS resolution_target,

  t.first_reply_minutes,
  t.resolution_minutes AS resolution_raw_minutes,
  COALESCE(t.on_hold_time_minutes, 0) AS on_hold_minutes,
  GREATEST(t.resolution_minutes - COALESCE(t.on_hold_time_minutes, 0), 0)
                      AS resolution_adjusted_minutes,

  CASE
    WHEN t.first_reply_minutes IS NULL THEN NULL
    WHEN t.first_reply_minutes <= tg.response_minutes THEN true
    ELSE false
  END AS response_met,

  CASE
    WHEN t.resolution_minutes IS NULL THEN NULL
    -- On-hold exceeding total resolution time is not physically meaningful;
    -- Zendesk measures the two independently and they can disagree. Treat it
    -- as unmeasurable rather than granting a free pass via GREATEST(..,0).
    WHEN COALESCE(t.on_hold_time_minutes, 0) >= t.resolution_minutes THEN NULL
    WHEN t.resolution_minutes - COALESCE(t.on_hold_time_minutes, 0)
         <= tg.resolution_minutes THEN true
    ELSE false
  END AS resolution_met

FROM tickets t
LEFT JOIN custom_statuses cs ON cs.id = t.custom_status_id
LEFT JOIN sla_category_behaviour b ON b.status_category = COALESCE(cs.status_category, t.status)
LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority, 'normal');

COMMIT;
