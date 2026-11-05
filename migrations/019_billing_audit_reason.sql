-- 019_billing_audit_reason.sql
--
-- Why a ticket was charged what it was charged.
--
-- ---------------------------------------------------------------------------
-- Optional, and a small vocabulary rather than free text
-- ---------------------------------------------------------------------------
--
-- The reasons are already a fixed set — October's sample shows it. Of 33
-- adjusted tickets: 16 capped at 15 under the programming-change agreement, 9
-- written off entirely as break-fix or maintenance, 8 judgement calls. Plus 39
-- billed in full.
--
-- So the UI's three decision buttons write a fixed string and the free-text box
-- is for the residual. That keeps the common case to one click while stopping
-- the column drifting into "not billable" / "n/b" / "covered" / "contract"
-- across three months and two people.
--
--   'Covered by contract'   break-fix and maintenance, charge 0
--   'Capped per agreement'  the cap value
--   'Billed in full'        the rounded figure
--   anything else           typed, for the handful that need it
--
-- NULL is allowed and ordinary: a reason is not required. What makes the report
-- defensible is that the reductions usually carry one, not that every row does.
--
-- Deliberately text rather than an enum or a lookup table. The vocabulary will
-- change as agreements change, and a migration per phrase is a worse trade than
-- occasional inconsistency in a column nothing joins on.

ALTER TABLE ticket_billing_audit ADD COLUMN IF NOT EXISTS reason text;

COMMENT ON COLUMN ticket_billing_audit.reason IS
    'Why this charge. Written by the audit UI as one of a small fixed set - '
    '"Covered by contract", "Capped per agreement", "Billed in full" - or free '
    'text for a judgement call. Optional. See claude/billing-audit.md.';
