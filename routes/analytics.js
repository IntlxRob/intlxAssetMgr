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
function buildWhereClause(filters = {}) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    // Date range filter
    if (filters.startDate) {
        conditions.push(`t.created_at >= $${paramIndex++}`);
        params.push(filters.startDate);
    }
    if (filters.endDate) {
        conditions.push(`t.created_at <= $${paramIndex++}`);
        params.push(filters.endDate);
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

    const whereClause = conditions.length > 0 
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    return { whereClause, params };
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
        const { whereClause, params } = buildWhereClause(filters);

        const result = await query(`
            SELECT 
                COUNT(DISTINCT t.id) as billable_tickets,
                SUM(t.billable_time_minutes) / 60.0 as total_billable_hours,
                COUNT(DISTINCT t.organization_id) as organizations_count,
                AVG(t.billable_time_minutes) / 60.0 as avg_hours_per_ticket
            FROM tickets t
            ${whereClause}
            AND t.is_billable = true
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
        const { whereClause, params } = buildWhereClause(filters);

        const result = await query(`
            SELECT 
                t.organization_id,
                t.organization_name,
                COUNT(t.id) as billable_tickets,
                SUM(t.billable_time_minutes) / 60.0 as billable_hours,
                AVG(t.billable_time_minutes) / 60.0 as avg_hours_per_ticket
            FROM tickets t
            ${whereClause}
            AND t.is_billable = true
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
    const { startDate, endDate, organizationId } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate required' });
    }

    let sql = `SELECT COUNT(*) as total FROM tickets WHERE created_at >= $1 AND created_at <= $2`;
    const params = [startDate, endDate];
    
    if (organizationId) {
      sql += ` AND organization_id = $3`;
      params.push(organizationId);
    }

    const result = await query(sql, params);
    
    res.json({
      success: true,
      count: parseInt(result.rows[0].total),
      startDate,
      endDate
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

    console.log(`📊 Paginated fetch: page ${pageNum}, size ${size}`);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM tickets WHERE created_at >= $1 AND created_at <= $2`;
    const countParams = [startDate, endDate];
    
    if (organizationId) {
      countQuery += ` AND organization_id = $3`;
      countParams.push(organizationId);
    }

    const countResult = await pool.query(countQuery, countParams);
    const totalCount = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalCount / size);

    // Fetch page
    let query = `
      SELECT 
        id, subject, description, status, priority, request_type,
        created_at, updated_at, requester_id, assignee_id,
        organization_id, group_id, tags, custom_fields, metric_set,
        reply_count, comment_count, reopens,
        first_resolution_time_minutes, full_resolution_time_minutes,
        agent_wait_time_minutes, requester_wait_time_minutes, on_hold_time_minutes
      FROM tickets
      WHERE created_at >= $1 AND created_at <= $2
    `;
    
    const params = [startDate, endDate];
    let paramIndex = 3;

    if (organizationId) {
      query += ` AND organization_id = $${paramIndex}`;
      params.push(organizationId);
      paramIndex++;
    }

    query += ` ORDER BY ${safeSortBy} ${validSortOrder}`;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
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

module.exports = router;
