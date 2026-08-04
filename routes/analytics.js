// routes/analytics.js - Analytics API Routes
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { cacheMiddleware, clearCache, getCacheStats } = require('../middleware/cache');

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Build WHERE clause from query filters
 */
function buildWhereClause(filters = {}, options = {}) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    // Determine which date field to use
    const dateField = filters.dateFilterType === 'solved' ? 't.updated_at' : 't.created_at';

    // Date range filter
    if (filters.startDate) {
        conditions.push(`${dateField} >= $${paramIndex++}`);
        params.push(filters.startDate);
    }
    if (filters.endDate) {
        conditions.push(`${dateField} <= $${paramIndex++}`);
        params.push(filters.endDate);
    }

    // For solved date filter, only include solved/closed tickets
    if (filters.dateFilterType === 'solved') {
        conditions.push(`t.status IN ('solved', 'closed')`);
    }

    // Organization filter
    if (filters.organizationId) {
        conditions.push(`t.organization_id = $${paramIndex++}`);
        params.push(filters.organizationId);
    }

    // Status filter.
    // The UI status control is a multi-select, so this accepts either a single
    // value (?status=open) or a list (?status=open&status=pending, or
    // ?status=open,pending). A single value still behaves exactly as before.
    if (filters.status) {
        const statuses = Array.isArray(filters.status)
            ? filters.status
            : String(filters.status).split(',').map(s => s.trim()).filter(Boolean);

        if (statuses.length === 1) {
            conditions.push(`t.status = $${paramIndex++}`);
            params.push(statuses[0]);
        } else if (statuses.length > 1) {
            conditions.push(`t.status = ANY($${paramIndex++})`);
            params.push(statuses);
        }
    }

    // Priority filter
    if (filters.priority) {
        conditions.push(`t.priority = $${paramIndex++}`);
        params.push(filters.priority);
    }

    // Group filter
    if (filters.groupId) {
        conditions.push(`t.group_id = $${paramIndex++}`);
        params.push(filters.groupId);
    }

    // Assignee filter
    if (filters.assigneeId) {
        conditions.push(`t.assignee_id = $${paramIndex++}`);
        params.push(filters.assigneeId);
    }

    // Assignee by name, for the UI's assignee dropdown which sends names
    // rather than ids. 'Unassigned' matches a missing assignee.
    if (filters.assigneeName) {
        if (filters.assigneeName === 'Unassigned') {
            conditions.push(`(t.assignee_id IS NULL OR t.assignee_name IS NULL)`);
        } else {
            conditions.push(`t.assignee_name = $${paramIndex++}`);
            params.push(filters.assigneeName);
        }
    }

    // Billable filter.
    // Accepts a real boolean, or the strings the UI dropdown sends
    // ('billable' / 'non-billable' / 'true' / 'false').
    if (filters.billable !== undefined && filters.billable !== '') {
        const v = filters.billable;
        const isTrue = v === true || v === 'true' || v === 'billable';
        const isFalse = v === false || v === 'false' || v === 'non-billable';
        if (isTrue || isFalse) {
            conditions.push(`t.is_billable = $${paramIndex++}`);
            params.push(isTrue);
        }
    }

    // Request type. 'not_set' means no type was derived, matching the UI
    // option of the same name.
    if (filters.requestType) {
        if (filters.requestType === 'not_set') {
            conditions.push(`t.request_type_derived IS NULL`);
        } else {
            conditions.push(`t.request_type_derived = $${paramIndex++}`);
            params.push(filters.requestType);
        }
    }

    // Alarm source. Vocabulary matches the UI dropdown exactly.
    // 'include-all' is the default and adds no condition.
    if (filters.alarmFilter && filters.alarmFilter !== 'include-all') {
        switch (filters.alarmFilter) {
            case 'exclude-all':
                conditions.push(`(t.has_alarmtraq = false AND t.has_virsae = false AND t.has_checkmk = false)`);
                break;
            case 'exclude-alarmtraq':
                conditions.push(`t.has_alarmtraq = false`);
                break;
            case 'exclude-virsae':
                conditions.push(`t.has_virsae = false`);
                break;
            case 'exclude-checkmk':
                conditions.push(`t.has_checkmk = false`);
                break;
            case 'only-alarms':
                conditions.push(`(t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)`);
                break;
        }
    }

    // Minimum tracked time, given in HOURS by the UI, stored in minutes.
    if (filters.minTime) {
        const hours = parseFloat(filters.minTime);
        if (!isNaN(hours) && hours > 0) {
            conditions.push(`COALESCE(t.billable_time_minutes, 0) >= $${paramIndex++}`);
            params.push(Math.round(hours * 60));
        }
    }

    // Ticket number, partial match. The UI strips a leading '#'.
    if (filters.ticketNumber) {
        const clean = String(filters.ticketNumber).replace('#', '').trim();
        if (clean) {
            conditions.push(`t.id::text LIKE $${paramIndex++}`);
            params.push('%' + clean + '%');
        }
    }

    // SLA status is NOT filtered here. The browser computes 76.5% compliance
    // while analytics_daily reports 99.2%, so there are two definitions in play
    // and neither should be frozen into a query until that is settled.

    // When the caller already has a WHERE clause of its own, it needs these
    // conditions as an appendable AND fragment instead.
    const whereClause = conditions.length === 0
        ? ''
        : options.asFragment
            ? 'AND ' + conditions.join(' AND ')
            : 'WHERE ' + conditions.join(' AND ');

    return { whereClause, params, dateField };
}

// ============================================================================
// HEALTH & STATUS ENDPOINTS
// ============================================================================

/**
 * GET /api/analytics/health
 * Check analytics system health
 */
