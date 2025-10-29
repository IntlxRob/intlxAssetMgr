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

module.exports = router;
