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

    // Status filter
    if (filters.status) {
        conditions.push(`t.status = $${paramIndex++}`);
        params.push(filters.status);
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

    // Billable filter
    if (filters.billable !== undefined) {
        conditions.push(`t.is_billable = $${paramIndex++}`);
        params.push(filters.billable);
    }

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

// ============================================================================
// AGENT PERFORMANCE ENDPOINTS
// ============================================================================

/**
 * GET /api/analytics/agents/performance
 * Get agent performance metrics
 */
router.get('/agents/performance', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters);

        const result = await query(`
            SELECT 
                t.assignee_id,
                t.assignee_name,
                COUNT(t.id) as total_tickets,
                COUNT(CASE WHEN t.status IN ('solved', 'closed') THEN 1 END) as solved_tickets,
                COUNT(CASE WHEN t.is_billable THEN 1 END) as billable_tickets,
                SUM(t.billable_time_minutes) / 60.0 as billable_hours,
                AVG(tm.first_reply_time_minutes) as avg_first_reply_minutes,
                AVG(tm.full_resolution_time_minutes) as avg_resolution_minutes,
                AVG(CASE WHEN tm.sla_resolution_compliant THEN 100.0 ELSE 0.0 END) as sla_compliance_rate
            FROM tickets t
            LEFT JOIN ticket_metrics tm ON t.id = tm.ticket_id
            ${whereClause}
            GROUP BY t.assignee_id, t.assignee_name
            HAVING t.assignee_id IS NOT NULL
            ORDER BY total_tickets DESC
            LIMIT 100
        `, params);

        res.json({
            agents: result.rows,
            count: result.rows.length
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
 * Get SLA compliance metrics
 */
router.get('/sla/compliance', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters);

        const result = await query(`
            SELECT 
                COUNT(*) as total_tickets,
                AVG(CASE WHEN sla_first_reply_compliant THEN 100.0 ELSE 0.0 END) as first_reply_compliance,
                AVG(CASE WHEN sla_resolution_compliant THEN 100.0 ELSE 0.0 END) as resolution_compliance,
                AVG(first_reply_time_minutes) as avg_first_reply_minutes,
                AVG(full_resolution_time_minutes) as avg_resolution_minutes,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_reply_time_minutes) as median_first_reply,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY full_resolution_time_minutes) as median_resolution
            FROM ticket_metrics tm
            JOIN tickets t ON tm.ticket_id = t.id
            ${whereClause}
        `, params);

        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// BILLING & TIME TRACKING ENDPOINTS
// ============================================================================

/**
 * GET /api/analytics/billing/summary
 * Get billing summary
 */
router.get('/billing/summary', cacheMiddleware(300), async (req, res) => {
    try {
        const filters = req.query;
        const { whereClause, params } = buildWhereClause(filters, { asFragment: true });

        const result = await query(`
            SELECT 
                COUNT(DISTINCT t.id) as billable_tickets,
                SUM(t.billable_time_minutes) / 60.0 as total_billable_hours,
                COUNT(DISTINCT t.organization_id) as organizations_count,
                AVG(t.billable_time_minutes) / 60.0 as avg_hours_per_ticket
            FROM tickets t
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

// ============================================
// PAGINATED TICKETS ENDPOINT
// ============================================
router.get('/tickets/paginated', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  try {
    const { 
      startDate, 
      endDate, 
      page = 1,
      pageSize = 1000,
      organizationId,
      dateFilterType = 'created',
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate required' });
    }

    const pageNum = Math.max(1, parseInt(page));
    const size = Math.min(2000, Math.max(100, parseInt(pageSize)));
    const offset = (pageNum - 1) * size;

    const validSortFields = ['created_at', 'updated_at', 'id', 'status', 'priority'];
    const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'created_at';
    const validSortOrder = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Determine which date field to use
    const dateField = dateFilterType === 'solved' ? 'updated_at' : 'created_at';

    console.log(`📊 Paginated fetch: page ${pageNum}, size ${size}, dateFilter: ${dateFilterType}`);

    // Get total count
    const endExclusive = new Date(new Date(endDate.substring(0, 10) + 'T00:00:00Z').getTime() + 86400000).toISOString();
    let countSql = `SELECT COUNT(*) as total FROM tickets WHERE ${dateField} >= $1 AND ${dateField} < $2`;
    const countParams = [startDate, endExclusive];
    
    // For solved date filter, only include solved/closed tickets
    if (dateFilterType === 'solved') {
      countSql += ` AND status IN ('solved', 'closed')`;
    }
    
    if (organizationId) {
      countSql += ` AND organization_id = $3`;
      countParams.push(organizationId);
    }

    const countResult = await query(countSql, countParams);
    const totalCount = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalCount / size);

    // Fetch page
    let sql = `
      SELECT
        id, subject, description, status, priority, request_type,
        created_at, updated_at, requester_id, assignee_id,
        organization_id, group_id, tags, custom_fields, metric_set,
        reply_count, comment_count, reopens,
        first_resolution_time_minutes, full_resolution_time_minutes,
        agent_wait_time_minutes, requester_wait_time_minutes, on_hold_time_minutes
      FROM tickets
      WHERE ${dateField} >= $1 AND ${dateField} < $2
    `;
    const params = [startDate, endExclusive];
    let paramIndex = 3;

    // For solved date filter, only include solved/closed tickets
    if (dateFilterType === 'solved') {
      sql += ` AND status IN ('solved', 'closed')`;
    }

    if (organizationId) {
      sql += ` AND organization_id = $${paramIndex}`;
      params.push(organizationId);
      paramIndex++;
    }

    sql += ` ORDER BY ${safeSortBy} ${validSortOrder}`;
    sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(size, offset);

    const startTime = Date.now();
    const result = await query(sql, params);
    const queryTime = Date.now() - startTime;

    console.log(`✅ Page ${pageNum}/${totalPages}: ${result.rows.length} tickets in ${queryTime}ms`);

    res.json({
      success: true,
      tickets: result.rows,
      pagination: {
        page: pageNum,
        pageSize: size,
        totalCount,
        totalPages,
        hasMore: pageNum < totalPages,
        nextPage: pageNum < totalPages ? pageNum + 1 : null
      },
      dateFilterType,
      queryTime
    });

  } catch (error) {
    console.error('Error fetching paginated tickets:', error);
    res.status(500).json({ error: 'Failed to fetch tickets', message: error.message });
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