router.get('/health', async (req, res) => {
    try {
        const dbCheck = await query('SELECT NOW() as time');
        const cacheStats = await getCacheStats();
        
        res.json({
            status: 'ok',
            database: 'connected',
            cache: cacheStats.available ? 'connected' : 'unavailable',
            timestamp: dbCheck.rows[0].time
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * GET /api/analytics/sync-status
 * Get sync status for all entity types
 */
router.get('/sync-status', cacheMiddleware(60), async (req, res) => {
    try {
        const result = await query(`
            SELECT 
                entity_type,
                last_sync_at,
                status,
                records_synced,
                duration_seconds,
                error_message
            FROM sync_status
            WHERE id IN (
                SELECT MAX(id)
                FROM sync_status
                GROUP BY entity_type
            )
            ORDER BY last_sync_at DESC
        `);

        res.json({
            syncStatus: result.rows,
            lastUpdate: new Date()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// TICKET ANALYTICS ENDPOINTS
// ============================================================================

/**
 * GET /api/analytics/tickets/summary
 * Get ticket summary statistics
 */
router.get('/tickets/summary', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters);

        const result = await query(`
            SELECT 
                COUNT(*) as total_tickets,
                COUNT(CASE WHEN status = 'new' THEN 1 END) as new_tickets,
                COUNT(CASE WHEN status = 'open' THEN 1 END) as open_tickets,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_tickets,
                COUNT(CASE WHEN status = 'solved' THEN 1 END) as solved_tickets,
                COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed_tickets,
                COUNT(CASE WHEN is_billable THEN 1 END) as billable_tickets,
                SUM(billable_time_minutes) / 60.0 as total_billable_hours
            FROM tickets t
            ${whereClause}
        `, params);

        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/tickets/by-organization
 * Get ticket counts grouped by organization
 */
router.get('/tickets/by-organization', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters);

        const result = await query(`
            SELECT 
                t.organization_id,
                t.organization_name,
                COUNT(*) as ticket_count,
                COUNT(CASE WHEN t.status IN ('solved', 'closed') THEN 1 END) as solved_count,
                COUNT(CASE WHEN t.is_billable THEN 1 END) as billable_count,
                SUM(t.billable_time_minutes) / 60.0 as billable_hours,
                AVG(tm.first_reply_time_minutes) as avg_first_reply_minutes,
                AVG(tm.full_resolution_time_minutes) as avg_resolution_minutes
            FROM tickets t
            LEFT JOIN ticket_metrics tm ON t.id = tm.ticket_id
            ${whereClause}
            GROUP BY t.organization_id, t.organization_name
            ORDER BY ticket_count DESC
            LIMIT 100
        `, params);

        res.json({
            organizations: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/tickets/by-status
 * Get ticket counts by status over time
 */
router.get('/tickets/by-status', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters);

        const result = await query(`
            SELECT 
                DATE(created_at) as date,
                status,
                COUNT(*) as count
            FROM tickets t
            ${whereClause}
            GROUP BY DATE(created_at), status
            ORDER BY date DESC, status
            LIMIT 1000
        `, params);

        res.json({
            data: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/tickets/trends
 * Get ticket volume trends over time
 */
router.get('/tickets/trends', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const groupBy = req.query.groupBy || 'day'; // day, week, month
        const { whereClause, params } = buildWhereClause(filters);

        let dateGrouping;
        switch (groupBy) {
            case 'week':
                dateGrouping = "DATE_TRUNC('week', created_at)";
                break;
            case 'month':
                dateGrouping = "DATE_TRUNC('month', created_at)";
                break;
            default:
                dateGrouping = "DATE(created_at)";
        }

        const result = await query(`
            SELECT 
                ${dateGrouping} as period,
                COUNT(*) as tickets_created,
                COUNT(CASE WHEN solved_at IS NOT NULL THEN 1 END) as tickets_solved,
                COUNT(CASE WHEN is_billable THEN 1 END) as billable_tickets
            FROM tickets t
            ${whereClause}
            GROUP BY period
            ORDER BY period DESC
            LIMIT 365
        `, params);

        res.json({
            data: result.rows,
            groupBy: groupBy
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/agents/performance
 *
 * Per-agent breakdown with human and alarm work separated. Automation accounts
 * are excluded — see /agents/automation for those.
 *
 * SLA percentages cover HUMAN tickets only. Applying a 15-minute response
 * target to auto-cleared alarms would make every agent look excellent and
 * measure nothing.
 */
router.get('/agents/performance', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters, { asFragment: true });

        const result = await query(`
            WITH scoped AS (
                SELECT
                    -- Explicit rather than s.*: tickets_sla predates the
                    -- billing columns, so a wildcard here silently shadowed
                    -- t.is_billable and t.billed_minutes with nothing.
                    s.status,
                    s.first_reply_minutes,
                    s.resolution_adjusted_minutes,
                    s.response_met,
                    s.resolution_met,
                    t.assignee_id,
                    t.assignee_name,
                    t.billable_time_minutes,
                    t.billed_minutes,
                    t.is_billable,
                    (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk) AS is_alarm
                FROM tickets_sla s
                JOIN tickets_billed t ON t.id = s.id
                WHERE t.assignee_id IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM automation_accounts a WHERE a.agent_id = t.assignee_id
                  )
                  ${whereClause}
            )
            SELECT
                assignee_id,
                assignee_name,

                COUNT(*)::int AS total_tickets,
                COUNT(*) FILTER (WHERE NOT is_alarm)::int AS human_tickets,
                COUNT(*) FILTER (WHERE is_alarm)::int AS alarm_tickets,
                COUNT(*) FILTER (WHERE status IN ('solved','closed'))::int AS solved_tickets,

                COUNT(*) FILTER (WHERE is_billable)::int AS billable_tickets,
                ROUND((SUM(billable_time_minutes) / 60.0)::numeric, 1) AS actual_hours,
                ROUND((SUM(billed_minutes) / 60.0)::numeric, 1) AS billed_hours,

                -- Hours per HUMAN ticket. Including alarms would flatten this
                -- toward zero and hide the difference between deep work and
                -- high-volume triage.
                ROUND((SUM(billable_time_minutes) FILTER (WHERE NOT is_alarm)
                       / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm), 0) / 60.0)::numeric, 2)
                    AS avg_hours_per_human_ticket,

                ROUND(AVG(first_reply_minutes) FILTER (WHERE NOT is_alarm)) AS avg_first_reply_minutes,
                ROUND(AVG(resolution_adjusted_minutes) FILTER (WHERE NOT is_alarm)) AS avg_resolution_minutes,

                ROUND(100.0 * COUNT(*) FILTER (WHERE NOT is_alarm AND response_met)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND response_met IS NOT NULL), 0), 1)
                    AS response_compliance,
                ROUND(100.0 * COUNT(*) FILTER (WHERE NOT is_alarm AND resolution_met)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND resolution_met IS NOT NULL), 0), 1)
                    AS resolution_compliance

            FROM scoped
            GROUP BY assignee_id, assignee_name
            ORDER BY SUM(billable_time_minutes) DESC NULLS LAST
            LIMIT 100
        `, params);

        res.json({
            agents: result.rows,
            count: result.rows.length,
            note: 'Automation accounts excluded. SLA figures cover human-originated tickets only.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/agents/automation
 *
 * Throughput for accounts registered in automation_accounts. Volume and
 * resolution rate only — SLA and hours-per-ticket are not meaningful for a
 * process that opens and closes its own tickets.
 */
router.get('/agents/automation', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters, { asFragment: true });

        const result = await query(`
            SELECT
                a.agent_id,
                a.label,
                t.assignee_name,
                COUNT(t.id)::int AS tickets,
                COUNT(*) FILTER (WHERE t.status IN ('solved','closed'))::int AS resolved,
                ROUND(100.0 * COUNT(*) FILTER (WHERE t.status IN ('solved','closed'))
                      / NULLIF(COUNT(t.id), 0), 1) AS resolved_pct,
                ROUND((SUM(t.billable_time_minutes) / 60.0)::numeric, 1) AS hours,
                ROUND(AVG(t.resolution_minutes)) AS avg_resolution_minutes
            FROM automation_accounts a
            JOIN tickets t ON t.assignee_id = a.agent_id
            WHERE 1=1
            ${whereClause}
            GROUP BY a.agent_id, a.label, t.assignee_name
            ORDER BY tickets DESC
        `, params);

        res.json({ accounts: result.rows, count: result.rows.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// SLA & METRICS ENDPOINTS
// ============================================================================

/**
 * GET /api/analytics/sla/compliance
 *
 * Response and resolution compliance against the published intlx 24x7 SLA
 * policy, measured via the tickets_sla view (targets in sla_targets, on-hold
 * time subtracted per policy).
 *
 * Always split by source: alarm-generated tickets are ~89% of volume and
 * behave completely differently from customer-reported ones.
 *
 * Optional ?source=alarm|human narrows to one; omitting it returns both.
 */
router.get('/sla/compliance', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters, { asFragment: true });

        const result = await query(`
            SELECT
                CASE WHEN t.has_alarmtraq OR t.has_virsae OR t.has_checkmk
                     THEN 'alarm' ELSE 'human' END AS source,
                s.priority_label,
                s.response_target,
                s.resolution_target,
                COUNT(*)::int AS tickets,

                COUNT(*) FILTER (WHERE s.response_met IS NOT NULL)::int AS response_measured,
                COUNT(*) FILTER (WHERE s.response_met)::int AS response_met,
                ROUND(100.0 * COUNT(*) FILTER (WHERE s.response_met)
                      / NULLIF(COUNT(*) FILTER (WHERE s.response_met IS NOT NULL), 0), 1)
                      AS response_compliance,

                COUNT(*) FILTER (WHERE s.resolution_met IS NOT NULL)::int AS resolution_measured,
                COUNT(*) FILTER (WHERE s.resolution_met)::int AS resolution_met,
                ROUND(100.0 * COUNT(*) FILTER (WHERE s.resolution_met)
                      / NULLIF(COUNT(*) FILTER (WHERE s.resolution_met IS NOT NULL), 0), 1)
                      AS resolution_compliance,

                ROUND(AVG(s.first_reply_minutes)) AS avg_response_minutes,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.first_reply_minutes)
                      AS median_response_minutes,
                PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY s.first_reply_minutes)
                      AS p90_response_minutes,

                ROUND(AVG(s.resolution_adjusted_minutes)) AS avg_resolution_minutes,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.resolution_adjusted_minutes)
                      AS median_resolution_minutes,
                PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY s.resolution_adjusted_minutes)
                      AS p90_resolution_minutes

            FROM tickets_sla s
            JOIN tickets t ON t.id = s.id
            WHERE 1=1
            ${whereClause}
            ${filters.source === 'alarm'
                ? 'AND (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)'
                : filters.source === 'human'
                ? 'AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)'
                : ''}
            GROUP BY 1, s.priority_label, s.response_target, s.resolution_target
            ORDER BY 1, s.response_target
        `, params);

        // Totals per source, so callers do not have to re-aggregate. There is
        // deliberately no combined figure: see the note above.
        const bySource = {};
        for (const r of result.rows) {
            const k = r.source;
            if (!bySource[k]) {
                bySource[k] = {
                    tickets: 0,
                    response_measured: 0, response_met: 0,
                    resolution_measured: 0, resolution_met: 0
                };
            }
            const b = bySource[k];
            b.tickets += r.tickets;
            b.response_measured += r.response_measured;
            b.response_met += r.response_met;
            b.resolution_measured += r.resolution_measured;
            b.resolution_met += r.resolution_met;
        }
        for (const k of Object.keys(bySource)) {
            const b = bySource[k];
            b.response_compliance = b.response_measured
                ? Math.round((b.response_met / b.response_measured) * 1000) / 10 : null;
            b.resolution_compliance = b.resolution_measured
                ? Math.round((b.resolution_met / b.resolution_measured) * 1000) / 10 : null;
        }

        res.json({
            by_priority: result.rows,
            totals: bySource,
            note: 'Alarm and human tickets are reported separately. Alarm tickets are ~89% of volume and are frequently auto-resolved, so a combined figure would be dominated by them.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/sla/targets
 *
 * The published SLA policy as stored, so the UI can render targets without
 * hardcoding them the way iframe.html currently does.
 */
router.get('/sla/targets', cacheMiddleware(3600), async (req, res) => {
    try {
        const result = await query(`
            SELECT priority, label, response_minutes, resolution_minutes,
                   escalation_minutes, comm_objective_minutes, resolution_is_business
            FROM sla_targets
            ORDER BY response_minutes
        `);
        res.json({ targets: result.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/sla/data-quality
 *
 * Surfaces how much the compliance numbers can be trusted.
 *
 * The workflow guide excludes third-party delays from team metrics via the
 * hold statuses. If those statuses are not being used, long resolutions look
 * like slow work when they may be vendor waits. This endpoint measures that
 * gap rather than leaving the reader to assume the data is clean.
 */
router.get('/sla/data-quality', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters, { asFragment: true });

        const result = await query(`
            SELECT
                COUNT(*) FILTER (WHERE NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk))::int
                    AS human_tickets,
                COUNT(*) FILTER (WHERE NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                                   AND t.resolution_minutes > 480)::int
                    AS human_over_8h,
                COUNT(*) FILTER (WHERE NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                                   AND t.resolution_minutes > 480
                                   AND COALESCE(t.on_hold_time_minutes, 0) > 0)::int
                    AS human_over_8h_with_hold,
                COUNT(*) FILTER (WHERE t.custom_status_id IS NULL)::int
                    AS missing_custom_status,
                COUNT(*) FILTER (WHERE t.first_reply_minutes IS NULL)::int
                    AS missing_first_reply,
                COUNT(*) FILTER (WHERE t.resolution_minutes IS NULL)::int
                    AS missing_resolution,
                COUNT(*)::int AS total
            FROM tickets t
            WHERE 1=1
            ${whereClause}
        `, params);

        const r = result.rows[0];
        const unexplained = r.human_over_8h - r.human_over_8h_with_hold;

        res.json({
            ...r,
            unexplained_long_resolutions: unexplained,
            warnings: [
                unexplained > 0
                    ? `${unexplained.toLocaleString()} human tickets resolved in over 8 hours with no on-hold time recorded. Third-party and customer waits are excluded from team metrics by policy, but only if the hold statuses are used. Resolution compliance is likely understated.`
                    : null,
                r.missing_custom_status > 0
                    ? `${r.missing_custom_status.toLocaleString()} tickets predate custom status sync, so workflow-level detail is unavailable for them.`
                    : null
            ].filter(Boolean)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// BILLING & TIME TRACKING ENDPOINTS
// ============================================================================

/**
 * GET /api/analytics/billing/summary
 *
 * Both time figures: actual tracked, and billed after the rounding policy.
 * Reading tickets_billed rather than tickets is what makes billed_minutes
 * available — it applies each org's increment as of the ticket's creation
 * date, so a policy change does not retroactively rewrite older periods.
 */
router.get('/billing/summary', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters, { asFragment: true });

        const result = await query(`
            SELECT 
                COUNT(DISTINCT t.id) as billable_tickets,
                SUM(t.billable_time_minutes) / 60.0 as total_billable_hours,
                SUM(t.billed_minutes) / 60.0 as total_billed_hours,
                COUNT(DISTINCT t.organization_id) as organizations_count,
                AVG(t.billable_time_minutes) / 60.0 as avg_hours_per_ticket,
                (SELECT rounding_increment FROM billing_policies
                  WHERE organization_id IS NULL
                    AND effective_from <= CURRENT_DATE
                  ORDER BY effective_from DESC LIMIT 1) AS rounding_increment
            FROM tickets_billed t
            WHERE t.is_billable = true
            ${whereClause}
        `, params);

        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/billing/by-organization
 * Get billing breakdown by organization
 */
router.get('/billing/by-organization', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters, { asFragment: true });

        const result = await query(`
            SELECT 
                t.organization_id,
                t.organization_name,
                COUNT(t.id) as billable_tickets,
                SUM(t.billable_time_minutes) / 60.0 as billable_hours,
                AVG(t.billable_time_minutes) / 60.0 as avg_hours_per_ticket
            FROM tickets t
            WHERE t.is_billable = true
            ${whereClause}
            GROUP BY t.organization_id, t.organization_name
            ORDER BY billable_hours DESC
            LIMIT 100
        `, params);

        res.json({
            organizations: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// CACHE MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * POST /api/analytics/cache/clear
 * Clear analytics cache
 */
router.post('/cache/clear', async (req, res) => {
    try {
        const result = await clearCache('analytics:*');
        res.json({
            success: true,
            cleared: result.cleared,
            message: `Cleared ${result.cleared} cache entries`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/cache/stats
 * Get cache statistics
 */
router.get('/cache/stats', async (req, res) => {
    try {
        const stats = await getCacheStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// FAST COUNT ENDPOINT
// ============================================
router.get('/tickets/count', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  try {
    const { startDate, endDate, organizationId, dateFilterType } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate required' });
    }

    // Determine which date field to use
    const dateField = dateFilterType === 'solved' ? 'updated_at' : 'created_at';
    // Normalize end to exclusive next-day boundary so the full end day is included regardless of time/timezone
    const endExclusive = new Date(new Date(endDate.substring(0, 10) + 'T00:00:00Z').getTime() + 86400000).toISOString();
    let sql = `SELECT COUNT(*) as total FROM tickets WHERE ${dateField} >= $1 AND ${dateField} < $2`;
    const params = [startDate, endExclusive];
    
    // For solved date filter, only include solved/closed tickets
    if (dateFilterType === 'solved') {
      sql += ` AND status IN ('solved', 'closed')`;
    }
    
    if (organizationId) {
      sql += ` AND organization_id = $3`;
      params.push(organizationId);
    }

    const result = await query(sql, params);
    
    res.json({
      success: true,
      count: parseInt(result.rows[0].total),
      startDate,
      endDate,
      dateFilterType: dateFilterType || 'created'
    });
    
  } catch (error) {
    console.error('Error counting tickets:', error);
    res.status(500).json({ error: 'Failed to count tickets', message: error.message });
  }
});

/**
 * GET /api/analytics/tickets/paginated
 *
 * A page of tickets with the derived columns already resolved. Supports every
 * filter in buildWhereClause, so the same query string works here as on the
 * summary endpoints.
 *
 * Returns computed columns (is_billable, billable_time_minutes,
 * request_type_derived, sla status, custom status label) rather than raw
 * custom_fields / metric_set. Callers that genuinely need the raw JSONB can
 * request a single ticket.
 */
router.get('/tickets/paginated', cacheMiddleware(60), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const filters = req.query;
    const page = Math.max(1, parseInt(filters.page || '1', 10));

    // Default 50, max 500. The old default of 1000 existed to bulk-load the
    // browser's in-memory array; a table does not want that.
    const pageSize = Math.min(1000, Math.max(1, parseInt(filters.pageSize || '50', 10)));
    const offset = (page - 1) * pageSize;

    const sortable = {
      id: 't.id',
      created_at: 't.created_at',
      updated_at: 't.updated_at',
      status: 't.status',
      priority: 't.priority',
      organization: 't.organization_name',
      assignee: 't.assignee_name',
      time: 't.billable_time_minutes',
      billable: 't.is_billable',
      first_reply: 't.first_reply_minutes',
      resolution: 't.resolution_minutes'
    };
    const sortBy = sortable[filters.sortBy] || 't.created_at';
    const sortOrder = String(filters.sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const { whereClause, params } = buildWhereClause(filters);

    // Alarm source is a column condition rather than a buildWhereClause filter,
    // so it is applied here. Kept consistent with /sla/compliance.
    const sourceClause =
      filters.source === 'alarm'
        ? `${whereClause ? 'AND' : 'WHERE'} (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)`
        : filters.source === 'human'
        ? `${whereClause ? 'AND' : 'WHERE'} NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)`
        : '';

    const countResult = await query(
      `SELECT COUNT(*)::int AS total FROM tickets_billed t ${whereClause} ${sourceClause}`,
      params
    );
    const totalCount = countResult.rows[0].total;
    const totalPages = Math.ceil(totalCount / pageSize) || 1;

    const started = Date.now();
    const result = await query(`
      SELECT
        t.id,
        t.subject,
        t.status,
        t.priority,
        t.created_at,
        t.updated_at,
        t.organization_id,
        t.organization_name,
        t.assignee_id,
        t.assignee_name,
        t.group_id,
        t.tags,

        t.is_billable,
        t.billable_time_minutes,
        t.billed_minutes,
        t.rounding_increment,

        t.request_type_derived,
        t.has_alarmtraq,
        t.has_virsae,
        t.has_checkmk,

        t.first_reply_minutes,
        t.resolution_minutes,
        t.on_hold_time_minutes,

        cs.agent_label     AS custom_status_label,
        cs.status_category AS custom_status_category

      FROM tickets_billed t
      LEFT JOIN custom_statuses cs ON cs.id = t.custom_status_id
      ${whereClause}
      ${sourceClause}
      ORDER BY ${sortBy} ${sortOrder} NULLS LAST, t.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, pageSize, offset]);

    res.json({
      success: true,
      tickets: result.rows,
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages,
        hasMore: page < totalPages,
        nextPage: page < totalPages ? page + 1 : null
      },
      queryTime: Date.now() - started
    });
  } catch (error) {
    console.error('Error fetching paginated tickets:', error);
    res.status(500).json({ error: 'Failed to fetch tickets', message: error.message });
  }
});

/**
 * GET /api/analytics/export/tickets
 *
 * Every ticket matching the filters, with both actual and billed time.
 * Same filter vocabulary as every other endpoint, so what the table shows and
 * what the export contains cannot drift apart.
 *
 * Not paginated by design: an export is a whole result set. Capped at 25,000
 * rows, which covers any realistic filtered export while refusing to attempt
 * the full 114k table.
 */
router.get('/export/tickets', async (req, res) => {
  try {
    const filters = req.query;
    const { whereClause, params } = buildWhereClause(filters);

    const sourceClause =
      filters.source === 'alarm'
        ? `${whereClause ? 'AND' : 'WHERE'} (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)`
        : filters.source === 'human'
        ? `${whereClause ? 'AND' : 'WHERE'} NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)`
        : '';

    const MAX_ROWS = 25000;

    const countResult = await query(
      `SELECT COUNT(*)::int AS total FROM tickets_billed t ${whereClause} ${sourceClause}`,
      params
    );
    const total = countResult.rows[0].total;

    if (total > MAX_ROWS) {
      return res.status(413).json({
        error: 'Export too large',
        message: `${total.toLocaleString()} tickets match these filters, above the ${MAX_ROWS.toLocaleString()} row limit. Narrow the date range or add a filter.`,
        totalCount: total,
        maxRows: MAX_ROWS
      });
    }

    const sortable = {
      id: 't.id', created_at: 't.created_at', updated_at: 't.updated_at',
      status: 't.status', priority: 't.priority',
      organization: 't.organization_name', assignee: 't.assignee_name',
      time: 't.billable_time_minutes', billable: 't.is_billable',
      first_reply: 't.first_reply_minutes', resolution: 't.resolution_minutes'
    };
    const sortBy = sortable[filters.sortBy] || 't.created_at';
    const sortOrder = String(filters.sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const started = Date.now();
    const result = await query(`
      SELECT
        t.id,
        t.subject,
        t.status,
        t.priority,
        t.created_at,
        t.updated_at,
        t.organization_id,
        t.organization_name,
        t.assignee_name,
        t.tags,

        t.is_billable,
        t.billable_time_minutes,
        t.billed_minutes,
        t.rounding_increment,

        t.request_type_derived,
        t.has_alarmtraq,
        t.has_virsae,
        t.has_checkmk,

        t.first_reply_minutes,
        t.resolution_minutes,
        t.on_hold_time_minutes,

        cs.agent_label     AS custom_status_label,
        cs.status_category AS custom_status_category

      FROM tickets_billed t
      LEFT JOIN custom_statuses cs ON cs.id = t.custom_status_id
      ${whereClause}
      ${sourceClause}
      ORDER BY ${sortBy} ${sortOrder} NULLS LAST, t.id DESC
      LIMIT ${MAX_ROWS}
    `, params);

    // Totals computed server-side so the export footer cannot disagree with
    // the rows above it.
    const totals = result.rows.reduce((acc, r) => {
      acc.actual_minutes += r.billable_time_minutes || 0;
      acc.billed_minutes += r.billed_minutes || 0;
      if (r.is_billable) acc.billable_tickets += 1;
      return acc;
    }, { actual_minutes: 0, billed_minutes: 0, billable_tickets: 0 });

    res.json({
      success: true,
      tickets: result.rows,
      totals: {
        ...totals,
        tickets: result.rows.length,
        actual_hours: Math.round((totals.actual_minutes / 60) * 100) / 100,
        billed_hours: Math.round((totals.billed_minutes / 60) * 100) / 100
      },
      generated_at: new Date().toISOString(),
      queryTime: Date.now() - started
    });
  } catch (error) {
    console.error('Error exporting tickets:', error);
    res.status(500).json({ error: 'Export failed', message: error.message });
  }
});

// ============================================================================
// TICKET DATA ENDPOINTS (for iframe app)
// ============================================================================

/**
 * GET /api/analytics/tickets
 * Get actual ticket data with filters (for iframe display)
 */
router.get('/tickets', cacheMiddleware(60), async (req, res) => {
    try {
        const filters = {
            startDate: req.query.startDate,
            endDate: req.query.endDate,
            dateFilterType: req.query.dateFilterType || 'created',
            organizationId: req.query.organizationId,
            status: req.query.status,
            priority: req.query.priority,
            groupId: req.query.groupId,
            assigneeId: req.query.assigneeId
        };
        
        const limit = parseInt(req.query.limit) || 10000;
        const offset = parseInt(req.query.offset) || 0;
        
        const { whereClause, params } = buildWhereClause(filters);
        
        // Add limit and offset to params
        params.push(limit, offset);
        const limitClause = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
        
        const result = await query(`
            SELECT 
                t.*,
                tm.first_reply_time_minutes,
                tm.full_resolution_time_minutes,
                tm.sla_first_reply_compliant,
                tm.sla_resolution_compliant
            FROM tickets t
            LEFT JOIN ticket_metrics tm ON t.id = tm.ticket_id
            ${whereClause}
            ORDER BY t.created_at DESC
            ${limitClause}
        `, params);

        res.json({
            tickets: result.rows,
            count: result.rows.length,
            limit: limit,
            offset: offset
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/filters
 * Get available filter options (for dropdowns)
 */
router.get('/filters', cacheMiddleware(300), async (req, res) => {
    try {
        // Get all unique organizations
        const orgs = await query(`
            SELECT DISTINCT organization_id as id, organization_name as name
            FROM tickets
            WHERE organization_id IS NOT NULL
            ORDER BY organization_name
        `);
        
        // Get all assignees
        const assignees = await query(`
            SELECT DISTINCT assignee_id as id, assignee_name as name
            FROM tickets
            WHERE assignee_id IS NOT NULL
            ORDER BY assignee_name
        `);
        
        // Get all groups
        const groups = await query(`
            SELECT DISTINCT group_id as id, group_name as name
            FROM tickets
            WHERE group_id IS NOT NULL
            ORDER BY group_name
        `);
        
        // Get unique statuses
        const statuses = await query(`
            SELECT DISTINCT status
            FROM tickets
            WHERE status IS NOT NULL
            ORDER BY status
        `);
        
        // Get unique priorities
        const priorities = await query(`
            SELECT DISTINCT priority
            FROM tickets
            WHERE priority IS NOT NULL
            ORDER BY priority
        `);

        res.json({
            organizations: orgs.rows,
            assignees: assignees.rows,
            groups: groups.rows,
            statuses: statuses.rows.map(r => r.status),
            priorities: priorities.rows.map(r => r.priority)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/count
 * Quick count of tickets matching filters
 */
router.get('/count', cacheMiddleware(60), async (req, res) => {
    try {
        const filters = {
            startDate: req.query.startDate,
            endDate: req.query.endDate,
            organizationId: req.query.organizationId,
            status: req.query.status,
            priority: req.query.priority,
            groupId: req.query.groupId,
            assigneeId: req.query.assigneeId
        };
        
        const { whereClause, params } = buildWhereClause(filters);
        
        const result = await query(`
            SELECT COUNT(*) as count
            FROM tickets t
            ${whereClause}
        `, params);

        res.json({ count: parseInt(result.rows[0].count) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/dashboard', async (req, res) => {
    try {
        const { days, start_date, end_date, org_id: orgId, agent_id: agentId, group_id: groupId } = req.query;
        
        let whereClause;
        const params = [];
        let paramIndex = 1;
        
        // Support both date range params and legacy 'days' param
        if (start_date && end_date) {
            whereClause = `WHERE date >= $${paramIndex}::date AND date <= $${paramIndex + 1}::date`;
            params.push(start_date, end_date);
            paramIndex = 3;
        } else {
            const daysNum = parseInt(days) || 30;
            whereClause = `WHERE date >= CURRENT_DATE - $${paramIndex}::int`;
            params.push(daysNum);
            paramIndex = 2;
        }
        
        if (orgId) {
            whereClause += ` AND organization_id = $${paramIndex}`;
            params.push(orgId);
            paramIndex++;
        }
        if (agentId) {
            whereClause += ` AND agent_id = $${paramIndex}`;
            params.push(agentId);
            paramIndex++;
        }
        if (groupId) {
            whereClause += ` AND group_id = $${paramIndex}`;
            params.push(groupId);
            paramIndex++;
        }
        
        const result = await pool.query(`
            SELECT
                SUM(tickets_created) as total_created,
                SUM(tickets_solved) as total_solved,
                SUM(tickets_closed) as total_closed,
                ROUND(SUM(total_time_minutes)::numeric / 60, 1) as total_hours,
                ROUND(SUM(billable_time_minutes)::numeric / 60, 1) as billable_hours,
                ROUND(AVG(avg_first_reply_minutes)) as avg_first_reply_minutes,
                ROUND(AVG(avg_full_resolution_minutes)) as avg_resolution_minutes,
                SUM(sla_met) as sla_met,
                SUM(sla_breached) as sla_breached,
                CASE
                    WHEN SUM(sla_met) + SUM(sla_breached) > 0
                    THEN ROUND(SUM(sla_met)::numeric / (SUM(sla_met) + SUM(sla_breached)) * 100, 1)
                    ELSE NULL
                END as sla_rate,
                SUM(one_touch_count) as one_touch_count,
                SUM(two_touch_count) as two_touch_count,
                SUM(multi_touch_count) as multi_touch_count,
                CASE
                    WHEN SUM(tickets_solved) > 0
                    THEN ROUND(SUM(one_touch_count)::numeric / SUM(tickets_solved) * 100, 1)
                    ELSE NULL
                END as one_touch_rate
            FROM analytics_daily
            ${whereClause}
        `, params);
        
        res.json({
            success: true,
            period: start_date && end_date ? `${start_date}_to_${end_date}` : `last_${days || 30}_days`,
            filters: { org_id: orgId, agent_id: agentId, group_id: groupId },
            data: result.rows[0],
            source: 'pre_aggregated'
        });
    } catch (error) {
        console.error('Error fetching dashboard analytics:', error);
        res.status(500).json({ error: 'Failed to fetch analytics', details: error.message });
    }
});

/**
 * Daily trend data for charts - FAST
 * GET /api/analytics/daily-trend?days=30
 */
router.get('/daily-trend', async (req, res) => {
    try {
        const { days, start_date, end_date, org_id: orgId, agent_id: agentId, group_id: groupId } = req.query;
        
        let whereClause;
        const params = [];
        let paramIndex = 1;
        
        // Support both date range params and legacy 'days' param
        if (start_date && end_date) {
            whereClause = `WHERE date >= $${paramIndex}::date AND date <= $${paramIndex + 1}::date`;
            params.push(start_date, end_date);
            paramIndex = 3;
        } else {
            const daysNum = parseInt(days) || 30;
            whereClause = `WHERE date >= CURRENT_DATE - $${paramIndex}::int`;
            params.push(daysNum);
            paramIndex = 2;
        }
        
        if (orgId) {
            whereClause += ` AND organization_id = $${paramIndex}`;
            params.push(orgId);
            paramIndex++;
        }
        if (agentId) {
            whereClause += ` AND agent_id = $${paramIndex}`;
            params.push(agentId);
            paramIndex++;
        }
        if (groupId) {
            whereClause += ` AND group_id = $${paramIndex}`;
            params.push(groupId);
            paramIndex++;
        }
        
        const result = await pool.query(`
            SELECT
                SUM(tickets_created) as total_created,
                SUM(tickets_solved) as total_solved,
                SUM(tickets_closed) as total_closed,
                ROUND(SUM(total_time_minutes)::numeric / 60, 1) as total_hours,
                ROUND(SUM(billable_time_minutes)::numeric / 60, 1) as billable_hours,
                ROUND(AVG(avg_first_reply_minutes)) as avg_first_reply_minutes,
                ROUND(AVG(avg_full_resolution_minutes)) as avg_resolution_minutes,
                SUM(sla_met) as sla_met,
                SUM(sla_breached) as sla_breached,
                CASE
                    WHEN SUM(sla_met) + SUM(sla_breached) > 0
                    THEN ROUND(SUM(sla_met)::numeric / (SUM(sla_met) + SUM(sla_breached)) * 100, 1)
                    ELSE NULL
                END as sla_rate,
                SUM(one_touch_count) as one_touch_count,
                SUM(two_touch_count) as two_touch_count,
                SUM(multi_touch_count) as multi_touch_count,
                CASE
                    WHEN SUM(tickets_solved) > 0
                    THEN ROUND(SUM(one_touch_count)::numeric / SUM(tickets_solved) * 100, 1)
                    ELSE NULL
                END as one_touch_rate
            FROM analytics_daily
            ${whereClause}
        `, params);
        
        res.json({
            success: true,
            period: start_date && end_date ? `${start_date}_to_${end_date}` : `last_${days || 30}_days`,
            filters: { org_id: orgId, agent_id: agentId, group_id: groupId },
            data: result.rows[0],
            source: 'pre_aggregated'
        });
    } catch (error) {
        console.error('Error fetching dashboard analytics:', error);
        res.status(500).json({ error: 'Failed to fetch analytics', details: error.message });
    }
});

/**
 * Agent leaderboard - FAST
 * GET /api/analytics/agent-leaderboard?days=30&limit=20
 */
router.get('/agent-leaderboard', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const limit = parseInt(req.query.limit) || 20;
        
        const result = await pool.query(`
            SELECT
                a.id as agent_id,
                a.name as agent_name,
                a.email as agent_email,
                COALESCE(SUM(ad.tickets_solved), 0) as tickets_solved,
                COALESCE(SUM(ad.tickets_created), 0) as tickets_touched,
                ROUND(COALESCE(SUM(ad.total_time_minutes), 0)::numeric / 60, 1) as total_hours,
                ROUND(AVG(ad.avg_full_resolution_minutes)) as avg_resolution_minutes,
                ROUND(AVG(ad.avg_first_reply_minutes)) as avg_first_reply_minutes,
                CASE 
                    WHEN SUM(ad.sla_met) + SUM(ad.sla_breached) > 0 
                    THEN ROUND(SUM(ad.sla_met)::numeric / (SUM(ad.sla_met) + SUM(ad.sla_breached)) * 100, 1)
                    ELSE NULL 
                END as sla_rate,
                CASE 
                    WHEN SUM(ad.tickets_solved) > 0 
                    THEN ROUND(SUM(ad.one_touch_count)::numeric / SUM(ad.tickets_solved) * 100, 1)
                    ELSE NULL 
                END as one_touch_rate
            FROM agents a
            LEFT JOIN analytics_daily ad ON ad.agent_id = a.id 
                AND ad.date >= CURRENT_DATE - $1::int
            WHERE a.active = true
            GROUP BY a.id, a.name, a.email
            HAVING SUM(ad.tickets_solved) > 0
            ORDER BY tickets_solved DESC
            LIMIT $2
        `, [days, limit]);
        
        res.json({
            success: true,
            period: `last_${days}_days`,
            agents: result.rows,
            source: 'pre_aggregated'
        });
        
    } catch (error) {
        console.error('Error fetching agent leaderboard:', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard', details: error.message });
    }
});

/**
 * Organization summary - FAST
 * GET /api/analytics/org-summary?days=30&limit=50
 */
router.get('/org-summary', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const orgId = req.query.org_id;
        const limit = parseInt(req.query.limit) || 50;
        
        let whereClause = 'WHERE ad.date >= CURRENT_DATE - $1::int';
        const params = [days];
        let paramIndex = 2;
        
        if (orgId) {
            whereClause += ` AND ad.organization_id = $${paramIndex}`;
            params.push(orgId);
            paramIndex++;
        }
        
        params.push(limit);
        
        const result = await pool.query(`
            SELECT
                o.id as organization_id,
                o.name as organization_name,
                SUM(ad.tickets_created) as tickets_created,
                SUM(ad.tickets_solved) as tickets_solved,
                ROUND(SUM(ad.total_time_minutes)::numeric / 60, 1) as total_hours,
                ROUND(SUM(ad.billable_time_minutes)::numeric / 60, 1) as billable_hours,
                ROUND(AVG(ad.avg_full_resolution_minutes)) as avg_resolution_minutes,
                CASE 
                    WHEN SUM(ad.sla_met) + SUM(ad.sla_breached) > 0 
                    THEN ROUND(SUM(ad.sla_met)::numeric / (SUM(ad.sla_met) + SUM(ad.sla_breached)) * 100, 1)
                    ELSE NULL 
                END as sla_rate
            FROM organizations o
            INNER JOIN analytics_daily ad ON ad.organization_id = o.id
            ${whereClause}
            GROUP BY o.id, o.name
            ORDER BY tickets_created DESC
            LIMIT $${paramIndex}
        `, params);
        
        res.json({
            success: true,
            period: `last_${days}_days`,
            organizations: result.rows,
            source: 'pre_aggregated'
        });
        
    } catch (error) {
        console.error('Error fetching org summary:', error);
        res.status(500).json({ error: 'Failed to fetch org summary', details: error.message });
    }
});

/**
 * Current ticket status snapshot - point-in-time (reads live tickets table)
 * Active states are live totals; solved/closed scoped to year-to-date.
 * GET /api/analytics/status-snapshot?org_id=123
 */
router.get('/status-snapshot', async (req, res) => {
    try {
        const { org_id: orgId } = req.query;
        const params = [];
        let orgClause = '';
        if (orgId) {
            orgClause = ' AND organization_id = $1';
            params.push(orgId);
        }

        const result = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE status IN ('new','open'))                              AS new_open,
                COUNT(*) FILTER (WHERE status = 'pending')                                    AS pending,
                COUNT(*) FILTER (WHERE status = 'hold')                                       AS hold,
                COUNT(*) FILTER (WHERE status = 'solved'
                                 AND created_at >= date_trunc('year', CURRENT_DATE))          AS solved_ytd,
                COUNT(*) FILTER (WHERE status = 'closed'
                                 AND created_at >= date_trunc('year', CURRENT_DATE))          AS closed_ytd,
                COUNT(*) FILTER (WHERE status IN ('new','open','pending','hold'))             AS open_total
            FROM tickets
            WHERE 1=1${orgClause}
        `, params);

        res.json({ success: true, data: result.rows[0], source: 'live_tickets' });
    } catch (error) {
        console.error('Error fetching status snapshot:', error);
        res.status(500).json({ error: 'Failed to fetch status snapshot', details: error.message });
    }
});

/**
 * Priority breakdown - FAST
 * GET /api/analytics/priority-breakdown?days=30
 */
router.get('/priority-breakdown', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const orgId = req.query.org_id;
        
        let whereClause = 'WHERE date >= CURRENT_DATE - $1::int';
        const params = [days];
        let paramIndex = 2;
        
        if (orgId) {
            whereClause += ` AND organization_id = $${paramIndex}`;
            params.push(orgId);
            paramIndex++;
        }
        
        const result = await pool.query(`
            SELECT
                COALESCE(priority, 'none') as priority,
                SUM(tickets_created) as tickets_created,
                SUM(tickets_solved) as tickets_solved,
                ROUND(AVG(avg_first_reply_minutes)) as avg_first_reply,
                ROUND(AVG(avg_full_resolution_minutes)) as avg_resolution,
                SUM(sla_met) as sla_met,
                SUM(sla_breached) as sla_breached,
                CASE 
                    WHEN SUM(sla_met) + SUM(sla_breached) > 0 
                    THEN ROUND(SUM(sla_met)::numeric / (SUM(sla_met) + SUM(sla_breached)) * 100, 1)
                    ELSE NULL 
                END as sla_rate,
                SUM(one_touch_count) as one_touch,
                SUM(two_touch_count) as two_touch,
                SUM(multi_touch_count) as multi_touch
            FROM analytics_daily
            ${whereClause}
            GROUP BY priority
            ORDER BY 
                CASE priority 
                    WHEN 'urgent' THEN 1 
                    WHEN 'high' THEN 2 
                    WHEN 'normal' THEN 3 
                    WHEN 'low' THEN 4 
                    ELSE 5 
                END
        `, params);
        
        res.json({
            success: true,
            period: `last_${days}_days`,
            priorities: result.rows,
            source: 'pre_aggregated'
        });
        
    } catch (error) {
        console.error('Error fetching priority breakdown:', error);
        res.status(500).json({ error: 'Failed to fetch priority data', details: error.message });
    }
});

// ============================================
// AGGREGATION MANAGEMENT ENDPOINTS
// ============================================

/**
 * Get aggregation status
 * GET /api/analytics/aggregation-status
 */
router.get('/aggregation-status', async (req, res) => {
    try {
        const status = await pool.query(`
            SELECT 
                aggregation_type,
                MAX(date_processed) as last_processed,
                COUNT(*) FILTER (WHERE status = 'success') as success_count,
                COUNT(*) FILTER (WHERE status = 'error') as error_count,
                MAX(completed_at) as last_completed
            FROM aggregation_log
            GROUP BY aggregation_type
            ORDER BY aggregation_type
        `);
        
        const tableCounts = await pool.query(`
            SELECT 
                'analytics_daily' as table_name, 
                COUNT(*) as row_count,
                MIN(date) as earliest_date,
                MAX(date) as latest_date
            FROM analytics_daily
            UNION ALL
            SELECT 'analytics_agent_weekly', COUNT(*), MIN(week_start), MAX(week_start) FROM analytics_agent_weekly
            UNION ALL
            SELECT 'analytics_org_monthly', COUNT(*), MIN(month), MAX(month) FROM analytics_org_monthly
        `);
        
        res.json({
            success: true,
            aggregation_status: status.rows,
            table_stats: tableCounts.rows
        });
        
    } catch (error) {
        console.error('Error fetching aggregation status:', error);
        res.status(500).json({ error: 'Failed to fetch status', details: error.message });
    }
});

/**
 * Manually trigger daily aggregation
 * POST /api/analytics/aggregate-daily
 * Body: { "date": "YYYY-MM-DD" } (optional)
 */
router.post('/aggregate-daily', async (req, res) => {
    try {
        const { date } = req.body;
        const targetDate = date ? new Date(date) : null;
        
        // Import the function from syncJobs
        const { aggregateDailyAnalytics } = require('../services/syncJobs');
        
        const result = await aggregateDailyAnalytics(targetDate);
        res.json(result);
        
    } catch (error) {
        console.error('Error triggering aggregation:', error);
        res.status(500).json({ error: 'Failed to run aggregation', details: error.message });
    }
});

/**
 * Backfill historical data
 * POST /api/analytics/backfill
 * Body: { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD" }
 */
router.post('/backfill', async (req, res) => {
    try {
        const { start_date, end_date } = req.body;
        
        if (!start_date || !end_date) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                required: ['start_date', 'end_date']
            });
        }
        
        // Import the function from syncJobs
        const { backfillDailyAnalytics } = require('../services/syncJobs');
        
        console.log(`Starting backfill from ${start_date} to ${end_date}...`);
        
        // Run backfill
        const result = await backfillDailyAnalytics(start_date, end_date);
        
        res.json({
            success: true,
            message: 'Backfill completed',
            ...result
        });
        
    } catch (error) {
        console.error('Error running backfill:', error);
        res.status(500).json({ error: 'Failed to run backfill', details: error.message });
    }
});

module.exports = router;
