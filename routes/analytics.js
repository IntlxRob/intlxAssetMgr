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
    // 'solved' is the billing basis: invoices count tickets resolved in the
    // period, whenever they were opened. updated_at was the previous proxy and
    // was wrong for 8.4% of tickets — any comment after resolution moves it
    // into a later month.
    const dateField =
      filters.dateFilterType === 'solved' ? 't.solved_at' : 't.created_at';

    // Date range filter
    if (filters.startDate) {
        conditions.push(`${dateField} >= $${paramIndex++}`);
        params.push(filters.startDate);
    }
    if (filters.endDate) {
        // Exclusive upper bound at the following midnight. A bare date compared
        // with <= against a timestamp means midnight, so the last day of every
        // range was being excluded - a same-day filter matched only tickets
        // created at exactly 00:00:00, and a month range covered 30 days.
        conditions.push(`${dateField} < ($${paramIndex++}::date + interval '1 day')`);
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

                -- Alarm volume changes what every other number means: at ~89%
                -- of tickets, an unsplit total is mostly describing machines.
                COUNT(*) FILTER (WHERE t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    as alarm_tickets,
                COUNT(*) FILTER (WHERE NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk))
                    as human_tickets,

                COUNT(CASE WHEN is_billable THEN 1 END) as billable_tickets,

                -- Hours tracked across ALL tickets, and separately the share on
                -- billable ones. The previous version summed everything and
                -- called it billable, so it never matched /billing/summary.
                SUM(t.billable_time_minutes) / 60.0 as total_hours,
                SUM(t.billable_time_minutes) FILTER (WHERE t.is_billable) / 60.0
                    as total_billable_hours
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
                AVG(t.first_reply_minutes) as avg_first_reply_minutes,
                AVG(t.resolution_minutes) as avg_resolution_minutes
            FROM tickets t
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

        // One row per agent per group rather than per agent. An agent working
        // in several groups appears under each, counting only that group's
        // tickets — so these rows sum to their standalone totals.
        const byGroup = filters.groupBy === 'group';

        const { whereClause, params } = buildWhereClause(filters, { asFragment: true });

        // The open-worked CTE needs the raw dates, which buildWhereClause keeps
        // inside its generated SQL. Appending them rather than threading them
        // through leaves the existing query untouched.
        const dFrom = `$${params.length + 1}`;
        const dTo   = `$${params.length + 2}`;
        params.push(filters.startDate || '1970-01-01', filters.endDate || '2999-12-31');

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
                    t.group_id,
                    t.billable_time_minutes,
                    t.billed_minutes,
                    t.is_billable,
                    t.reply_count,
                    (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk) AS is_alarm
                FROM tickets_sla s
                JOIN tickets_billed t ON t.id = s.id
                WHERE t.assignee_id IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM automation_accounts a WHERE a.agent_id = t.assignee_id
                  )
                  ${whereClause}
            ),
            -- Tickets still open that the agent logged time against in the
            -- period. The only measure here of effort rather than outcome: an
            -- agent can spend a day on held tickets and show nothing solved.
            --
            -- Keyed on when the time was logged, which is a different basis
            -- from the rest of the row and unavoidably so - work in progress is
            -- defined by when the work happened.
            open_worked AS (
                SELECT te.agent_id,
                       COUNT(DISTINCT te.ticket_id)::int AS n
                  FROM ticket_time_entries te
                  JOIN tickets t ON t.id = te.ticket_id
                 WHERE te.created_at >= ${dFrom}::date
                   AND te.created_at <  ${dTo}::date + interval '1 day'
                   -- Machine-written entries; see the guard on
                   -- /agents/ticket-time.
                   AND te.created_at >  t.created_at + interval '1 minute'
                   AND t.status NOT IN ('solved','closed','deleted')
                 GROUP BY te.agent_id
            )
            SELECT
                assignee_id,
                assignee_name,
                ${byGroup ? 'group_id,' : 'NULL::bigint AS group_id,'}

                COUNT(*)::int AS total_tickets,
                COUNT(*) FILTER (WHERE NOT is_alarm)::int AS human_tickets,
                COUNT(*) FILTER (WHERE is_alarm)::int AS alarm_tickets,
                COUNT(*) FILTER (WHERE status IN ('solved','closed'))::int AS solved_tickets,
                -- The other half of the pair: what they are carrying, not
                -- what they finished.
                COALESCE(MAX(ow.n), 0)::int AS open_worked,

                COUNT(*) FILTER (WHERE is_billable)::int AS billable_tickets,
                ROUND((SUM(billable_time_minutes) / 60.0)::numeric, 1) AS actual_hours,
                ROUND((SUM(billed_minutes) / 60.0)::numeric, 1) AS billed_hours,

                -- Hours per HUMAN ticket. Including alarms would flatten this
                -- toward zero and hide the difference between deep work and
                -- high-volume triage.
                ROUND((SUM(billable_time_minutes) FILTER (WHERE NOT is_alarm)
                       / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm), 0) / 60.0)::numeric, 2)
                    AS avg_hours_per_human_ticket,

                    -- Resolution efficiency, on resolved HUMAN tickets only.
                -- Alarms auto-resolve at one touch, so including them would
                -- measure queue composition rather than how cleanly an agent
                -- closes customer work.
                COUNT(*) FILTER (WHERE NOT is_alarm AND status IN ('solved','closed'))::int
                    AS resolved_human,
                ROUND(100.0 * COUNT(*) FILTER (
                        WHERE NOT is_alarm AND status IN ('solved','closed')
                          AND COALESCE(reply_count, 0) <= 1)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND status IN ('solved','closed')), 0), 1)
                    AS one_touch_pct,
                ROUND(100.0 * COUNT(*) FILTER (
                        WHERE NOT is_alarm AND status IN ('solved','closed')
                          AND reply_count = 2)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND status IN ('solved','closed')), 0), 1)
                    AS two_touch_pct,
                ROUND(100.0 * COUNT(*) FILTER (
                        WHERE NOT is_alarm AND status IN ('solved','closed')
                          AND reply_count >= 3)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND status IN ('solved','closed')), 0), 1)
                    AS multi_touch_pct,
                ROUND(AVG(reply_count) FILTER (WHERE NOT is_alarm AND status IN ('solved','closed')), 1)
                    AS avg_replies,

                ROUND(AVG(first_reply_minutes) FILTER (WHERE NOT is_alarm)) AS avg_first_reply_minutes,
                ROUND(AVG(resolution_adjusted_minutes) FILTER (WHERE NOT is_alarm)) AS avg_resolution_minutes,

                ROUND(100.0 * COUNT(*) FILTER (WHERE NOT is_alarm AND response_met)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND response_met IS NOT NULL), 0), 1)
                    AS response_compliance,
                ROUND(100.0 * COUNT(*) FILTER (WHERE NOT is_alarm AND resolution_met)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND resolution_met IS NOT NULL), 0), 1)
                    AS resolution_compliance

            FROM scoped
            LEFT JOIN open_worked ow ON ow.agent_id = scoped.assignee_id
            GROUP BY assignee_id, assignee_name${byGroup ? ', group_id' : ''}
            ORDER BY SUM(billable_time_minutes) DESC NULLS LAST
            LIMIT ${byGroup ? 500 : 100}
        `, params);

        let agents = result.rows;

        if (byGroup) {
            // Membership is a fact about people; activity is not. Without this
            // an agent who took no tickets vanishes from their own team - and
            // Engineering has seven such people, which is what a roster should
            // surface rather than hide.
            const roster = await query(
                'SELECT gm.group_id, gm.agent_id, a.name AS assignee_name ' +
                '  FROM group_memberships gm ' +
                '  JOIN agents a ON a.id = gm.agent_id ' +
                ' WHERE NOT EXISTS (SELECT 1 FROM automation_accounts aa ' +
                '                    WHERE aa.agent_id = gm.agent_id)'
            );

            const seen = new Set(agents.map(a => a.group_id + ':' + a.assignee_id));
            for (const r of roster.rows) {
                if (seen.has(r.group_id + ':' + r.agent_id)) continue;
                // Counts zero, rates null. An agent with no tickets has no
                // compliance rate, and 0% would read as failure rather than
                // absence.
                agents.push({
                    group_id: r.group_id,
                    assignee_id: r.agent_id,
                    assignee_name: r.assignee_name,
                    total_tickets: 0, solved_tickets: 0,
                    human_tickets: 0, alarm_tickets: 0, resolved_human: 0,
                    actual_hours: '0.0', billed_hours: '0.0',
                    avg_hours_per_human_ticket: null,
                    one_touch_pct: null, two_touch_pct: null, multi_touch_pct: null,
                    avg_replies: null, avg_first_reply_minutes: null,
                    avg_resolution_minutes: null,
                    response_compliance: null, resolution_compliance: null
                });
            }
        }

        res.json({
            agents,
            count: agents.length,
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

/**
 * GET /api/analytics/agents/workload
 *
 * Open tickets per agent, as of now. Deliberately ignores the date filter:
 * a backlog is a current state, not a period measurement, and mixing the two
 * invites reading one as the other.
 *
 * Split by who the ticket is waiting on, from sla_category_behaviour:
 *   intlx    - new/open, the agent's move
 *   customer - pending, waiting on a response
 *   vendor   - hold, waiting on a third party
 *
 * That distinction is the point. Ten tickets waiting on customers is not the
 * same workload as ten in progress.
 */
router.get('/agents/workload', cacheMiddleware(120), async (req, res) => {
    try {
        const result = await query(`
            SELECT
                t.assignee_id,
                t.assignee_name,

                COUNT(*)::int AS open_tickets,
                COUNT(*) FILTER (WHERE b.ball_with = 'intlx')::int    AS with_intlx,
                COUNT(*) FILTER (WHERE b.ball_with = 'customer')::int AS with_customer,
                COUNT(*) FILTER (WHERE b.ball_with = 'vendor')::int   AS with_vendor,

                COUNT(*) FILTER (WHERE t.priority = 'urgent')::int AS urgent,
                COUNT(*) FILTER (WHERE t.priority = 'high')::int   AS high,

                -- Age of the oldest open ticket. A backlog of twelve is fine;
                -- a backlog of twelve where one has been open ninety days is
                -- a different conversation.
                MAX(EXTRACT(DAY FROM now() - t.created_at))::int AS oldest_days,
                ROUND(AVG(EXTRACT(DAY FROM now() - t.created_at)))::int AS avg_age_days,

                COUNT(*) FILTER (WHERE t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)::int
                    AS alarm_tickets

            FROM tickets t
            LEFT JOIN custom_statuses cs ON cs.id = t.custom_status_id
            LEFT JOIN sla_category_behaviour b
                   ON b.status_category = CASE
                        WHEN t.status IN ('closed', 'deleted') THEN t.status
                        ELSE COALESCE(cs.status_category, t.status)
                      END
            WHERE t.status NOT IN ('solved', 'closed', 'deleted')
              AND t.assignee_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM automation_accounts a WHERE a.agent_id = t.assignee_id
              )
            GROUP BY t.assignee_id, t.assignee_name
            ORDER BY COUNT(*) FILTER (WHERE b.ball_with = 'intlx') DESC, COUNT(*) DESC
        `);

        // Unassigned open tickets belong to nobody and would otherwise vanish
        // from every view. Reported separately rather than dropped.
        const unassigned = await query(`
            SELECT COUNT(*)::int AS open_tickets,
                   COUNT(*) FILTER (WHERE t.priority IN ('urgent','high'))::int AS urgent_or_high
              FROM tickets t
             WHERE t.status NOT IN ('solved', 'closed', 'deleted')
               AND t.assignee_id IS NULL
        `);

        const totals = result.rows.reduce((acc, r) => {
            acc.open_tickets += r.open_tickets;
            acc.with_intlx += r.with_intlx;
            acc.with_customer += r.with_customer;
            acc.with_vendor += r.with_vendor;
            return acc;
        }, { open_tickets: 0, with_intlx: 0, with_customer: 0, with_vendor: 0 });

        res.json({
            agents: result.rows,
            unassigned: unassigned.rows[0],
            totals,
            as_of: new Date().toISOString(),
            note: 'Current state, not filtered by date. Sorted by tickets awaiting intlx action.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/agents/ticket-time
 *
 * Share of a nominal working week spent on tickets, per agent, with logging
 * coverage beside it.
 *
 * Hours come from ticket_time_entries rather than the ticket field: entries
 * carry the date the time was logged and the agent who logged it, so a day
 * means that day and someone who helps on a colleague's ticket gets the credit.
 * Summing the ticket field instead would attribute a week's work to whichever
 * day the ticket happened to close.
 *
 * Coverage stays on tickets, because "what share of resolved tickets had time
 * logged" is a question about tickets.
 */
router.get('/agents/ticket-time', cacheMiddleware(300), async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'startDate and endDate required' });
        }

        const result = await query(`
            WITH bounds AS (
                SELECT $1::date AS from_date, $2::date AS to_date
            ),
            working AS (
                -- Business days times eight. PTO is invisible to us, so this is
                -- nominal capacity rather than actual availability — and over a
                -- single day it is simply 8.
                SELECT GREATEST(COUNT(*) FILTER (
                         WHERE EXTRACT(ISODOW FROM d) < 6
                       ), 1)::int * 8 AS available_hours
                  FROM bounds b,
                       generate_series(b.from_date, b.to_date, interval '1 day') d
            ),
            logged AS (
                -- Keyed on when the entry was made, not when the ticket closed.
                SELECT te.agent_id,
                       SUM(te.time_seconds) / 3600.0 AS hours
                  FROM ticket_time_entries te
                  JOIN tickets t ON t.id = te.ticket_id
                  CROSS JOIN bounds b
                 WHERE te.created_at >= b.from_date
                   AND te.created_at < b.to_date + interval '1 day'
                   AND te.agent_id IS NOT NULL
                   -- Machine-written entries. In August 2026 something wrote
                   -- 1800 seconds to 238 alarm tickets within six seconds of
                   -- their creation — 119 hours nobody worked, half of it on
                   -- alarms that self-cleared. One agent showed 97.6 hours in
                   -- a day.
                   --
                   -- A timing test rather than a value or tag test: those
                   -- would be brittle, and nobody logs real work within a
                   -- minute of a ticket existing whatever the value. This
                   -- catches the next occurrence too.
                   AND te.created_at > t.created_at + interval '1 minute'
                 GROUP BY te.agent_id
            ),
                        resolved AS (
                -- Human tickets plus alarms that actually reached a person.
                -- Excluding alarm work entirely made the most active person on
                -- the team look idle: Greg Garabedian shows 3 human tickets
                -- against 1,134 handled alarms, 93% of them with logged time.
                --
                -- Self-cleared and merged alarms are excluded because nobody
                -- touched them, and counting them would read as a team-wide
                -- logging failure rather than as automation working.
                SELECT t.assignee_id,
                       COUNT(*)::int AS tickets,
                       COUNT(*) FILTER (
                         WHERE COALESCE(t.billable_time_minutes, 0) > 0
                       )::int AS tickets_logged,
                       COUNT(*) FILTER (
                         WHERE NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                       )::int AS human_tickets,
                       COUNT(*) FILTER (
                         WHERE (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                       )::int AS alarm_tickets
                  FROM tickets t
                  JOIN groups g ON g.id = t.group_id
                  CROSS JOIN bounds b
                 WHERE t.solved_at >= b.from_date
                   AND t.solved_at < b.to_date + interval '1 day'
                   AND t.assignee_id IS NOT NULL
                   AND g.expects_time_logging
                   AND (
                     NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                     OR (
                       NOT (t.tags @> '["alarm_cleared"]'::jsonb)
                       AND NOT (t.tags @> '["merged_duplicate"]'::jsonb)
                       AND NOT (t.tags @> '["closed_by_merge"]'::jsonb)
                     )
                   )
                 GROUP BY t.assignee_id
            )
            SELECT
                a.id AS assignee_id,
                a.name AS assignee_name,
                COALESCE(r.tickets, 0) AS tickets,
                COALESCE(r.tickets_logged, 0) AS tickets_logged,
                CASE WHEN COALESCE(r.tickets, 0) > 0
                     THEN ROUND(100.0 * r.tickets_logged / r.tickets)
                END AS coverage_pct,
                ROUND(COALESCE(l.hours, 0)::numeric, 1) AS hours_logged,
                w.available_hours,
                ROUND(100.0 * COALESCE(l.hours, 0) / NULLIF(w.available_hours, 0), 1)
                    AS ticket_time_pct
            FROM agents a
            CROSS JOIN working w
            LEFT JOIN logged l ON l.agent_id = a.id
            LEFT JOIN resolved r ON r.assignee_id = a.id
            WHERE NOT EXISTS (
              SELECT 1 FROM automation_accounts aa WHERE aa.agent_id = a.id
            )
              -- Someone with neither logged time nor resolved tickets in the
              -- window has nothing to report; listing them as 0% would imply
              -- they were idle rather than absent from this data.
              AND (l.hours IS NOT NULL OR r.tickets IS NOT NULL)
            ORDER BY COALESCE(l.hours, 0) DESC
        `, [startDate, endDate]);

        res.json({
            agents: result.rows,
            available_hours: result.rows[0]?.available_hours ?? null,
            note: 'Hours are time entries logged in the period, so a day means that day. Share of a nominal working week — not utilization: project work and meetings are invisible and PTO is not deducted. Coverage is the share of resolved tickets with any time logged, in groups where logging is expected. A low share with low coverage means unrecorded work rather than a light week.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/open/aging
 *
 * Open tickets ranked by how far past their resolution target they are.
 *
 * Elapsed since creation, not adjusted for time spent awaiting a customer or
 * vendor — that history is not synced. ball_with is returned so a ticket at
 * 300% of target while pending a customer reads differently from one at 300%
 * that is nobody's move but ours.
 */
router.get('/open/aging', cacheMiddleware(120), async (req, res) => {
    try {
        const limit = Math.min(200, parseInt(req.query.limit || '50', 10));

        // Default sorts by priority: a P1 fourteen hours late matters more
        // than a P4 from last year at 24,000% of target, and the unattended
        // view should lead with what needs acting on. 'overrun' is for a
        // cleanup pass, where oldest-first is the point.
        const sortBy = req.query.sort === 'overrun' ? 'overrun' : 'priority';

        const result = await query(`
            SELECT
                t.id,
                t.subject,
                t.priority,
                t.organization_name,
                t.assignee_name,
                t.created_at,
                cs.agent_label AS custom_status_label,
                COALESCE(b.ball_with, 'intlx') AS ball_with,
                tg.label AS priority_label,
                tg.resolution_minutes AS resolution_target,

                ROUND(EXTRACT(EPOCH FROM (now() - t.created_at)) / 60)::int
                    AS elapsed_minutes,

                -- Percentage of target consumed. Over 100 means the published
                -- resolution window has passed, which is a prompt to look
                -- rather than a breach on its own.
                ROUND(100.0 * (EXTRACT(EPOCH FROM (now() - t.created_at)) / 60)
                      / NULLIF(tg.resolution_minutes, 0))::int
                    AS pct_of_target,

                (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk) AS is_alarm

            FROM tickets t
            LEFT JOIN custom_statuses cs ON cs.id = t.custom_status_id
            LEFT JOIN sla_category_behaviour b
                   ON b.status_category = CASE
                        WHEN t.status IN ('closed', 'deleted') THEN t.status
                        ELSE COALESCE(cs.status_category, t.status)
                      END
            LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority, 'normal')
            WHERE t.status NOT IN ('solved', 'closed', 'deleted')
              AND EXTRACT(EPOCH FROM (now() - t.created_at)) / 60 > tg.resolution_minutes
            ORDER BY
                ${sortBy === 'priority' ? 'tg.response_minutes ASC,' : ''}
                (EXTRACT(EPOCH FROM (now() - t.created_at)) / 60)
                / NULLIF(tg.resolution_minutes, 0) DESC
            LIMIT $1
        `, [limit]);

        // Counts by who is blocking, so the headline can distinguish "past
        // target and ours" from "past target and waiting on someone else".
        const summary = await query(`
            SELECT
                COALESCE(b.ball_with, 'intlx') AS ball_with,
                COUNT(*)::int AS tickets
            FROM tickets t
            LEFT JOIN custom_statuses cs ON cs.id = t.custom_status_id
            LEFT JOIN sla_category_behaviour b
                   ON b.status_category = CASE
                        WHEN t.status IN ('closed', 'deleted') THEN t.status
                        ELSE COALESCE(cs.status_category, t.status)
                      END
            LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority, 'normal')
            WHERE t.status NOT IN ('solved', 'closed', 'deleted')
              AND EXTRACT(EPOCH FROM (now() - t.created_at)) / 60 > tg.resolution_minutes
            GROUP BY 1
        `);

        res.json({
            tickets: result.rows,
            by_blocker: summary.rows,
            sort: sortBy,
            as_of: new Date().toISOString(),
            note: 'Elapsed since creation vs published resolution target. Not adjusted for time awaiting customer or vendor — that history is not synced.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/open/by-organization
 *
 * What each client currently has in flight, and how much of it they are
 * blocking themselves. Useful before a check-in call: "you have nine open,
 * six are waiting on you" is a different conversation from nine on us.
 */
router.get('/open/by-organization', cacheMiddleware(120), async (req, res) => {
    try {
        const result = await query(`
            SELECT
                t.organization_id,
                t.organization_name,
                COUNT(*)::int AS open_tickets,
                COUNT(*) FILTER (WHERE COALESCE(b.ball_with,'intlx') = 'intlx')::int    AS with_intlx,
                COUNT(*) FILTER (WHERE b.ball_with = 'customer')::int AS with_customer,
                COUNT(*) FILTER (WHERE b.ball_with = 'vendor')::int   AS with_vendor,
                COUNT(*) FILTER (WHERE t.priority IN ('urgent','high'))::int AS urgent_or_high,
                COUNT(*) FILTER (WHERE t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)::int
                    AS alarm_tickets,
                MAX(EXTRACT(DAY FROM now() - t.created_at))::int AS oldest_days
            FROM tickets t
            LEFT JOIN custom_statuses cs ON cs.id = t.custom_status_id
            LEFT JOIN sla_category_behaviour b
                   ON b.status_category = CASE
                        WHEN t.status IN ('closed', 'deleted') THEN t.status
                        ELSE COALESCE(cs.status_category, t.status)
                      END
            WHERE t.status NOT IN ('solved', 'closed', 'deleted')
              AND t.organization_id IS NOT NULL
            GROUP BY t.organization_id, t.organization_name
            ORDER BY COUNT(*) FILTER (WHERE COALESCE(b.ball_with,'intlx') = 'intlx') DESC,
                     COUNT(*) DESC
        `);

        res.json({ organizations: result.rows, as_of: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/open/updates
 *
 * Open tickets ranked by how long the customer has been waiting to hear
 * anything, against the update target for the ticket's priority.
 *
 * Two clocks: since the last PUBLIC agent comment (what the customer sees) and
 * since the last agent comment of any kind (whether anyone is working it).
 * Where they diverge, someone is engaged and the customer does not know it.
 */
router.get('/open/updates', cacheMiddleware(120), async (req, res) => {
    try {
        const includeAlarms = req.query.includeAlarms === 'true';
        const includeInternal = req.query.includeInternal === 'true';
        const limit = Math.min(200, parseInt(req.query.limit || '100', 10));

        // The internal organisation is excluded by default: its tickets are
        // long-running projects, not customer commitments.
        const INTERNAL_ORG = '17207780343319';

        const filters = [
            `t.status NOT IN ('solved','closed','deleted')`,
            includeAlarms ? null : `NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)`,
            // A ticket with no organisation has no customer waiting on it —
            // 117541 was internal onboarding that the intlx-org exclusion
            // missed because the field was empty rather than set.
            includeInternal ? null : `t.organization_id IS NOT NULL AND t.organization_id <> ${INTERNAL_ORG}`
        ].filter(Boolean).join(' AND ');

        const rows = await query(`
            SELECT
                t.id,
                t.subject,
                t.priority,
                t.organization_name,
                t.assignee_name,
                cs.last_public_agent_at,
                cs.last_agent_at,
                cs.public_agent_comment_count,
                tg.update_interval_minutes AS target_minutes,
                COALESCE(b.ball_with, 'intlx') AS ball_with,
                cs.synced_at,

                ROUND(EXTRACT(EPOCH FROM (now() - cs.last_public_agent_at)) / 60)::int
                    AS minutes_since_public,
                ROUND(EXTRACT(EPOCH FROM (now() - cs.last_agent_at)) / 60)::int
                    AS minutes_since_agent,

                -- An internal note more recent than the last public comment
                -- means the ticket is being worked and the customer has not
                -- been told. That is a nudge, not neglect.
                (cs.last_agent_at > cs.last_public_agent_at) AS internal_only_since,

                -- A customer who has heard nothing at all is in a worse
                -- position than one who heard something a month ago.
                (cs.last_public_agent_at IS NULL) AS never_updated

            FROM ticket_comment_summary cs
            JOIN tickets t ON t.id = cs.ticket_id
            LEFT JOIN custom_statuses cust ON cust.id = t.custom_status_id
            LEFT JOIN sla_category_behaviour b
                   ON b.status_category = CASE
                        WHEN t.status IN ('closed','deleted') THEN t.status
                        ELSE COALESCE(cust.status_category, t.status)
                      END
            LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority, 'normal')
            WHERE ${filters}
              AND (
                cs.last_public_agent_at IS NULL
                OR EXTRACT(EPOCH FROM (now() - cs.last_public_agent_at)) / 60
                     > tg.update_interval_minutes
              )
            -- Never-updated first, then longest-silent. A customer who has
            -- heard nothing at all is a worse position than one who heard
            -- something a month ago, and sorting by timestamp alone buries the
            -- distinction behind a blank cell.
            ORDER BY (cs.last_public_agent_at IS NULL) DESC,
                     cs.last_public_agent_at ASC
            LIMIT $1
        `, [limit]);

        const summary = await query(`
            SELECT
                COUNT(*)::int AS open_tickets,
                COUNT(*) FILTER (WHERE cs.last_public_agent_at IS NULL)::int AS never_updated,
                COUNT(*) FILTER (
                    WHERE cs.last_public_agent_at IS NULL
                       OR EXTRACT(EPOCH FROM (now() - cs.last_public_agent_at)) / 60
                            > tg.update_interval_minutes
                )::int AS overdue,
                COUNT(*) FILTER (WHERE cs.last_agent_at > cs.last_public_agent_at)::int
                    AS internal_only_since,
                MIN(cs.synced_at) AS oldest_sync
            FROM ticket_comment_summary cs
            JOIN tickets t ON t.id = cs.ticket_id
            LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority, 'normal')
            WHERE ${filters}
        `);

        const s = summary.rows[0];
        res.json({
            tickets: rows.rows,
            summary: {
                ...s,
                compliance_pct: s.open_tickets > 0
                    ? Math.round(((s.open_tickets - s.overdue) / s.open_tickets) * 1000) / 10
                    : null
            },
            excluded: {
                alarms: !includeAlarms,
                internal: !includeInternal
            },
            as_of: new Date().toISOString(),
            note: 'Open tickets only. Comment history is synced for open tickets, so this is a current view rather than a trend.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/groups/performance
 *
 * The same view as /agents/performance, aggregated by Zendesk group —
 * Triage, Support, Engineering and the rest. Groups do very different work,
 * so comparing an agent against the company average is less useful than
 * comparing a team against its own history.
 *
 * Automation accounts are excluded here too: a bot's tickets belong to a
 * group, and including them would inflate whichever team owns alarm triage.
 */
router.get('/groups/performance', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters, { asFragment: true });

        const result = await query(`
            WITH scoped AS (
                SELECT
                    t.group_id,
                    t.billable_time_minutes,
                    t.billed_minutes,
                    t.is_billable,
                    t.reply_count,
                    t.assignee_id,
                    (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk) AS is_alarm,
                    s.status,
                    s.response_met,
                    s.resolution_met,
                    s.first_reply_minutes,
                    s.resolution_adjusted_minutes
                FROM tickets_billed t
                JOIN tickets_sla s ON s.id = t.id
                WHERE t.group_id IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM automation_accounts a WHERE a.agent_id = t.assignee_id
                  )
                  ${whereClause}
            )
            SELECT
                sc.group_id,
                COALESCE(g.name, 'Group ' || sc.group_id) AS group_name,

                COUNT(*)::int AS total_tickets,
                COUNT(*) FILTER (WHERE NOT is_alarm)::int AS human_tickets,
                COUNT(*) FILTER (WHERE is_alarm)::int AS alarm_tickets,
                -- Roster, not activity: counting distinct assignees reported
                -- "Support: 1 agent" for a group of eleven, because ten of them
                -- took no tickets. Membership is the honest denominator.
                (SELECT COUNT(*)::int FROM group_memberships gm
                  WHERE gm.group_id = sc.group_id
                    AND NOT EXISTS (
                      SELECT 1 FROM automation_accounts aa
                       WHERE aa.agent_id = gm.agent_id
                    )) AS agents,
                COUNT(DISTINCT assignee_id)::int AS agents_active,
                COUNT(*) FILTER (WHERE status IN ('solved','closed'))::int AS resolved_tickets,

                ROUND((SUM(billable_time_minutes) / 60.0)::numeric, 1) AS actual_hours,
                ROUND((COALESCE(SUM(billed_minutes), 0) / 60.0)::numeric, 1) AS billed_hours,

                ROUND(100.0 * COUNT(*) FILTER (
                        WHERE NOT is_alarm AND status IN ('solved','closed')
                          AND COALESCE(reply_count, 0) <= 1)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND status IN ('solved','closed')), 0), 1)
                    AS one_touch_pct,
                ROUND(AVG(reply_count) FILTER (WHERE NOT is_alarm AND status IN ('solved','closed')), 1)
                    AS avg_replies,

                ROUND(AVG(first_reply_minutes) FILTER (WHERE NOT is_alarm)) AS avg_first_reply_minutes,
                ROUND(AVG(resolution_adjusted_minutes) FILTER (WHERE NOT is_alarm)) AS avg_resolution_minutes,

                ROUND(100.0 * COUNT(*) FILTER (WHERE NOT is_alarm AND response_met)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND response_met IS NOT NULL), 0), 1)
                    AS response_compliance,
                ROUND(100.0 * COUNT(*) FILTER (WHERE NOT is_alarm AND resolution_met)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND resolution_met IS NOT NULL), 0), 1)
                    AS resolution_compliance

            FROM scoped sc
            LEFT JOIN groups g ON g.id = sc.group_id
            GROUP BY sc.group_id, g.name
            ORDER BY COUNT(*) DESC
        `, params);

        res.json({
            groups: result.rows,
            count: result.rows.length,
            note: 'Automation accounts excluded. Touch and SLA figures cover human-originated tickets only.'
        });
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

/**
 * GET /api/analytics/organizations/summary
 *
 * Per-organization view for quarterly reviews: total workload, what share is
 * billable, and the SLA experience that client actually had.
 *
 * SLA figures cover human-originated tickets only. An org whose volume is
 * mostly alarms would otherwise show near-perfect compliance that reflects
 * automation rather than the service they experienced.
 */
router.get('/organizations/summary', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters, { asFragment: true });

        const result = await query(`
            WITH scoped AS (
                SELECT
                    t.organization_id,
                    t.organization_name,
                    t.is_billable,
                    t.billable_time_minutes,
                    t.billed_minutes,
                    (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk) AS is_alarm,
                    s.status,
                    s.response_met,
                    s.resolution_met,
                    s.first_reply_minutes,
                    s.resolution_adjusted_minutes
                FROM tickets_billed t
                JOIN tickets_sla s ON s.id = t.id
                WHERE t.organization_id IS NOT NULL
                ${whereClause}
            )
            SELECT
                organization_id,
                organization_name,

                COUNT(*)::int AS total_tickets,
                COUNT(*) FILTER (WHERE NOT is_alarm)::int AS human_tickets,
                COUNT(*) FILTER (WHERE is_alarm)::int AS alarm_tickets,
                COUNT(*) FILTER (WHERE status IN ('solved','closed'))::int AS resolved_tickets,
                COUNT(*) FILTER (WHERE is_billable)::int AS billable_tickets,

                ROUND((SUM(billable_time_minutes) / 60.0)::numeric, 1) AS actual_hours,
                ROUND((SUM(billed_minutes) / 60.0)::numeric, 1) AS billed_hours,

                -- The share of tracked time that is chargeable. In a QBR this
                -- is the number that quantifies contract coverage: hours spent
                -- on the client that the client is not billed for.
                -- COALESCE the numerator: with no billable tickets the FILTER
                -- yields null, and null/x is null — which renders as "—" when
                -- the honest answer is 0%.
                ROUND((100.0 * COALESCE(SUM(billable_time_minutes) FILTER (WHERE is_billable), 0)
                       / NULLIF(SUM(billable_time_minutes), 0))::numeric, 1) AS billable_pct,

                ROUND(AVG(first_reply_minutes) FILTER (WHERE NOT is_alarm)) AS avg_first_reply_minutes,
                ROUND(AVG(resolution_adjusted_minutes) FILTER (WHERE NOT is_alarm)) AS avg_resolution_minutes,

                ROUND(100.0 * COUNT(*) FILTER (WHERE NOT is_alarm AND response_met)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND response_met IS NOT NULL), 0), 1)
                    AS response_compliance,
                ROUND(100.0 * COUNT(*) FILTER (WHERE NOT is_alarm AND resolution_met)
                      / NULLIF(COUNT(*) FILTER (WHERE NOT is_alarm AND resolution_met IS NOT NULL), 0), 1)
                    AS resolution_compliance

            FROM scoped
            GROUP BY organization_id, organization_name
            ORDER BY SUM(billable_time_minutes) DESC NULLS LAST
            LIMIT 200
        `, params);

        res.json({
            organizations: result.rows,
            count: result.rows.length,
            note: 'SLA figures cover human-originated tickets only.'
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
    const dateField = dateFilterType === 'solved' ? 'solved_at' : 'created_at';
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
        t.solved_at,
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
      id: 't.id', created_at: 't.created_at', updated_at: 't.updated_at', solved_at: 't.solved_at',
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
                t.*
            FROM tickets t
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
        
        // Get all groups. Names come from the groups table, not from
        // tickets: the ticket sync writes group_id and never group_name,
        // so that column is null on every row. The scorecard's subjects
        // CTE has always read from groups - this brings the filter list
        // into line with it.
        const groups = await query(`
            SELECT g.id::text as id, g.name
            FROM groups g
            WHERE g.deleted IS NOT TRUE
              AND EXISTS (SELECT 1 FROM tickets t WHERE t.group_id = g.id)
            ORDER BY g.name
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

