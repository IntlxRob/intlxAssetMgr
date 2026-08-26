-- 012: drop two columns from sla_targets.
--
-- resolution_is_business said `true` for normal and low. The Zendesk SLA
-- policy sets business_hours: false on all sixteen targets, so it was wrong as
-- well as unused - one SELECT list, never a comparison. Per-priority
-- business/calendar behaviour is configured in Zendesk, not here.
--
-- update_interval_minutes duplicated comm_objective_minutes exactly. 004 added
-- it and backfilled it from comm_objective_minutes, so the latter is the
-- original - and it is the language the agent-facing status reference uses.

ALTER TABLE sla_targets DROP COLUMN IF EXISTS resolution_is_business;
ALTER TABLE sla_targets DROP COLUMN IF EXISTS update_interval_minutes;
