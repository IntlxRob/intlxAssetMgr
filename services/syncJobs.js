// services/syncJobs.js - Background Sync Service
const axios = require('axios');
const { query } = require('../db');
const { clearCache } = require('../middleware/cache');

// ============================================================================
// CONFIGURATION
// ============================================================================

const ZENDESK_CONFIG = {
    subdomain: process.env.ZENDESK_SUBDOMAIN,
    email: process.env.ZENDESK_EMAIL,
    token: process.env.ZENDESK_API_TOKEN,
    baseURL: `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`
};

// Sync intervals (in milliseconds)
const SYNC_INTERVALS = {
    tickets: 5 * 60 * 1000,      // 5 minutes
    organizations: 60 * 60 * 1000, // 1 hour
    agents: 60 * 60 * 1000,       // 1 hour
    groups: 60 * 60 * 1000        // 1 hour
};

// ============================================================================
// ZENDESK API CLIENT
// ============================================================================

/**
 * Make authenticated request to Zendesk API
 */
async function zendeskRequest(endpoint, params = {}) {
    const auth = Buffer.from(`${ZENDESK_CONFIG.email}/token:${ZENDESK_CONFIG.token}`).toString('base64');
    
    try {
        const response = await axios.get(`${ZENDESK_CONFIG.baseURL}${endpoint}`, {
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            params: params
        });
        return response.data;
    } catch (error) {
        console.error(`❌ Zendesk API error (${endpoint}):`, error.message);
        throw error;
    }
}

/**
 * Fetch all pages of results from Zendesk
 */