/**
 * GET /api/analytics/reports/agent-time
 *
 * Time logged per agent, from ticket_time_entries — per-event deltas keyed to
 * the user who made the update, not the ticket's assignee. Two agents working
 * one ticket are credited separately, which assignee-based attribution cannot
 * do.
 *
 * Filtered on when the time was LOGGED (created_at on the entry), not when the
 * ticket was created. A timesheet question is "what did we log last week",
 * regardless of when those tickets opened.
 *
 * ?detail=true adds the per-ticket breakdown under each agent.
 */
router.get('/reports/agent-time', cacheMiddleware(300), async (req, res) => {
    try {
        const { startDate, endDate, agentId, detail } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).json({
                error: 'startDate and endDate are required',
                message: 'A time report without a period is not meaningful.'
            });
        }

        // endDate is inclusive of the whole day: a report "to 2026-08-04"
        // should include time logged that afternoon.
        const params = [startDate, `${String(endDate).slice(0, 10)}T23:59:59.999Z`];
        let agentClause = '';
        if (agentId) {
            params.push(agentId);
            agentClause = `AND te.agent_id = $${params.length}`;
        }

        const summary = await query(`
            SELECT
                te.agent_id,
                COALESCE(a.name, 'Unknown (' || te.agent_id || ')') AS agent_name,
                COUNT(*)::int AS entries,
                COUNT(DISTINCT te.ticket_id)::int AS tickets,
                ROUND((SUM(te.time_seconds) / 3600.0)::numeric, 2) AS hours,
                -- COALESCE so "none of this was billable" reads as 0.00 rather
                -- than as missing data. Those are different claims.
                ROUND((COALESCE(SUM(te.time_seconds) FILTER (WHERE t.is_billable), 0) / 3600.0)::numeric, 2)
                    AS billable_hours,
                MIN(te.created_at)::date AS first_entry,
                MAX(te.created_at)::date AS last_entry
            FROM ticket_time_entries te
            LEFT JOIN agents a ON a.id = te.agent_id
            LEFT JOIN tickets t ON t.id = te.ticket_id
            WHERE te.created_at >= $1 AND te.created_at <= $2
              AND te.agent_id IS NOT NULL
              ${agentClause}
            GROUP BY te.agent_id, a.name
            ORDER BY SUM(te.time_seconds) DESC
        `, params);

        let tickets = [];
        if (detail === 'true' || detail === '1') {
            // One row per agent per ticket. A ticket worked by two people
            // appears twice, with each person's own time — which is the point.
            const rows = await query(`
                SELECT
                    te.agent_id,
                    COALESCE(a.name, 'Unknown') AS agent_name,
                    te.ticket_id,
                    t.subject,
                    t.status,
                    t.organization_name,
                    t.is_billable,
                    COUNT(*)::int AS entries,
                    ROUND((SUM(te.time_seconds) / 3600.0)::numeric, 2) AS hours,
                    MAX(te.created_at) AS last_logged
                FROM ticket_time_entries te
                LEFT JOIN agents a ON a.id = te.agent_id
                LEFT JOIN tickets t ON t.id = te.ticket_id
                WHERE te.created_at >= $1 AND te.created_at <= $2
                  AND te.agent_id IS NOT NULL
                  ${agentClause}
                GROUP BY te.agent_id, a.name, te.ticket_id, t.subject, t.status,
                         t.organization_name, t.is_billable
                ORDER BY SUM(te.time_seconds) DESC
                LIMIT 5000
            `, params);
            tickets = rows.rows;
        }

        const totals = summary.rows.reduce((acc, r) => {
            acc.hours += parseFloat(r.hours || 0);
            acc.billable_hours += parseFloat(r.billable_hours || 0);
            acc.entries += r.entries;
            return acc;
        }, { hours: 0, billable_hours: 0, entries: 0 });

        res.json({
            agents: summary.rows,
            tickets,
            totals: {
                agents: summary.rows.length,
                entries: totals.entries,
                hours: Math.round(totals.hours * 100) / 100,
                billable_hours: Math.round(totals.billable_hours * 100) / 100
            },
            period: { startDate, endDate },
            note: 'Time attributed to the agent who logged it, not the ticket assignee.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/ops/dashboard
 *
 * The Monday operations view: three periods side by side, all groups with an
 * optional filter.
 *
 * Periods are fixed rather than driven by the date filter — this is a screen
 * to present from, and "last week vs month vs year" is the comparison that
 * makes a trend visible.
 *
 * Compliance is measured on HUMAN tickets against the published targets in
 * sla_targets. Alarm tickets auto-resolve and would push every figure toward
 * 100%, describing automation rather than service.
 */
router.get('/ops/dashboard', cacheMiddleware(300), async (req, res) => {
    try {
        const groupIds = req.query.groupIds
            ? String(req.query.groupIds).split(',').map(g => g.trim()).filter(Boolean)
            : null;

        // The intlx work week runs Saturday to Friday, so last week is the
        // seven days ending on the most recent Friday. Postgres date_trunc
        // assumes Monday, hence the explicit arithmetic.
        const periods = `
            WITH bounds AS (
                SELECT
                    -- Most recent Saturday, then back one week.
                    (CURRENT_DATE - ((EXTRACT(DOW FROM CURRENT_DATE)::int + 1) % 7) - 7) AS last_week_start,
                    (CURRENT_DATE - ((EXTRACT(DOW FROM CURRENT_DATE)::int + 1) % 7) - 1) AS last_week_end,
                    date_trunc('month', CURRENT_DATE)::date AS month_start,
                    date_trunc('year',  CURRENT_DATE)::date AS year_start,
                    CURRENT_DATE AS today
            )`;

        const groupClause = groupIds
            ? `AND t.group_id = ANY($1::bigint[])`
            : '';
        const params = groupIds ? [groupIds] : [];

        // One pass per period. Written as a lateral over the three windows so
        // the period definitions live in one place rather than being repeated.
        const result = await query(`
            ${periods},
            windows AS (
                SELECT 'last_week' AS period, last_week_start AS from_date, last_week_end AS to_date, 1 AS ord FROM bounds
                UNION ALL
                SELECT 'month_to_date', month_start, today, 2 FROM bounds
                UNION ALL
                SELECT 'year_to_date',  year_start,  today, 3 FROM bounds
            )
            SELECT
                w.period,
                w.from_date,
                w.to_date,

                -- Created in the window, on creation date.
                (SELECT COUNT(*) FROM tickets t
                  WHERE t.created_at >= w.from_date AND t.created_at < w.to_date + interval '1 day'
                    ${groupClause})::int AS created,

                -- Solved in the window, on solve date — a ticket opened in June
                -- and closed in July counts toward July.
                (SELECT COUNT(*) FROM tickets t
                  WHERE t.solved_at >= w.from_date AND t.solved_at < w.to_date + interval '1 day'
                    ${groupClause})::int AS solved,

                    (SELECT COUNT(*) FROM tickets t
                  WHERE t.created_at >= w.from_date AND t.created_at < w.to_date + interval '1 day'
                    AND (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause})::int AS created_alarm,

                (SELECT COUNT(*) FROM tickets t
                  WHERE t.created_at >= w.from_date AND t.created_at < w.to_date + interval '1 day'
                    AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause})::int AS created_human,

                -- Human-only compliance against the published targets.
                (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE s.response_met)
                        / NULLIF(COUNT(*) FILTER (WHERE s.response_met IS NOT NULL), 0), 1)
                   FROM tickets t JOIN tickets_sla s ON s.id = t.id
                  WHERE t.solved_at >= w.from_date AND t.solved_at < w.to_date + interval '1 day'
                    AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause}) AS response_compliance,

                -- Same metric across every ticket. Alarms auto-resolve and push
                -- compliance toward 100%, so this figure describes automation
                -- more than service — but it is what a whole-queue view means,
                -- and the gap between the two is worth being able to see.
                (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE s.response_met)
                        / NULLIF(COUNT(*) FILTER (WHERE s.response_met IS NOT NULL), 0), 1)
                   FROM tickets t JOIN tickets_sla s ON s.id = t.id
                  WHERE t.solved_at >= w.from_date AND t.solved_at < w.to_date + interval '1 day'
                    ${groupClause}) AS response_compliance_all,

                (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE s.resolution_met)
                        / NULLIF(COUNT(*) FILTER (WHERE s.resolution_met IS NOT NULL), 0), 1)
                   FROM tickets t JOIN tickets_sla s ON s.id = t.id
                  WHERE t.solved_at >= w.from_date AND t.solved_at < w.to_date + interval '1 day'
                    AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause}) AS resolution_compliance,

                    (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE s.resolution_met)
                        / NULLIF(COUNT(*) FILTER (WHERE s.resolution_met IS NOT NULL), 0), 1)
                   FROM tickets t JOIN tickets_sla s ON s.id = t.id
                  WHERE t.solved_at >= w.from_date AND t.solved_at < w.to_date + interval '1 day'
                    ${groupClause}) AS resolution_compliance_all,

                -- Both one-touch figures. Including alarms matches the existing
                -- slide; excluding them describes human work. The gap between
                -- the two is itself worth seeing.
                (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(t.reply_count,0) <= 1)
                        / NULLIF(COUNT(*), 0), 1)
                   FROM tickets t
                  WHERE t.solved_at >= w.from_date AND t.solved_at < w.to_date + interval '1 day'
                    ${groupClause}) AS one_touch_all,

                (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(t.reply_count,0) <= 1)
                        / NULLIF(COUNT(*), 0), 1)
                   FROM tickets t
                  WHERE t.solved_at >= w.from_date AND t.solved_at < w.to_date + interval '1 day'
                    AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause}) AS one_touch_human,

                -- Requester wait time against the same targets. Synced already,
                -- just never reported.
                (SELECT ROUND(100.0 * COUNT(*) FILTER (
                          WHERE t.requester_wait_time_minutes <= tg.resolution_minutes)
                        / NULLIF(COUNT(*) FILTER (WHERE t.requester_wait_time_minutes IS NOT NULL), 0), 1)
                   FROM tickets t
                   LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority,'normal')
                  WHERE t.solved_at >= w.from_date AND t.solved_at < w.to_date + interval '1 day'
                    AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause}) AS wait_time_compliance,

                    (SELECT ROUND(100.0 * COUNT(*) FILTER (
                          WHERE t.requester_wait_time_minutes <= tg.resolution_minutes)
                        / NULLIF(COUNT(*) FILTER (WHERE t.requester_wait_time_minutes IS NOT NULL), 0), 1)
                   FROM tickets t
                   LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority,'normal')
                  WHERE t.solved_at >= w.from_date AND t.solved_at < w.to_date + interval '1 day'
                    ${groupClause}) AS wait_time_compliance_all,

                    -- Periodic update: gaps between consecutive PUBLIC agent
                -- comments against the update target for the ticket's
                -- priority. Met/(Met+Breached) over intervals, which is the
                -- same shape Explore uses.
                --
                -- Attributed to the month the LATER comment falls in, so an
                -- interval that closes in July counts toward July regardless
                -- of when it opened.
                (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE g.gap_min <= g.target)
                        / NULLIF(COUNT(*), 0), 1)
                   FROM (
                     SELECT EXTRACT(EPOCH FROM (p.created_at - p.prev)) / 60 AS gap_min,
                            tg.update_interval_minutes AS target
                       FROM (
                         SELECT ticket_id, created_at,
                                LAG(created_at) OVER (
                                  PARTITION BY ticket_id ORDER BY created_at
                                ) AS prev
                           FROM ticket_public_comments
                          WHERE is_public
                       ) p
                       JOIN tickets t ON t.id = p.ticket_id
                       LEFT JOIN sla_targets tg
                              ON tg.priority = COALESCE(t.priority, 'normal')
                      WHERE p.prev IS NOT NULL
                        AND p.created_at >= w.from_date AND p.created_at < w.to_date + interval '1 day'
                        AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                        ${groupClause}
                   ) g) AS update_compliance,

                -- Same metric across every ticket. Alarms receive bulk updates
                -- that clear the target easily — 79.0% against 67.8% for human
                -- work last week — so this describes automation more than
                -- customer communication. Returned so the two can be compared
                -- rather than conflated.
                (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE g.gap_min <= g.target)
                        / NULLIF(COUNT(*), 0), 1)
                   FROM (
                     SELECT EXTRACT(EPOCH FROM (p.created_at - p.prev)) / 60 AS gap_min,
                            tg.update_interval_minutes AS target
                       FROM (
                         SELECT ticket_id, created_at,
                                LAG(created_at) OVER (
                                  PARTITION BY ticket_id ORDER BY created_at
                                ) AS prev
                           FROM ticket_public_comments
                          WHERE is_public
                       ) p
                       JOIN tickets t ON t.id = p.ticket_id
                       LEFT JOIN sla_targets tg
                              ON tg.priority = COALESCE(t.priority, 'normal')
                      WHERE p.prev IS NOT NULL
                        AND p.created_at >= w.from_date AND p.created_at < w.to_date + interval '1 day'
                        ${groupClause}
                   ) g) AS update_compliance_all

            FROM windows w
            ORDER BY w.ord
        `, params);

        // Backlog is a current-state number, not a per-period one: open tickets
        // right now, regardless of when they arrived.
        const backlog = await query(`
            SELECT COUNT(*)::int AS open_tickets
              FROM tickets t
             WHERE t.status NOT IN ('solved','closed','deleted')
               ${groupClause}
        `, params);

        const goals = await query(`SELECT metric, target_pct, label FROM ops_goals`);

        const groups = await query(`
            SELECT g.id, g.name, COUNT(t.id)::int AS tickets
              FROM groups g
              LEFT JOIN tickets t ON t.group_id = g.id
                   AND t.created_at > CURRENT_DATE - INTERVAL '90 days'
             GROUP BY g.id, g.name
             ORDER BY COUNT(t.id) DESC
        `);

        res.json({
            periods: result.rows,
            backlog: backlog.rows[0].open_tickets,
            goals: goals.rows,
            groups: groups.rows,
            not_measured: [],

            // The audit stream retains about four months in full; before that
            // it returns a handful of tickets a month. A year-to-date update
            // figure would blend four solid months with eight sparse ones, so
            // the UI hides that column rather than showing a number nobody
            // could defend.
            data_from: {
                update_compliance: '2025-08-01'
            },
            as_of: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/ops/trend
 *
 * Twelve months of each headline metric, for sparklines beside the current
 * figures. A single arrow says "down"; a shape says how far and how steadily.
 *
 * Update compliance carries its own coverage floor — the comment history does
 * not reach as far back as the ticket fields do — so its series starts later
 * than the others rather than showing a misleading tail.
 */
router.get('/ops/trend', cacheMiddleware(600), async (req, res) => {
    try {
        const groupIds = req.query.groupIds
            ? String(req.query.groupIds).split(',').map(g => g.trim()).filter(Boolean)
            : null;
        const groupClause = groupIds ? `AND t.group_id = ANY($1::bigint[])` : '';
        const params = groupIds ? [groupIds] : [];

        const result = await query(`
            WITH months AS (
                SELECT generate_series(
                    date_trunc('month', CURRENT_DATE) - interval '11 months',
                    date_trunc('month', CURRENT_DATE),
                    interval '1 month'
                )::date AS month_start
            ),
            windows AS (
                SELECT month_start,
                       (month_start + interval '1 month' - interval '1 day')::date AS month_end
                  FROM months
            )
            SELECT
                to_char(w.month_start, 'YYYY-MM') AS month,

                (SELECT COUNT(*) FROM tickets t
                  WHERE t.created_at >= w.month_start AND t.created_at < w.month_end + interval '1 day'
                    ${groupClause})::int AS created,

                (SELECT COUNT(*) FROM tickets t
                  WHERE t.solved_at >= w.month_start AND t.solved_at < w.month_end + interval '1 day'
                    ${groupClause})::int AS solved,

                    (SELECT COUNT(*) FROM tickets t
                  WHERE t.created_at >= w.month_start AND t.created_at < w.month_end + interval '1 day'
                    AND (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause})::int AS created_alarm,

                (SELECT COUNT(*) FROM tickets t
                  WHERE t.created_at >= w.month_start AND t.created_at < w.month_end + interval '1 day'
                    AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause})::int AS created_human,

                (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE s.response_met)
                        / NULLIF(COUNT(*) FILTER (WHERE s.response_met IS NOT NULL), 0), 1)
                   FROM tickets t JOIN tickets_sla s ON s.id = t.id
                  WHERE t.solved_at >= w.month_start AND t.solved_at < w.month_end + interval '1 day'
                    AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause}) AS response_compliance,

                (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE s.resolution_met)
                        / NULLIF(COUNT(*) FILTER (WHERE s.resolution_met IS NOT NULL), 0), 1)
                   FROM tickets t JOIN tickets_sla s ON s.id = t.id
                  WHERE t.solved_at >= w.month_start AND t.solved_at < w.month_end + interval '1 day'
                    AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause}) AS resolution_compliance,

                (SELECT ROUND(100.0 * COUNT(*) FILTER (
                          WHERE t.requester_wait_time_minutes <= tg.resolution_minutes)
                        / NULLIF(COUNT(*) FILTER (WHERE t.requester_wait_time_minutes IS NOT NULL), 0), 1)
                   FROM tickets t
                   LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority,'normal')
                  WHERE t.solved_at >= w.month_start AND t.solved_at < w.month_end + interval '1 day'
                    AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause}) AS wait_time_compliance,

                (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(t.reply_count,0) <= 1)
                        / NULLIF(COUNT(*), 0), 1)
                   FROM tickets t
                  WHERE t.solved_at >= w.month_start AND t.solved_at < w.month_end + interval '1 day'
                    AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                    ${groupClause}) AS one_touch_human,

                (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE g.gap_min <= g.target)
                        / NULLIF(COUNT(*), 0), 1)
                   FROM (
                     SELECT EXTRACT(EPOCH FROM (p.created_at - p.prev)) / 60 AS gap_min,
                            tg.update_interval_minutes AS target
                       FROM (
                         SELECT ticket_id, created_at,
                                LAG(created_at) OVER (
                                  PARTITION BY ticket_id ORDER BY created_at
                                ) AS prev
                           FROM ticket_public_comments WHERE is_public
                       ) p
                       JOIN tickets t ON t.id = p.ticket_id
                       LEFT JOIN sla_targets tg
                              ON tg.priority = COALESCE(t.priority,'normal')
                      WHERE p.prev IS NOT NULL
                        AND p.created_at >= w.month_start AND p.created_at < w.month_end + interval '1 day'
                        AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                        ${groupClause}
                   ) g) AS update_compliance

            FROM windows w
            ORDER BY w.month_start
        `, params);

        // The comment history is thinner than the ticket fields, so a month
        // with a handful of intervals would render as a wild swing in the
        // sparkline. Below this count the point is dropped rather than drawn.
        const MIN_INTERVALS = 50;
        const coverage = await query(`
            SELECT to_char(created_at, 'YYYY-MM') AS month, COUNT(*)::int AS comments
              FROM ticket_public_comments
             WHERE is_public
               AND created_at >= date_trunc('month', CURRENT_DATE) - interval '11 months'
             GROUP BY 1
        `);
        const thin = new Set(
            coverage.rows.filter(r => r.comments < MIN_INTERVALS).map(r => r.month)
        );

        res.json({
            months: result.rows.map(r => ({
                ...r,
                comp_pct: r.created > 0
                    ? Math.round((r.solved / r.created) * 1000) / 10
                    : null,
                // Nulled rather than omitted so the series stays twelve points
                // long and the sparkline x-axis does not shift under it.
                update_compliance: thin.has(r.month) ? null : r.update_compliance
            })),
            as_of: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/ops/attention
 *
 * The Monday list. Each entry is a category with a count, a handful of
 * examples, and a filter the UI can hand to another tab.
 *
 * Deliberately not a single query: these are five unrelated questions and
 * expressing them as one would need a union that nobody could read or amend.
 */
router.get('/ops/attention', cacheMiddleware(120), async (req, res) => {
    try {
        const INTERNAL_ORG = '17207780343319';
        const humanOnly = `NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)`;
        const realCustomer = `t.organization_id IS NOT NULL AND t.organization_id <> ${INTERNAL_ORG}`;

        // Never had a public agent comment. The customer opened a request and
        // has heard nothing at all, which is worse than going quiet later.
        const neverUpdated = await query(`
            SELECT t.id, t.subject, t.organization_name, t.assignee_name,
                   (CURRENT_DATE - t.created_at::date) AS days_open
              FROM tickets t
              JOIN ticket_comment_summary cs ON cs.ticket_id = t.id
             WHERE t.status NOT IN ('solved','closed','deleted')
               AND cs.last_public_agent_at IS NULL
               AND ${humanOnly} AND ${realCustomer}
             ORDER BY t.created_at
             LIMIT 10
        `);

        // Unassigned and urgent: belongs to nobody, and the priority says it
        // cannot wait for someone to notice.
        const unassigned = await query(`
            SELECT t.id, t.subject, t.organization_name, t.priority,
                   (CURRENT_DATE - t.created_at::date) AS days_open
              FROM tickets t
             WHERE t.status NOT IN ('solved','closed','deleted')
               AND t.assignee_id IS NULL
               AND t.priority IN ('urgent','high')
             ORDER BY t.created_at
             LIMIT 10
        `);

        // Past resolution target and nobody else is blocking.
        const overdueOurs = await query(`
            SELECT t.id, t.subject, t.organization_name, t.assignee_name, t.priority,
                   ROUND(EXTRACT(EPOCH FROM (now() - t.created_at)) / 3600)::int AS hours_open,
                   tg.resolution_minutes
              FROM tickets t
              LEFT JOIN custom_statuses cs ON cs.id = t.custom_status_id
              LEFT JOIN sla_category_behaviour b
                     ON b.status_category = CASE
                          WHEN t.status IN ('closed','deleted') THEN t.status
                          ELSE COALESCE(cs.status_category, t.status)
                        END
              LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority,'normal')
             WHERE t.status NOT IN ('solved','closed','deleted')
               AND COALESCE(b.ball_with, 'intlx') = 'intlx'
               AND t.priority IN ('urgent','high')
               AND EXTRACT(EPOCH FROM (now() - t.created_at)) / 60 > tg.resolution_minutes
               AND ${humanOnly}
             ORDER BY t.created_at
             LIMIT 10
        `);

        // Overdue for a customer update. Split out the ones with a recent
        // internal note — somebody is working those, they just have not said
        // so, which is a nudge rather than neglect.
        const staleUpdates = await query(`
            SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE cs.last_agent_at > cs.last_public_agent_at)::int
                     AS internal_only
              FROM tickets t
              JOIN ticket_comment_summary cs ON cs.ticket_id = t.id
              LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority,'normal')
             WHERE t.status NOT IN ('solved','closed','deleted')
               AND ${humanOnly} AND ${realCustomer}
               AND cs.last_public_agent_at IS NOT NULL
               AND EXTRACT(EPOCH FROM (now() - cs.last_public_agent_at)) / 60
                     > tg.update_interval_minutes
        `);

        const vendorBlocked = await query(`
            SELECT COUNT(*)::int AS total
              FROM tickets t
              LEFT JOIN custom_statuses cs ON cs.id = t.custom_status_id
              LEFT JOIN sla_category_behaviour b
                     ON b.status_category = CASE
                          WHEN t.status IN ('closed','deleted') THEN t.status
                          ELSE COALESCE(cs.status_category, t.status)
                        END
             WHERE t.status NOT IN ('solved','closed','deleted')
               AND b.ball_with = 'vendor'
        `);

        res.json({
            items: [
                {
                    key: 'never_updated',
                    label: 'Never updated',
                    detail: 'Customer has heard nothing at all',
                    severity: 'high',
                    count: neverUpdated.rowCount,
                    examples: neverUpdated.rows
                },
                {
                    key: 'unassigned',
                    label: 'Unassigned & urgent',
                    detail: 'Nobody owns these',
                    severity: 'high',
                    count: unassigned.rowCount,
                    examples: unassigned.rows
                },
                {
                    key: 'overdue_ours',
                    label: 'Past resolution target',
                    detail: 'Urgent or high, awaiting intlx',
                    severity: 'medium',
                    count: overdueOurs.rowCount,
                    examples: overdueOurs.rows
                },
                {
                    key: 'stale_updates',
                    label: 'Overdue for a customer update',
                    detail: `${staleUpdates.rows[0].internal_only} have an internal note since — a nudge, not neglect`,
                    severity: 'medium',
                    count: staleUpdates.rows[0].total,
                    examples: []
                },
                {
                    key: 'vendor_blocked',
                    label: 'Blocked on a vendor',
                    detail: 'Not ours to move, worth chasing',
                    severity: 'low',
                    count: vendorBlocked.rows[0].total,
                    examples: []
                }
            ].filter(i => i.count > 0),
            as_of: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/ops/distribution
 *
 * First reply percentiles per priority, for the box plot.
 *
 * The compliance rate alone cannot distinguish "uniformly slow" from "fast
 * with a bad tail", and those need different responses. Every tier's median
 * sits inside target while every p90 sits well outside — which points at
 * alerting rather than staffing.
 */
router.get('/ops/distribution', cacheMiddleware(600), async (req, res) => {
    try {
        const days = Math.min(365, parseInt(req.query.days || '90', 10));
        const groupIds = req.query.groupIds
            ? String(req.query.groupIds).split(',').map(g => g.trim()).filter(Boolean)
            : null;
        const params = [days];
        let groupClause = '';
        if (groupIds) {
            params.push(groupIds);
            groupClause = `AND t.group_id = ANY($${params.length}::bigint[])`;
        }

        const result = await query(`
            SELECT
                COALESCE(t.priority, 'normal') AS priority,
                tg.label AS priority_label,
                tg.response_minutes AS target,
                COUNT(*)::int AS tickets,
                ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY t.first_reply_minutes))::int AS p25,
                ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY t.first_reply_minutes))::int AS p50,
                ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY t.first_reply_minutes))::int AS p75,
                ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY t.first_reply_minutes))::int AS p90,
                ROUND(100.0 * COUNT(*) FILTER (WHERE t.first_reply_minutes <= tg.response_minutes)
                      / NULLIF(COUNT(*), 0), 1) AS compliance
            FROM tickets t
            LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority, 'normal')
            WHERE t.first_reply_minutes IS NOT NULL
              AND t.solved_at > now() - ($1 || ' days')::interval
              AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
              ${groupClause}
            GROUP BY 1, tg.label, tg.response_minutes
            ORDER BY tg.response_minutes
        `, params);

        res.json({ priorities: result.rows, days, as_of: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/sla/by-priority
 *
 * Every SLA metric broken out by priority, for the period the dashboard is
 * showing. An aggregate rate conceals which tier is actually failing.
 *
 * Update compliance is computed from comment intervals rather than ticket
 * fields, so it is a separate subquery joined on priority rather than another
 * column on the same scan.
 */
router.get('/sla/by-priority', cacheMiddleware(300), async (req, res) => {
    try {
        const period = req.query.period === 'year' ? 'year'
                     : req.query.period === 'month' ? 'month'
                     : 'week';
        const groupIds = req.query.groupIds
            ? String(req.query.groupIds).split(',').map(g => g.trim()).filter(Boolean)
            : null;

        // Same windows the dashboard uses, so the numbers reconcile with the
        // column the reader just looked at.
        const bounds = {
            week:  `(CURRENT_DATE - ((EXTRACT(DOW FROM CURRENT_DATE)::int + 1) % 7) - 7)
                    AND (CURRENT_DATE - ((EXTRACT(DOW FROM CURRENT_DATE)::int + 1) % 7) - 1)`,
            month: `date_trunc('month', CURRENT_DATE)::date AND CURRENT_DATE`,
            year:  `date_trunc('year', CURRENT_DATE)::date AND CURRENT_DATE`
        }[period];

        const params = [];
        let groupClause = '';
        if (groupIds) {
            params.push(groupIds);
            groupClause = `AND t.group_id = ANY($${params.length}::bigint[])`;
        }

        const result = await query(`
            WITH scoped AS (
                SELECT t.id, t.priority, t.group_id,
                       t.requester_wait_time_minutes, t.reply_count,
                       s.response_met, s.resolution_met
                  FROM tickets t
                  JOIN tickets_sla s ON s.id = t.id
                 WHERE t.solved_at::date BETWEEN ${bounds}
                   AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                   ${groupClause}
            ),
            updates AS (
                SELECT t.priority,
                       COUNT(*) FILTER (
                         WHERE EXTRACT(EPOCH FROM (p.created_at - p.prev)) / 60
                               <= tg.update_interval_minutes
                       )::int AS met,
                       COUNT(*)::int AS total
                  FROM (
                    SELECT ticket_id, created_at,
                           LAG(created_at) OVER (
                             PARTITION BY ticket_id ORDER BY created_at
                           ) AS prev
                      FROM ticket_public_comments WHERE is_public
                  ) p
                  JOIN tickets t ON t.id = p.ticket_id
                  LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority,'normal')
                 WHERE p.prev IS NOT NULL
                   AND p.created_at::date BETWEEN ${bounds}
                   AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                   ${groupClause}
                 GROUP BY t.priority
            )
            SELECT
                COALESCE(sc.priority, 'normal') AS priority,
                tg.label AS priority_label,
                COUNT(*)::int AS tickets,

                ROUND(100.0 * COUNT(*) FILTER (WHERE sc.response_met)
                      / NULLIF(COUNT(*) FILTER (WHERE sc.response_met IS NOT NULL), 0), 1)
                  AS response_compliance,

                ROUND(100.0 * COUNT(*) FILTER (WHERE sc.resolution_met)
                      / NULLIF(COUNT(*) FILTER (WHERE sc.resolution_met IS NOT NULL), 0), 1)
                  AS resolution_compliance,

                ROUND(100.0 * COUNT(*) FILTER (
                        WHERE sc.requester_wait_time_minutes <= tg.resolution_minutes)
                      / NULLIF(COUNT(*) FILTER (WHERE sc.requester_wait_time_minutes IS NOT NULL), 0), 1)
                  AS wait_time_compliance,

                ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(sc.reply_count,0) <= 1)
                      / NULLIF(COUNT(*), 0), 1) AS one_touch,

                MAX(u.met)::int AS update_met,
                MAX(u.total)::int AS update_total,
                ROUND(100.0 * MAX(u.met) / NULLIF(MAX(u.total), 0), 1) AS update_compliance

            FROM scoped sc
            LEFT JOIN sla_targets tg ON tg.priority = COALESCE(sc.priority, 'normal')
            LEFT JOIN updates u ON u.priority = sc.priority
            GROUP BY 1, tg.label, tg.response_minutes
            ORDER BY tg.response_minutes
        `, params);

        res.json({ priorities: result.rows, period, as_of: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/ops/improvements
 *
 * The curated "where can we improve" list, with a computed number and last
 * month's value for each.
 *
 * Curated rather than computed because the value is in the diagnosis. A query
 * can find the worst metric; it cannot work out that resolution compliance is
 * understated because nobody is recording on-hold time. The wording is
 * editable in ops_improvements; the numbers are not.
 */
router.get('/ops/improvements', cacheMiddleware(300), async (req, res) => {
    try {
        const { rows: items } = await query(`
            SELECT key, title, body, impact, metric_key, severity
              FROM ops_improvements
             WHERE active
             ORDER BY sort_order, key
        `);

        // Each metric returns { value, unit, detail, previous }. `previous` is
        // the equivalent figure a month back, so the item can show movement.
        const metrics = {};

        // Long-running tickets with no on-hold time recorded. Counted against
        // the resolution target for their priority.
        const onHold = await query(`
            SELECT
                COUNT(*)::int AS value,
                COUNT(*) FILTER (WHERE t.solved_at < date_trunc('month', CURRENT_DATE))::int
                    AS previous
              FROM tickets t
              LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority,'normal')
             WHERE t.resolution_minutes > tg.resolution_minutes
               AND COALESCE(t.on_hold_time_minutes, 0) = 0
               AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
        `);
        metrics.on_hold_unused = {
            value: onHold.rows[0].value,
            unit: 'tickets',
            detail: 'ran past target with no on-hold time recorded',
            previous: onHold.rows[0].previous
        };

        // Update compliance this month against last, plus how many open
        // tickets are overdue right now and how many of those have a recent
        // internal note.
        const upd = await query(`
            WITH pub AS (
                SELECT ticket_id, created_at,
                       LAG(created_at) OVER (
                         PARTITION BY ticket_id ORDER BY created_at
                       ) AS prev
                  FROM ticket_public_comments WHERE is_public
            ),
            gaps AS (
                SELECT p.created_at,
                       EXTRACT(EPOCH FROM (p.created_at - p.prev)) / 60 AS gap_min,
                       tg.update_interval_minutes AS target
                  FROM pub p
                  JOIN tickets t ON t.id = p.ticket_id
                  LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority,'normal')
                 WHERE p.prev IS NOT NULL
                   AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
            )
            SELECT
                ROUND(100.0 * COUNT(*) FILTER (
                        WHERE gap_min <= target
                          AND created_at >= date_trunc('month', CURRENT_DATE))
                      / NULLIF(COUNT(*) FILTER (
                        WHERE created_at >= date_trunc('month', CURRENT_DATE)), 0), 1)
                  AS value,
                ROUND(100.0 * COUNT(*) FILTER (
                        WHERE gap_min <= target
                          AND created_at >= date_trunc('month', CURRENT_DATE) - interval '1 month'
                          AND created_at <  date_trunc('month', CURRENT_DATE))
                      / NULLIF(COUNT(*) FILTER (
                        WHERE created_at >= date_trunc('month', CURRENT_DATE) - interval '1 month'
                          AND created_at <  date_trunc('month', CURRENT_DATE)), 0), 1)
                  AS previous
              FROM gaps
        `);

        const overdue = await query(`
            SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE cs.last_agent_at > cs.last_public_agent_at)::int
                     AS internal_only
              FROM tickets t
              JOIN ticket_comment_summary cs ON cs.ticket_id = t.id
              LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority,'normal')
             WHERE t.status NOT IN ('solved','closed','deleted')
               AND NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
               AND t.organization_id IS NOT NULL
               AND cs.last_public_agent_at IS NOT NULL
               AND EXTRACT(EPOCH FROM (now() - cs.last_public_agent_at)) / 60
                     > tg.update_interval_minutes
        `);
        metrics.update_compliance = {
            value: upd.rows[0].value,
            unit: '%',
            detail: `${overdue.rows[0].total} open tickets overdue now, ${overdue.rows[0].internal_only} with a recent internal note`,
            previous: upd.rows[0].previous,
            // Higher is better here, unlike the other two.
            higher_is_better: true
        };

        // P1 median against p90: the gap is the whole argument that this is an
        // alerting problem rather than an effort one.
        const p1 = await query(`
            SELECT
                ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY first_reply_minutes))::int AS value,
                ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY first_reply_minutes))::int AS p90
              FROM tickets
             WHERE priority = 'urgent'
               AND first_reply_minutes IS NOT NULL
               AND solved_at > now() - interval '90 days'
               AND NOT (has_alarmtraq OR has_virsae OR has_checkmk)
        `);
        metrics.p1_response = {
            value: p1.rows[0].value,
            unit: 'm',
            detail: `median · ${p1.rows[0].p90}m at p90 · 15m target`,
            previous: null
        };

        res.json({
            items: items.map(i => ({ ...i, metric: metrics[i.metric_key] ?? null })),
            as_of: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/ops/automation
 *
 * Alarm platform performance. Deliberately not the human metrics with a
 * different filter: an alarm that resolves at one touch is automation working,
 * not service quality, and customer wait time on a machine-generated ticket
 * means nothing.
 *
 * The headline is auto-resolution rate — the share of alarms closed with no
 * agent reply at all. That is what more automation should raise.
 */
router.get('/ops/automation', cacheMiddleware(600), async (req, res) => {
    try {
        const days = Math.min(730, parseInt(req.query.days || '90', 10));
        const isAlarm = `(t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)`;

        // Headline figures for the window, plus the equivalent window before it
        // so the direction is visible without a second request.
        const summary = await query(`
            WITH windows AS (
                SELECT 'current' AS period,
                       (now() - ($1 || ' days')::interval) AS from_ts,
                       now() AS to_ts
                UNION ALL
                SELECT 'previous',
                       (now() - ($1::int * 2 || ' days')::interval),
                       (now() - ($1 || ' days')::interval)
            )
            SELECT
                w.period,
                COUNT(*)::int AS alarms,

                -- Alarmtraq raised it and cleared it. The tag is applied by the
                -- clearing comment, so it is a reliable machine signal where
                -- reply_count is not: reply_count counts machine comments, and
                -- Zendesk attributes trigger activity to whoever authored the
                -- trigger.
                COUNT(*) FILTER (WHERE t.tags @> '["alarm_cleared"]'::jsonb)::int
                    AS self_cleared,

                -- Folded into a duplicate. Consolidating alarm noise is the
                -- platform working, not a human handling something.
                COUNT(*) FILTER (
                    WHERE NOT (t.tags @> '["alarm_cleared"]'::jsonb)
                      AND t.tags @> '["closed_by_merge"]'::jsonb
                )::int AS merged,

                -- Somebody logged time against it. This is the real human cost
                -- of alarms, and it appears in no per-agent figure today.
                COUNT(*) FILTER (
                    WHERE NOT (t.tags @> '["alarm_cleared"]'::jsonb)
                      AND NOT (t.tags @> '["closed_by_merge"]'::jsonb)
                      AND COALESCE(t.billable_time_minutes, 0) > 0
                )::int AS worked,

                -- Neither cleared, merged, nor logged. Somebody closed it
                -- without recording anything - reported rather than rounded
                -- into a tidier number.
                COUNT(*) FILTER (
                    WHERE NOT (t.tags @> '["alarm_cleared"]'::jsonb)
                      AND NOT (t.tags @> '["closed_by_merge"]'::jsonb)
                      AND COALESCE(t.billable_time_minutes, 0) = 0
                )::int AS unexplained,

                ROUND(100.0 * COUNT(*) FILTER (
                        WHERE t.tags @> '["alarm_cleared"]'::jsonb
                           OR t.tags @> '["closed_by_merge"]'::jsonb)
                      / NULLIF(COUNT(*), 0), 1) AS handled_rate,

                ROUND(SUM(t.billable_time_minutes) FILTER (
                        WHERE NOT (t.tags @> '["alarm_cleared"]'::jsonb)
                          AND NOT (t.tags @> '["closed_by_merge"]'::jsonb)
                      ) / 60.0, 1) AS human_hours,

                ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (
                        ORDER BY t.resolution_minutes) FILTER (
                        WHERE t.tags @> '["alarm_cleared"]'::jsonb))::int
                    AS median_cleared_minutes,
                ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (
                        ORDER BY t.resolution_minutes) FILTER (
                        WHERE NOT (t.tags @> '["alarm_cleared"]'::jsonb)
                          AND NOT (t.tags @> '["closed_by_merge"]'::jsonb)))::int
                    AS median_worked_minutes,
                -- closed automatically and then reopened was not really handled.
                COUNT(*) FILTER (WHERE COALESCE(t.reopens, 0) > 0)::int AS reopened

            FROM windows w
            JOIN tickets t
              ON t.solved_at >= w.from_ts AND t.solved_at < w.to_ts
             AND ${isAlarm}
            GROUP BY w.period
        `, [days]);

        // Monthly series for the trend. Twelve points regardless of the window
        // above, because "is coverage improving" is a longer question than
        // "how did the last 90 days go".
        const trend = await query(`
            WITH months AS (
                SELECT generate_series(
                    date_trunc('month', CURRENT_DATE) - interval '11 months',
                    date_trunc('month', CURRENT_DATE),
                    interval '1 month'
                )::date AS month_start
            )
            SELECT
                to_char(m.month_start, 'YYYY-MM') AS month,
                COUNT(t.id)::int AS alarms,
                COUNT(t.id) FILTER (
                    WHERE t.tags @> '["alarm_cleared"]'::jsonb
                       OR t.tags @> '["closed_by_merge"]'::jsonb
                )::int AS handled,
                ROUND(100.0 * COUNT(t.id) FILTER (
                        WHERE t.tags @> '["alarm_cleared"]'::jsonb
                           OR t.tags @> '["closed_by_merge"]'::jsonb)
                      / NULLIF(COUNT(t.id), 0), 1) AS handled_rate
            FROM months m
            LEFT JOIN tickets t
              ON t.solved_at >= m.month_start
             AND t.solved_at < (m.month_start + interval '1 month')
             AND ${isAlarm}
            GROUP BY m.month_start
            ORDER BY m.month_start
        `);

        // By source. Which platform generates the most, and which needs a human
        // most often — the second is where automation work would pay off.
        const sources = await query(`
            SELECT
                src.name,
                COUNT(*)::int AS alarms,
                COUNT(*) FILTER (
                    WHERE NOT (t.tags @> '["alarm_cleared"]'::jsonb)
                      AND NOT (t.tags @> '["closed_by_merge"]'::jsonb)
                )::int AS needed_a_human,
                ROUND(100.0 * COUNT(*) FILTER (
                        WHERE t.tags @> '["alarm_cleared"]'::jsonb
                           OR t.tags @> '["closed_by_merge"]'::jsonb)
                      / NULLIF(COUNT(*), 0), 1) AS handled_rate,
                ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (
                        ORDER BY t.resolution_minutes))::int AS median_close_minutes
            FROM tickets t
            CROSS JOIN LATERAL (
                VALUES
                  ('Alarmtraq', t.has_alarmtraq),
                  ('Virsae',    t.has_virsae),
                  ('CheckMK',   t.has_checkmk)
            ) AS src(name, flagged)
            WHERE src.flagged
              AND t.solved_at > now() - ($1 || ' days')::interval
            GROUP BY src.name
            ORDER BY COUNT(*) DESC
        `, [days]);

        const byPeriod = {};
        for (const r of summary.rows) byPeriod[r.period] = r;

        res.json({
            current: byPeriod.current ?? null,
            previous: byPeriod.previous ?? null,
            trend: trend.rows,
            sources: sources.rows,
            days,
            as_of: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/agents/day
 *
 * One day per agent, split four ways. Each count carries its own date basis
 * rather than inheriting one from a filter, because the questions genuinely
 * differ: "what came in" is a created-date question and "what got finished" is
 * a solved-date one. Forcing them onto a single basis is what made the period
 * table contradict itself.
 *
 * Hours span all four buckets — they are the day's total, wherever it went.
 */
router.get('/agents/day', cacheMiddleware(120), async (req, res) => {
    try {
        const day = req.query.date || new Date().toISOString().slice(0, 10);
        const to = req.query.endDate || day;   // week-to-date uses a range

        const result = await query(`
            WITH bounds AS (
                SELECT $1::date AS from_date, $2::date AS to_date
            ),
            -- Alarms that reached a person. Same rule as the coverage metric:
            -- self-cleared and merged alarms are the platform working, not
            -- someone's day.
            handled AS (
                SELECT t.*, b.from_date, b.to_date
                  FROM tickets t
                  CROSS JOIN bounds b
                 WHERE t.assignee_id IS NOT NULL
                   AND (
                     NOT (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)
                     OR (
                       NOT (t.tags @> '["alarm_cleared"]'::jsonb)
                       AND NOT (t.tags @> '["merged_duplicate"]'::jsonb)
                       AND NOT (t.tags @> '["closed_by_merge"]'::jsonb)
                     )
                   )
            ),
            counts AS (
                SELECT
                    h.assignee_id,

                    COUNT(*) FILTER (
                      WHERE h.created_at >= h.from_date
                        AND h.created_at < h.to_date + interval '1 day'
                    )::int AS new_assigned,

                    COUNT(*) FILTER (
                      WHERE h.created_at >= h.from_date
                        AND h.created_at < h.to_date + interval '1 day'
                        AND h.solved_at  >= h.from_date
                        AND h.solved_at  < h.to_date + interval '1 day'
                    )::int AS solved_same_day,

                    COUNT(*) FILTER (
                      WHERE h.solved_at >= h.from_date
                        AND h.solved_at < h.to_date + interval '1 day'
                        AND h.created_at < h.from_date
                    )::int AS older_solved

                  FROM handled h
                 GROUP BY h.assignee_id
            ),
            -- Worked but not closed: time logged in the window against a
            -- ticket that is still open. Nothing else in the app sees this.
            worked_open AS (
                SELECT te.agent_id AS assignee_id,
                       COUNT(DISTINCT te.ticket_id)::int AS worked_still_open
                  FROM ticket_time_entries te
                  JOIN tickets t ON t.id = te.ticket_id
                  CROSS JOIN bounds b
                 WHERE te.created_at >= b.from_date
                   AND te.created_at < b.to_date + interval '1 day'
                   AND te.created_at > t.created_at + interval '1 minute'
                   AND t.status NOT IN ('solved','closed','deleted')
                 GROUP BY te.agent_id
            ),
            hours AS (
                SELECT te.agent_id AS assignee_id,
                       ROUND((SUM(te.time_seconds) / 3600.0)::numeric, 1) AS hours_logged
                  FROM ticket_time_entries te
                  JOIN tickets t ON t.id = te.ticket_id
                  CROSS JOIN bounds b
                 WHERE te.created_at >= b.from_date
                   AND te.created_at < b.to_date + interval '1 day'
                   -- Machine-written entries. See the guard on
                   -- /agents/ticket-time for why this is a timing test.
                   AND te.created_at > t.created_at + interval '1 minute'
                 GROUP BY te.agent_id
            )
            SELECT
                a.id AS assignee_id,
                a.name AS assignee_name,
                COALESCE(c.new_assigned, 0)      AS new_assigned,
                COALESCE(c.solved_same_day, 0)   AS solved_same_day,
                COALESCE(c.older_solved, 0)      AS older_solved,
                COALESCE(w.worked_still_open, 0) AS worked_still_open,
                COALESCE(h.hours_logged, 0)      AS hours_logged
            FROM agents a
            LEFT JOIN counts c      ON c.assignee_id = a.id
            LEFT JOIN worked_open w ON w.assignee_id = a.id
            LEFT JOIN hours h       ON h.assignee_id = a.id
            WHERE NOT EXISTS (
              SELECT 1 FROM automation_accounts aa WHERE aa.agent_id = a.id
            )
              -- Nothing in any bucket means the agent had no day here. Listing
              -- them as four zeros would imply idleness rather than absence.
              AND (c.assignee_id IS NOT NULL OR w.assignee_id IS NOT NULL
                   OR h.assignee_id IS NOT NULL)
            ORDER BY COALESCE(h.hours_logged, 0) DESC,
                     COALESCE(c.new_assigned, 0) DESC
        `, [day, to]);

        res.json({ agents: result.rows, from: day, to, as_of: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/agents/day/tickets?agentId=&date=&bucket=
 *
 * The tickets behind one bucket for one agent. Fetched on expand rather than
 * bundled into /agents/day, which would carry hundreds of rows nobody opens.
 */
router.get('/agents/day/tickets', cacheMiddleware(120), async (req, res) => {
    try {
        const { agentId, bucket } = req.query;
        const day = req.query.date || new Date().toISOString().slice(0, 10);
        const to = req.query.endDate || day;
        if (!agentId || !bucket) {
            return res.status(400).json({ error: 'agentId and bucket required' });
        }

        const clauses = {
            new_solved: `t.created_at >= $2 AND t.created_at < $3::date + interval '1 day'
                         AND t.solved_at >= $2 AND t.solved_at < $3::date + interval '1 day'`,
            new_open:   `t.created_at >= $2 AND t.created_at < $3::date + interval '1 day'
                         AND (t.solved_at IS NULL
                              OR t.solved_at >= $3::date + interval '1 day')`,
            older_solved: `t.solved_at >= $2 AND t.solved_at < $3::date + interval '1 day'
                           AND t.created_at < $2`,
            worked_open: `t.status NOT IN ('solved','closed','deleted')
                          AND EXISTS (
                            SELECT 1 FROM ticket_time_entries te
                             WHERE te.ticket_id = t.id
                               AND te.agent_id = t.assignee_id
                               AND te.created_at >= $2
                               AND te.created_at < $3::date + interval '1 day'
                               AND te.created_at > t.created_at + interval '1 minute'
                          )`
        }[bucket];

        if (!clauses) return res.status(400).json({ error: 'unknown bucket' });

        const result = await query(`
            SELECT t.id, t.subject, t.status, t.created_at, t.solved_at,
                   t.organization_name,
                   (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk) AS is_alarm,
                   ROUND((COALESCE((
                     SELECT SUM(te.time_seconds) FROM ticket_time_entries te
                      WHERE te.ticket_id = t.id
                        AND te.created_at >= $2
                        AND te.created_at < $3::date + interval '1 day'
                   ), 0) / 3600.0)::numeric, 1) AS hours_today
              FROM tickets t
             WHERE t.assignee_id = $1::bigint
               AND ${clauses}
             ORDER BY t.solved_at DESC NULLS LAST, t.created_at DESC
             LIMIT 50
        `, [agentId, day, to]);

        res.json({ tickets: result.rows, bucket, count: result.rows.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/analytics/agents/scorecard?groupBy=agent|group
 *
 * The same figures aggregated either by person or by team.
 *
 * A separate Groups tab would have shown these columns again one level up, and
 * then drilled into agents to show them a third time — so grouping is a control
 * rather than a place. It also fixes an inconsistency: the agent view counts a
 * person once across every group, while a group view counts them per group, and
 * nothing said which you were looking at.
 *
 * Every count states its own date basis rather than inheriting one: assigned is
 * a created-date question, solved a solved-date one, and backlog a position
 * rather than a flow.
 */
router.get('/agents/scorecard', cacheMiddleware(300), async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'startDate and endDate required' });
        }

        const byGroup = req.query.groupBy === 'group';
        // Everything downstream keys on this, so the CTEs are identical either
        // way and only the column changes.
        // Unassigned tickets belong to a group but to no person, so in agent
        // mode they collapse onto a sentinel rather than being dropped. Every
        // LEFT JOIN downstream then matches it the same way it matches a real
        // agent. Group mode keeps t.group_id: a ticket with no group is a
        // different question and is still excluded.
        const idCol = byGroup ? 't.group_id' : 'COALESCE(t.assignee_id, 0)';
        const idAs = byGroup ? 'group_id' : 'assignee_id';
        // Where the sentinel must not reach: the null test that used to drop
        // these rows, and anything counting people.
        const idNotNull = byGroup ? 'AND t.group_id IS NOT NULL' : '';

        const params = [startDate, endDate];

        const groupIds = req.query.groupIds
            ? String(req.query.groupIds).split(',').map(g => g.trim()).filter(Boolean)
            : null;
        let groupClause = '';
        if (groupIds) {
            params.push(groupIds);
            groupClause = `AND t.group_id = ANY($${params.length}::bigint[])`;
        }

        const source = ['human', 'alarm'].includes(req.query.source)
            ? req.query.source : 'all';
        const isAlarm = '(t.has_alarmtraq OR t.has_virsae OR t.has_checkmk)';
        const HANDLED = `(NOT ${isAlarm} OR (
                            NOT (t.tags @> '["alarm_cleared"]'::jsonb)
                        AND NOT (t.tags @> '["merged_duplicate"]'::jsonb)
                        AND NOT (t.tags @> '["closed_by_merge"]'::jsonb)))`;
        const handledClause = `AND ${HANDLED}`;
        const sourceClause =
            source === 'human' ? `AND NOT ${isAlarm}`
          : source === 'alarm' ? `AND ${isAlarm}`
          : '';

        let orgClause = '';
        if (req.query.organizationId) {
            params.push(req.query.organizationId);
            orgClause = `AND t.organization_id = $${params.length}::bigint`;
        }
        let priorityClause = '';
        if (req.query.priority) {
            params.push(req.query.priority);
            priorityClause = `AND t.priority = $${params.length}`;
        }
        const scopeClause = `${orgClause} ${priorityClause}`;

        // Automation accounts are excluded per ticket rather than per row: in
        // group mode there is no agent row to filter out, but Alarmtraq's
        // tickets would still land in whichever group they were routed to.
        const notAutomation = `AND NOT EXISTS (
                       SELECT 1 FROM automation_accounts aa
                        WHERE aa.agent_id = t.assignee_id)`;

        const result = await query(`
            WITH bounds AS (
                SELECT $1::date AS from_date,
                       $2::date AS to_date,
                       COALESCE((SELECT value FROM ops_settings WHERE key = 'aging_days'), 7)::int
                         AS aging_days,
                       COALESCE((SELECT value FROM ops_settings
                                  WHERE key = 'aging_days_extended'), 30)::int
                         AS aging_days_extended
            ),

            solved AS (
                SELECT ${idCol} AS id,
                       COUNT(*)::int AS solved,
                       COUNT(*) FILTER (WHERE NOT ${isAlarm})::int AS human_solved,
                       COUNT(*) FILTER (WHERE ${isAlarm})::int AS alarm_solved,

                       ROUND((SUM(t.billable_time_minutes) FILTER (WHERE NOT ${isAlarm})
                         / NULLIF(COUNT(*) FILTER (WHERE NOT ${isAlarm}), 0)
                         / 60.0)::numeric, 2) AS hours_per_human,

                       COUNT(*) FILTER (WHERE COALESCE(t.reply_count, 0) <= 1)::int AS one_touch,
                       COUNT(*) FILTER (WHERE COALESCE(t.reply_count, 0) = 2)::int AS two_touch,
                       COUNT(*) FILTER (WHERE COALESCE(t.reply_count, 0) > 2)::int AS multi_touch,
                       COUNT(*)::int AS touch_base,

                       ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
                         ORDER BY t.first_reply_minutes))::int AS median_first_reply,
                       ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
                         ORDER BY t.resolution_minutes))::int AS median_resolution,
                       -- Human only, unlike the two above: an alarm has no
                       -- requester waiting, and including them held this at
                       -- zero for every high-volume row.
                       ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
                         ORDER BY t.requester_wait_time_minutes)
                         FILTER (WHERE NOT ${isAlarm}))::int AS median_requester_wait,

                       COUNT(*) FILTER (WHERE s.response_met)::int AS response_met,
                       COUNT(*) FILTER (WHERE s.response_met IS NOT NULL)::int AS response_base,
                       COUNT(*) FILTER (WHERE s.resolution_met)::int AS resolution_met,
                       COUNT(*) FILTER (WHERE s.resolution_met IS NOT NULL)::int AS resolution_base,

                       -- Not the sentinel: an unassigned pile is not a person.
                       COUNT(DISTINCT t.assignee_id)
                         FILTER (WHERE t.assignee_id IS NOT NULL)::int AS agents_active

                  FROM tickets t
                  JOIN tickets_sla s ON s.id = t.id
                  CROSS JOIN bounds b
                 WHERE t.solved_at >= b.from_date
                   AND t.solved_at <  b.to_date + interval '1 day'
                   ${idNotNull}
                   ${handledClause}
                   ${notAutomation}
                   ${groupClause}
                   ${sourceClause}
                   ${scopeClause}
                 GROUP BY ${idCol}
            ),

            assigned AS (
                SELECT ${idCol} AS id,
                       COUNT(*)::int AS assigned,
                       COUNT(*) FILTER (WHERE NOT ${isAlarm})::int AS assigned_human,
                       COUNT(*) FILTER (WHERE ${isAlarm})::int AS assigned_alarm
                  FROM tickets t
                  CROSS JOIN bounds b
                 WHERE t.created_at >= b.from_date
                   AND t.created_at <  b.to_date + interval '1 day'
                   ${idNotNull}
                   ${notAutomation}
                   ${groupClause}
                   ${sourceClause}
                   ${scopeClause}
                 GROUP BY ${idCol}
            ),

            backlog_open AS (
                SELECT ${idCol} AS id, COUNT(*)::int AS n
                  FROM tickets t
                  CROSS JOIN bounds b
                 WHERE t.created_at < b.from_date
                   AND (t.solved_at IS NULL OR t.solved_at >= b.from_date)
                   ${idNotNull}
                   ${notAutomation}
                   ${groupClause}
                   ${sourceClause}
                   ${scopeClause}
                 GROUP BY ${idCol}
            ),

            backlog_close AS (
                SELECT ${idCol} AS id, COUNT(*)::int AS n
                  FROM tickets t
                  CROSS JOIN bounds b
                 WHERE t.created_at < b.to_date + interval '1 day'
                   AND (t.solved_at IS NULL OR t.solved_at >= b.to_date + interval '1 day')
                   ${idNotNull}
                   ${notAutomation}
                   ${groupClause}
                   ${sourceClause}
                   ${scopeClause}
                 GROUP BY ${idCol}
            ),

            open_worked AS (
                SELECT ${byGroup ? 't.group_id' : 'te.agent_id'} AS id,
                       COUNT(DISTINCT te.ticket_id)::int AS n
                  FROM ticket_time_entries te
                  JOIN tickets t ON t.id = te.ticket_id
                  CROSS JOIN bounds b
                 WHERE te.created_at >= b.from_date
                   AND te.created_at <  b.to_date + interval '1 day'
                   -- Machine-written entries; see the guard on
                   -- /agents/ticket-time for why this is a timing test.
                   AND te.created_at >  t.created_at + interval '1 minute'
                   AND t.status NOT IN ('solved','closed','deleted')
                   ${groupClause}
                   ${sourceClause}
                   ${scopeClause}
                 GROUP BY 1
            ),

            aging AS (
                SELECT ${idCol} AS id,
                       COUNT(*)::int AS n,
                       COUNT(*) FILTER (
                         WHERE t.created_at
                               < now() - (bn.aging_days_extended || ' days')::interval
                       )::int AS n_extended
                  FROM tickets t
                  LEFT JOIN custom_statuses cs ON cs.id = t.custom_status_id
                  LEFT JOIN sla_category_behaviour bh
                         ON bh.status_category = CASE
                              WHEN t.status IN ('closed', 'deleted') THEN t.status
                              ELSE COALESCE(cs.status_category, t.status)
                            END
                  CROSS JOIN bounds bn
                 WHERE t.status NOT IN ('solved','closed','deleted')
                   AND t.created_at < now() - (bn.aging_days || ' days')::interval
                   ${idNotNull}
                   AND bh.ball_with = 'intlx'
                   ${notAutomation}
                   ${groupClause}
                   ${sourceClause}
                   ${scopeClause}
                 GROUP BY ${idCol}
            ),

            updates AS (
                SELECT ${idCol} AS id,
                       COUNT(*) FILTER (
                         WHERE EXTRACT(EPOCH FROM (p.created_at - p.prev)) / 60
                               <= tg.update_interval_minutes
                       )::int AS met,
                       COUNT(*)::int AS total
                  FROM (
                    SELECT ticket_id, created_at,
                           LAG(created_at) OVER (
                             PARTITION BY ticket_id ORDER BY created_at
                           ) AS prev
                      FROM ticket_public_comments WHERE is_public
                  ) p
                  JOIN tickets t ON t.id = p.ticket_id
                  LEFT JOIN sla_targets tg ON tg.priority = COALESCE(t.priority,'normal')
                  CROSS JOIN bounds b
                 WHERE p.prev IS NOT NULL
                   AND p.created_at >= b.from_date
                   AND p.created_at <  b.to_date + interval '1 day'
                   AND NOT ${isAlarm}
                   ${idNotNull}
                   ${notAutomation}
                   ${groupClause}
                   ${scopeClause}
                 GROUP BY ${idCol}
            ),

            -- One row per agent or per group, whichever we are counting.
            subjects AS (
                ${byGroup
                  ? `SELECT g.id, g.name FROM groups g`
                  : `SELECT a.id, a.name FROM agents a
                      WHERE NOT EXISTS (
                        SELECT 1 FROM automation_accounts aa WHERE aa.agent_id = a.id)
                     UNION ALL
                     SELECT 0::bigint AS id, 'No Agent' AS name`}
            )

            SELECT
                sub.id::text AS ${idAs},
                sub.name AS ${byGroup ? 'group_name' : 'assignee_name'},
                ${byGroup ? `(SELECT COUNT(*)::int FROM group_memberships gm
                               WHERE gm.group_id = sub.id
                                 AND NOT EXISTS (
                                   SELECT 1 FROM automation_accounts aa
                                    WHERE aa.agent_id = gm.agent_id)) AS members,
                             COALESCE(s.agents_active, 0) AS agents_active,`
                          : ''}

                COALESCE(asg.assigned, 0)        AS assigned,
                COALESCE(asg.assigned_human, 0)  AS assigned_human,
                COALESCE(asg.assigned_alarm, 0)  AS assigned_alarm,
                COALESCE(s.solved, 0)            AS solved,
                COALESCE(s.human_solved, 0)      AS human_solved,
                COALESCE(s.alarm_solved, 0)      AS alarm_solved,
                CASE WHEN COALESCE(s.solved, 0) > 0
                     THEN ROUND(100.0 * s.human_solved / s.solved) END AS human_share,
                s.hours_per_human,
                COALESCE(ow.n, 0)                AS open_worked,

                COALESCE(bo.n, 0)                AS backlog_opening,
                COALESCE(bc.n, 0)                AS backlog_closing,
                COALESCE(ag.n, 0)                AS backlog_aging,
                COALESCE(ag.n_extended, 0)       AS backlog_aging_extended,

                CASE WHEN s.touch_base > 0
                     THEN ROUND(100.0 * s.one_touch / s.touch_base) END AS one_touch_pct,
                CASE WHEN s.touch_base > 0
                     THEN ROUND(100.0 * s.two_touch / s.touch_base) END AS two_touch_pct,
                CASE WHEN s.touch_base > 0
                     THEN ROUND(100.0 * s.multi_touch / s.touch_base) END AS multi_touch_pct,
                COALESCE(s.touch_base, 0)        AS touch_base,

                s.median_first_reply,
                s.median_resolution,
                s.median_requester_wait,

                CASE WHEN s.response_base > 0
                     THEN ROUND(100.0 * s.response_met / s.response_base, 1) END
                  AS response_compliance,
                COALESCE(s.response_base, 0)     AS response_base,
                CASE WHEN s.resolution_base > 0
                     THEN ROUND(100.0 * s.resolution_met / s.resolution_base, 1) END
                  AS resolution_compliance,
                COALESCE(s.resolution_base, 0)   AS resolution_base,
                CASE WHEN u.total > 0
                     THEN ROUND(100.0 * u.met / u.total, 1) END AS update_compliance,
                COALESCE(u.total, 0)             AS update_base

            FROM subjects sub
            LEFT JOIN solved s         ON s.id  = sub.id
            LEFT JOIN assigned asg     ON asg.id = sub.id
            LEFT JOIN backlog_open bo  ON bo.id = sub.id
            LEFT JOIN backlog_close bc ON bc.id = sub.id
            LEFT JOIN aging ag         ON ag.id = sub.id
            LEFT JOIN open_worked ow   ON ow.id = sub.id
            LEFT JOIN updates u        ON u.id  = sub.id
            WHERE s.id IS NOT NULL OR asg.id IS NOT NULL OR bc.id IS NOT NULL
            ORDER BY COALESCE(s.solved, 0) DESC
        `, params);

        // Median rather than mean: one row closing 298 alarms would drag an
        // average far above anything recognisable as normal.
        // The median describes a typical agent, so the unassigned pile is not
        // one of the values. On a single group's expansion it would be one row
        // in eight, with no human behaviour behind any of its rates.
        const medianRows = result.rows.filter(r => String(r[idAs]) !== '0');

        const median = (key) => {
            const vals = medianRows
                .map(r => r[key] === null || r[key] === undefined ? null : Number(r[key]))
                .filter(v => v !== null && !Number.isNaN(v))
                .sort((x, y) => x - y);
            if (!vals.length) return null;
            const mid = Math.floor(vals.length / 2);
            return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
        };

        const teamMedian = {};
        for (const k of [
            'assigned','assigned_human','assigned_alarm',
            'solved','human_solved','alarm_solved','human_share','hours_per_human',
            'open_worked','backlog_opening','backlog_closing',
            'backlog_aging','backlog_aging_extended',
            'one_touch_pct','two_touch_pct','multi_touch_pct',
            'median_first_reply','median_resolution','median_requester_wait',
            'response_compliance','resolution_compliance','update_compliance'
        ]) teamMedian[k] = median(k);

        const settings = await query(
            `SELECT key, value FROM ops_settings
              WHERE key IN ('aging_days', 'aging_days_extended')`
        );
        const setting = (k, d) =>
            Number(settings.rows.find(r => r.key === k)?.value ?? d);

        res.json({
            agents: result.rows,
            group_by: byGroup ? 'group' : 'agent',
            team_median: teamMedian,
            source,
            aging_days: setting('aging_days', 7),
            aging_days_extended: setting('aging_days_extended', 30),
            note: 'Assigned counts by creation date, solved by resolution date, backlog by position. Rates cover human tickets plus alarms someone handled.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/agents/:agentId/tickets', cacheMiddleware(120), async (req, res) => {
    try {
        const { agentId } = req.params;
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'startDate and endDate required' });
        }

        const result = await query(`
            SELECT t.id, t.subject, t.status, t.created_at, t.solved_at,
                   t.organization_name,
                   (t.has_alarmtraq OR t.has_virsae OR t.has_checkmk) AS is_alarm,
                   ROUND((COALESCE((
                     SELECT SUM(te.time_seconds) FROM ticket_time_entries te
                      WHERE te.ticket_id = t.id
                        AND te.agent_id = $1::bigint
                        AND te.created_at >= $2::date
                        AND te.created_at <  $3::date + interval '1 day'
                   ), 0) / 3600.0)::numeric, 1) AS hours_in_period,
                   (t.status NOT IN ('solved','closed','deleted')) AS still_open,
                   -- Helping on a colleague's ticket is real effort and worth
                   -- showing, but the row needs to say whose it is.
                   CASE WHEN t.assignee_id <> $1::bigint THEN t.assignee_name END
                     AS other_assignee
              FROM tickets t
             WHERE (
                 -- Solved in the period, whenever it opened...
                 (t.assignee_id = $1::bigint
                  AND t.solved_at >= $2::date
                  AND t.solved_at < $3::date + interval '1 day')
                 -- ...or still open with time logged against it in the period.
                 OR (
                   t.status NOT IN ('solved','closed','deleted')
                   AND EXISTS (
                     SELECT 1 FROM ticket_time_entries te
                      WHERE te.ticket_id = t.id
                        AND te.agent_id = $1::bigint
                        AND te.created_at >= $2::date
                        AND te.created_at <  $3::date + interval '1 day'
                        -- Machine-written entries; see the guard on
                        -- /agents/ticket-time for why this is a timing test.
                        AND te.created_at >  t.created_at + interval '1 minute'
                   )
                 )
               )
             -- Open first: those are the ones needing a decision.
             ORDER BY still_open DESC, t.solved_at DESC NULLS LAST
             LIMIT 100
        `, [agentId, startDate, endDate]);

        res.json({ tickets: result.rows, count: result.rows.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
