-- 016: carry the three derived custom-field columns through tickets_billed.
--
-- /tickets/paginated selects from this view, so ast_type, starling_location and
-- starling_department were invisible to the app until it carried them.
--
-- 001 created this view with SELECT t.*, which Postgres expands to an explicit
-- column list at creation time. So the star never tracked new columns and every
-- future derived column needs a migration like this one.
--
-- Appended at the end rather than beside request_type_derived: CREATE OR
-- REPLACE VIEW can only add columns, not insert them. Order is cosmetic since
-- both queries name their columns.

BEGIN;

CREATE OR REPLACE VIEW tickets_billed AS
SELECT t.id,
    t.organization_id,
    t.organization_name,
    t.subject,
    t.description,
    t.status,
    t.priority,
    t.severity,
    t.request_type,
    t.assignee_id,
    t.assignee_name,
    t.requester_id,
    t.requester_name,
    t.group_id,
    t.group_name,
    t.created_at,
    t.updated_at,
    t.solved_at,
    t.closed_at,
    t.due_at,
    t.tags,
    t.custom_fields,
    t.is_billable,
    t.billable_time_minutes,
    t.synced_at,
    t.entity_type,
    t.entity_id,
    t.metric_set,
    t.reply_count,
    t.comment_count,
    t.reopens,
    t.first_resolution_time_minutes,
    t.full_resolution_time_minutes,
    t.agent_wait_time_minutes,
    t.requester_wait_time_minutes,
    t.on_hold_time_minutes,
    t.billing_computed_at,
    t.billing_field_id,
    t.request_type_derived,
    t.has_alarmtraq,
    t.has_virsae,
    t.has_checkmk,
    t.first_reply_minutes,
    t.resolution_minutes,
    t.derived_computed_at,
    t.custom_status_id,
    p.rounding_increment,
    p.minimum_minutes,
    p.hourly_rate,
        CASE
            WHEN t.is_billable THEN apply_rounding(t.billable_time_minutes, p.rounding_increment, p.minimum_minutes)
            ELSE 0
        END AS billed_minutes,
    t.ast_type,
    t.starling_location,
    t.starling_department
   FROM tickets t
     LEFT JOIN LATERAL billing_policy_for(t.organization_id, t.created_at::date) p(id, organization_id, rounding_increment, minimum_minutes, hourly_rate, effective_from, note, created_at) ON true;;

COMMIT;