async function zendeskFetchAll(endpoint, params = {}) {
    const results = [];
    let nextPage = endpoint;
    let pageCount = 0;

    while (nextPage && pageCount < 100) { // Safety limit
        const data = await zendeskRequest(nextPage.replace(ZENDESK_CONFIG.baseURL, ''), params);
        
        // Handle different response formats
        const items = data.tickets || data.organizations || data.users || data.groups || [];
        results.push(...items);

        nextPage = data.next_page;
        pageCount++;

        // Rate limiting
        if (nextPage) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    return results;
}

// ============================================================================
// SYNC STATUS TRACKING
// ============================================================================

/**
 * Record sync start
 */
async function recordSyncStart(entityType) {
    await query(`
        INSERT INTO sync_status (entity_type, last_sync_at, status)
        VALUES ($1, NOW(), 'in_progress')
    `, [entityType]);
}

/**
 * Record sync completion
 */
async function recordSyncComplete(entityType, recordsSynced, startTime) {
    const duration = Math.floor((Date.now() - startTime) / 1000);
    
    await query(`
        UPDATE sync_status
        SET status = 'success',
            records_synced = $1,
            duration_seconds = $2,
            error_message = NULL
        WHERE entity_type = $3
        AND status = 'in_progress'
    `, [recordsSynced, duration, entityType]);
}

/**
 * Record sync failure
 */
async function recordSyncFailure(entityType, error) {
    await query(`
        UPDATE sync_status
        SET status = 'failed',
            error_message = $1
        WHERE entity_type = $2
        AND status = 'in_progress'
    `, [error.message, entityType]);
}

/**
 * Get last sync time for entity type
 */
async function getLastSyncTime(entityType) {
    const result = await query(`
        SELECT last_sync_at
        FROM sync_status
        WHERE entity_type = $1
        AND status = 'success'
        ORDER BY last_sync_at DESC
        LIMIT 1
    `, [entityType]);

    return result.rows[0]?.last_sync_at || null;
}

// ============================================================================
// ORGANIZATIONS SYNC
// ============================================================================

async function syncOrganizations() {
    const startTime = Date.now();
    console.log('🔄 Starting organizations sync...');

    try {
        await recordSyncStart('organizations');

        // Fetch all organizations from Zendesk
        const organizations = await zendeskFetchAll('/organizations.json');
        console.log(`📥 Fetched ${organizations.length} organizations`);

        let synced = 0;

        for (const org of organizations) {
            await query(`
                INSERT INTO organizations (
                    id, name, created_at, updated_at, 
                    details, shared_tickets, shared_comments
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    updated_at = EXCLUDED.updated_at,
                    details = EXCLUDED.details,
                    shared_tickets = EXCLUDED.shared_tickets,
                    shared_comments = EXCLUDED.shared_comments
            `, [
                org.id,
                org.name,
                org.created_at,
                org.updated_at,
                org.details,
                org.shared_tickets,
                org.shared_comments
            ]);
            synced++;
        }

        await recordSyncComplete('organizations', synced, startTime);
        console.log(`✅ Organizations sync complete: ${synced} records`);
        
        return { success: true, synced };
    } catch (error) {
        console.error('❌ Organizations sync failed:', error);
        await recordSyncFailure('organizations', error);
        throw error;
    }
}

// ============================================================================
// AGENTS (USERS) SYNC
// ============================================================================

async function syncAgents() {
    const startTime = Date.now();
    console.log('🔄 Starting agents sync...');

    try {
        await recordSyncStart('agents');

        // Fetch all agents (users with agent or admin role)
        const users = await zendeskFetchAll('/users.json', { role: ['agent', 'admin'] });
        console.log(`📥 Fetched ${users.length} agents`);

        let synced = 0;

        for (const user of users) {
            await query(`
                INSERT INTO agents (
                    id, name, email, role, created_at, 
                    updated_at, time_zone, locale, active
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    email = EXCLUDED.email,
                    role = EXCLUDED.role,
                    updated_at = EXCLUDED.updated_at,
                    time_zone = EXCLUDED.time_zone,
                    locale = EXCLUDED.locale,
                    active = EXCLUDED.active
            `, [
                user.id,
                user.name,
                user.email,
                user.role,
                user.created_at,
                user.updated_at,
                user.time_zone,
                user.locale,
                user.active
            ]);
            synced++;
        }

        await recordSyncComplete('agents', synced, startTime);
        console.log(`✅ Agents sync complete: ${synced} records`);
        
        return { success: true, synced };
    } catch (error) {
        console.error('❌ Agents sync failed:', error);
        await recordSyncFailure('agents', error);
        throw error;
    }
}

// ============================================================================
// GROUPS SYNC
// ============================================================================

async function syncGroups() {
    const startTime = Date.now();
    console.log('🔄 Starting groups sync...');

    try {
        await recordSyncStart('groups');

        // Fetch all groups
        const groups = await zendeskFetchAll('/groups.json');
        console.log(`📥 Fetched ${groups.length} groups`);

        let synced = 0;

        for (const group of groups) {
            await query(`
                INSERT INTO groups (
                    id, name, created_at, updated_at, deleted
                )
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    updated_at = EXCLUDED.updated_at,
                    deleted = EXCLUDED.deleted
            `, [
                group.id,
                group.name,
                group.created_at,
                group.updated_at,
                group.deleted || false
            ]);
            synced++;
        }

        await recordSyncComplete('groups', synced, startTime);
        console.log(`✅ Groups sync complete: ${synced} records`);
        
        return { success: true, synced };
    } catch (error) {
        console.error('❌ Groups sync failed:', error);
        await recordSyncFailure('groups', error);
        throw error;
    }
}

// ============================================================================
// TICKETS SYNC (INCREMENTAL)
// ============================================================================

/**
 * Extract custom field value by ID
 */
function getCustomFieldValue(ticket, fieldId) {
    const field = ticket.custom_fields?.find(f => f.id === fieldId);
    return field?.value || null;
}

async function syncTickets(fullSync = false) {
    const startTime = Date.now();
    console.log(`🔄 Starting tickets ${fullSync ? 'FULL' : 'incremental'} sync...`);

    try {
        await recordSyncStart('tickets');

        let tickets;
        
        if (fullSync) {
            // Full sync - fetch all tickets (last 30 days to avoid overwhelming)
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
            tickets = await zendeskFetchAll('/incremental/tickets.json', {
                start_time: Math.floor(new Date(thirtyDaysAgo).getTime() / 1000)
            });
        } else {
            // Incremental sync - only updated tickets
            const lastSync = await getLastSyncTime('tickets');
            const startTime = lastSync 
                ? Math.floor(new Date(lastSync).getTime() / 1000) - 300 // 5 min overlap
                : Math.floor(Date.now() / 1000) - 3600; // Last hour if no previous sync

            tickets = await zendeskFetchAll('/incremental/tickets.json', {
                start_time: startTime
            });
        }

        console.log(`📥 Fetched ${tickets.length} tickets`);

        let synced = 0;

        for (const ticket of tickets) {
            // Extract custom fields (adjust field IDs based on your Zendesk setup)
            const severity = getCustomFieldValue(ticket, 360013426117); // Example field ID
            const requestType = getCustomFieldValue(ticket, 360013426137); // Example field ID

            await query(`
                INSERT INTO tickets (
                    id, organization_id, organization_name, subject, description,
                    status, priority, severity, request_type,
                    assignee_id, assignee_name, requester_id, requester_name,
                    group_id, group_name,
                    created_at, updated_at, solved_at, closed_at, due_at,
                    tags, custom_fields, is_billable, billable_time_minutes
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 
                    $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
                )
                ON CONFLICT (id) DO UPDATE SET
                    organization_id = EXCLUDED.organization_id,
                    organization_name = EXCLUDED.organization_name,
                    subject = EXCLUDED.subject,
                    description = EXCLUDED.description,
                    status = EXCLUDED.status,
                    priority = EXCLUDED.priority,
                    severity = EXCLUDED.severity,
                    request_type = EXCLUDED.request_type,
                    assignee_id = EXCLUDED.assignee_id,
                    assignee_name = EXCLUDED.assignee_name,
                    group_id = EXCLUDED.group_id,
                    group_name = EXCLUDED.group_name,
                    updated_at = EXCLUDED.updated_at,
                    solved_at = EXCLUDED.solved_at,
                    closed_at = EXCLUDED.closed_at,
                    tags = EXCLUDED.tags,
                    custom_fields = EXCLUDED.custom_fields,
                    synced_at = CURRENT_TIMESTAMP
            `, [
                ticket.id,
                ticket.organization_id,
                ticket.organization_id ? `Org-${ticket.organization_id}` : null, // Fetch org name separately if needed
                ticket.subject,
                ticket.description,
                ticket.status,
                ticket.priority,
                severity,
                requestType,
                ticket.assignee_id,
                null, // Fetch assignee name from agents table if needed
                ticket.requester_id,
                null, // Fetch requester name separately if needed
                ticket.group_id,
                null, // Fetch group name from groups table if needed
                ticket.created_at,
                ticket.updated_at,
                ticket.solved_at || null,
                ticket.closed_at || null,
                ticket.due_at || null,
                ticket.tags || [],
                JSON.stringify(ticket.custom_fields || {}),
                false, // Calculate billable status based on your logic
                0 // Calculate billable time from time_entries if needed
            ]);
            synced++;

            // Sync ticket metrics (SLA data)
            await syncTicketMetrics(ticket.id);
        }

        await recordSyncComplete('tickets', synced, startTime);
        console.log(`✅ Tickets sync complete: ${synced} records`);

        // Clear cache after sync
        await clearCache('analytics:*');
        
        return { success: true, synced };
    } catch (error) {
        console.error('❌ Tickets sync failed:', error);
        await recordSyncFailure('tickets', error);
        throw error;
    }
}

// ============================================================================
// TICKET METRICS SYNC
// ============================================================================

async function syncTicketMetrics(ticketId) {
    try {
        const data = await zendeskRequest(`/tickets/${ticketId}/metrics.json`);
        const metrics = data.ticket_metric;

        if (!metrics) return;

        await query(`
            INSERT INTO ticket_metrics (
                ticket_id,
                reply_time_minutes,
                first_reply_time_minutes,
                full_resolution_time_minutes,
                agent_wait_time_minutes,
                requester_wait_time_minutes,
                on_hold_time_minutes,
                sla_first_reply_compliant,
                sla_resolution_compliant,
                reopens,
                replies,
                assignee_updated_at,
                requester_updated_at,
                status_updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (ticket_id) DO UPDATE SET
                reply_time_minutes = EXCLUDED.reply_time_minutes,
                first_reply_time_minutes = EXCLUDED.first_reply_time_minutes,
                full_resolution_time_minutes = EXCLUDED.full_resolution_time_minutes,
                agent_wait_time_minutes = EXCLUDED.agent_wait_time_minutes,
                requester_wait_time_minutes = EXCLUDED.requester_wait_time_minutes,
                on_hold_time_minutes = EXCLUDED.on_hold_time_minutes,
                sla_first_reply_compliant = EXCLUDED.sla_first_reply_compliant,
                sla_resolution_compliant = EXCLUDED.sla_resolution_compliant,
                reopens = EXCLUDED.reopens,
                replies = EXCLUDED.replies,
                assignee_updated_at = EXCLUDED.assignee_updated_at,
                requester_updated_at = EXCLUDED.requester_updated_at,
                status_updated_at = EXCLUDED.status_updated_at,
                updated_at = CURRENT_TIMESTAMP
        `, [
            ticketId,
            metrics.reply_time_in_minutes?.calendar || null,
            metrics.first_resolution_time_in_minutes?.calendar || null,
            metrics.full_resolution_time_in_minutes?.calendar || null,
            metrics.agent_wait_time_in_minutes?.calendar || null,
            metrics.requester_wait_time_in_minutes?.calendar || null,
            metrics.on_hold_time_in_minutes?.calendar || null,
            metrics.sla_breach?.first_reply_time ? false : true,
            metrics.sla_breach?.resolution_time ? false : true,
            metrics.reopens || 0,
            metrics.replies || 0,
            metrics.assignee_updated_at,
            metrics.requester_updated_at,
            metrics.status_updated_at
        ]);
    } catch (error) {
        // Metrics might not exist for all tickets - that's ok
        console.warn(`⚠️  Could not sync metrics for ticket ${ticketId}`);
    }
}

// ============================================================================
// SCHEDULER
// ============================================================================

let syncIntervals = {};

/**
 * Schedule all sync jobs
 */
function scheduleSync() {
    console.log('📅 Scheduling sync jobs...');

    // Initial sync on startup (with delays to avoid rate limits)
    setTimeout(() => syncOrganizations().catch(console.error), 5000);
    setTimeout(() => syncAgents().catch(console.error), 10000);
    setTimeout(() => syncGroups().catch(console.error), 15000);
    setTimeout(() => syncTickets(false).catch(console.error), 20000);

    // Schedule recurring syncs
    syncIntervals.organizations = setInterval(
        () => syncOrganizations().catch(console.error),
        SYNC_INTERVALS.organizations
    );

    syncIntervals.agents = setInterval(
        () => syncAgents().catch(console.error),
        SYNC_INTERVALS.agents
    );

    syncIntervals.groups = setInterval(
        () => syncGroups().catch(console.error),
        SYNC_INTERVALS.groups
    );

    syncIntervals.tickets = setInterval(
        () => syncTickets(false).catch(console.error),
        SYNC_INTERVALS.tickets
    );

    console.log('✅ Sync jobs scheduled');
}

/**
 * Stop all sync jobs
 */
function stopSync() {
    console.log('🛑 Stopping sync jobs...');
    Object.values(syncIntervals).forEach(interval => clearInterval(interval));
    syncIntervals = {};
}

// ============================================================================
// MANUAL SYNC TRIGGERS
// ============================================================================

/**
 * Trigger manual sync for specific entity type
 */
async function triggerSync(entityType, options = {}) {
    console.log(`🔧 Manual sync triggered: ${entityType}`);

    switch (entityType) {
        case 'organizations':
            return await syncOrganizations();
        case 'agents':
            return await syncAgents();
        case 'groups':
            return await syncGroups();
        case 'tickets':
            return await syncTickets(options.fullSync || false);
        case 'all':
            const results = {};
            results.organizations = await syncOrganizations();
            results.agents = await syncAgents();
            results.groups = await syncGroups();
            results.tickets = await syncTickets(options.fullSync || false);
            return results;
        default:
            throw new Error(`Unknown entity type: ${entityType}`);
    }
}

module.exports = {
    scheduleSync,
    stopSync,
    triggerSync,
    syncOrganizations,
    syncAgents,
    syncGroups,
    syncTickets
};
