-- 010: exclude untouched alarms from SLA compliance.
--
-- Fixing the calendar/business duration bug made resolution_minutes 0 rather
-- than NULL for 6,327 tickets that really did resolve instantly. Correct data,
-- but NULL had been doing double duty as both "no measurement" and "excluded
-- from compliance", so those rows would have entered the denominator as
-- automatic passes. 3,075 of them are merged duplicates and 6,102 are alarms.
--
-- The rule already exists as HANDLED in routes/analytics.js: a human ticket
-- always counts; an alarm counts only if nobody cleared or merged it away.
-- Nobody touched those, so their response times belong to the platform. The
-- scorecard already filtered them; anything reading this view directly did not.
--
-- Built from pg_get_viewdef rather than from 003, which is stale: the live view
-- has a CASE around status_category for closed/deleted that 003 lacks.

BEGIN;

CREATE OR REPLACE VIEW tickets_sla AS
SELECT t.id,
    t.status,
    t.priority,
    t.organization_id,
    t.created_at,
    cs.agent_label AS custom_status_label,
        CASE
            WHEN t.status::text = ANY (ARRAY['closed'::character varying, 'deleted'::character varying]::text[]) THEN t.status::text
            ELSE COALESCE(cs.status_category, t.status::text)
        END AS status_category,
    b.ball_with,
    b.wait_time_running,
    tg.label AS priority_label,
    tg.response_minutes AS response_target,
    tg.resolution_minutes AS resolution_target,
    t.first_reply_minutes,
    t.resolution_minutes AS resolution_raw_minutes,
    COALESCE(t.on_hold_time_minutes, 0) AS on_hold_minutes,
    GREATEST(t.resolution_minutes - COALESCE(t.on_hold_time_minutes, 0), 0) AS resolution_adjusted_minutes,
        CASE
            WHEN (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                 AND (t.tags @> '["alarm_cleared"]'::jsonb
                   OR t.tags @> '["merged_duplicate"]'::jsonb
                   OR t.tags @> '["closed_by_merge"]'::jsonb) THEN NULL::boolean
            WHEN t.first_reply_minutes IS NULL THEN NULL::boolean
            WHEN t.first_reply_minutes <= tg.response_minutes THEN true
            ELSE false
        END AS response_met,
        CASE
            WHEN (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                 AND (t.tags @> '["alarm_cleared"]'::jsonb
                   OR t.tags @> '["merged_duplicate"]'::jsonb
                   OR t.tags @> '["closed_by_merge"]'::jsonb) THEN NULL::boolean
            WHEN t.resolution_minutes IS NULL THEN NULL::boolean
            WHEN COALESCE(t.on_hold_time_minutes, 0) >= t.resolution_minutes THEN NULL::boolean
            WHEN (t.resolution_minutes - COALESCE(t.on_hold_time_minutes, 0)) <= tg.resolution_minutes THEN true
            ELSE false
        END AS resolution_met
   FROM tickets t
     LEFT JOIN custom_statuses cs ON cs.id = t.custom_status_id
     LEFT JOIN sla_category_behaviour b ON b.status_category =
        CASE
            WHEN t.status::text = ANY (ARRAY['closed'::character varying, 'deleted'::character varying]::text[]) THEN t.status::text
            ELSE COALESCE(cs.status_category, t.status::text)
        END
     LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority, 'normal'::character varying)::text;;

COMMIT;
