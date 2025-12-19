// services/syncJobs.js
// Optimized background sync jobs with rate limiting and incremental updates
// UPDATED: Added analytics pre-aggregation functions
// FIXED: Timestamp handling - only updates last_sync_at when end_of_stream is reached

const cron = require('node-cron');
const axios = require('axios');
const db = require('../db');
const pool = db.getPool();

// ============================================
// CONFIGURATION
// ============================================

const SYNC_CONFIG = {
  schedules: {
    tickets: '*/5 * * * *',
    organizations: '0 */1 * * *',
    agents: '0 */1 * * *',
    groups: '0 */1 * * *',
    // NEW: Analytics aggregation schedules
    dailyAggregation: '0 2 * * *',      // 2 AM daily
    weeklyAggregation: '0 3 * * 1',     // 3 AM every Monday
    monthlyAggregation: '0 4 1 * *'     // 4 AM first of month
  },
  rateLimits: {
    requestsPerMinute: 700,
    delayBetweenRequests: 7000,
    maxRetries: 3,
    retryDelay: 10000
  },
  batchSizes: {
    tickets: 100,
    organizations: 100,
    agents: 100,
    groups: 100
  }
};

const ZENDESK_CONFIG = {
  subdomain: process.env.ZENDESK_SUBDOMAIN,
  email: process.env.ZENDESK_EMAIL,
  token: process.env.ZENDESK_API_TOKEN
};

const ZENDESK_API_BASE = `https://${ZENDESK_CONFIG.subdomain}.zendesk.com/api/v2`;
const ZENDESK_AUTH = Buffer.from(`${ZENDESK_CONFIG.email}/token:${ZENDESK_CONFIG.token}`).toString('base64');

// ============================================
// UTILITY FUNCTIONS
// ============================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeZendeskRequest(url, retryCount = 0) {
  try {
    console.log(`🔄 Fetching: ${url}`);
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Basic ${ZENDESK_AUTH}`,
        'Content-Type': 'application/json'
      }
    });
    
    const delay = SYNC_CONFIG.rateLimits.delayBetweenRequests;
    console.log(`⏳ Waiting ${delay}ms (rate limit protection)...`);
    await sleep(delay);
    
    return response.data;
    
  } catch (error) {
    if (error.response?.status === 429 && retryCount < SYNC_CONFIG.rateLimits.maxRetries) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '60') * 1000;
      console.log(`⚠️  Rate limited! Retrying after ${retryAfter}ms... (Attempt ${retryCount + 1}/${SYNC_CONFIG.rateLimits.maxRetries})`);
      await sleep(retryAfter);
      return makeZendeskRequest(url, retryCount + 1);
    }
    throw error;
  }
}

// ============================================
// SYNC STATUS MANAGEMENT
// ============================================

async function getSyncStatus(resourceType) {
  try {
    const result = await pool.query(
      'SELECT * FROM sync_status WHERE entity_type = $1',  
      [resourceType]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error(`Error getting sync status for ${resourceType}:`, error.message);
    return null;
  }
}

// FIXED: Added updateTimestamp parameter to control when last_sync_at is updated
// AND newTimestamp parameter to save cursor position for continuation
async function updateSyncStatus(resourceType, status, error = null, recordsSynced = 0, updateTimestamp = false, newTimestamp = null) {
  try {
    let query;
    let params;
    
    if (newTimestamp) {
      // Save the specific timestamp for continuation (even if not at end_of_stream)
      query = `
        INSERT INTO sync_status (entity_type, last_sync_at, status, error_message, records_synced, updated_at)  
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (entity_type) 
        DO UPDATE SET
          last_sync_at = $2,
          status = $3,
          error_message = $4,
          records_synced = EXCLUDED.records_synced + $5,
          updated_at = NOW()
      `;
      params = [resourceType, newTimestamp, status, error, recordsSynced];
    } else if (updateTimestamp) {
      // Update last_sync_at to NOW() - used when sync is complete
      query = `
        INSERT INTO sync_status (entity_type, last_sync_at, status, error_message, records_synced, updated_at)  
        VALUES ($1, NOW(), $2, $3, $4, NOW())
        ON CONFLICT (entity_type) 
        DO UPDATE SET
          last_sync_at = NOW(),
          status = $2,
          error_message = $3,
          records_synced = EXCLUDED.records_synced + $4,
          updated_at = NOW()
      `;
      params = [resourceType, status, error, recordsSynced];
    } else {
      // Keep existing last_sync_at - used during historical backfill
      query = `
        INSERT INTO sync_status (entity_type, last_sync_at, status, error_message, records_synced, updated_at)  
        VALUES ($1, NOW(), $2, $3, $4, NOW())
        ON CONFLICT (entity_type) 
        DO UPDATE SET
          status = $2,
          error_message = $3,
          records_synced = EXCLUDED.records_synced + $4,
          updated_at = NOW()
      `;
      params = [resourceType, status, error, recordsSynced];
    }
    
    await pool.query(query, params);
  } catch (err) {
    console.error(`Error updating sync status for ${resourceType}:`, err.message);
  }
}

// ============================================
// TICKET SYNC (FIXED TIMESTAMP HANDLING)
// ============================================

async function syncTickets() {
  console.log('\n🎫 Starting ticket sync...');
  
  try {
    const status = await getSyncStatus('tickets');
    
    // FIX: Properly handle the timestamp
    let startTime;
    if (status && status.last_sync_at) {
      const lastUpdate = new Date(status.last_sync_at);
      startTime = Math.floor(lastUpdate.getTime() / 1000); // Convert to seconds
    } else {
      // Default to 90 days ago
      startTime = Math.floor((Date.now() - (90 * 24 * 60 * 60 * 1000)) / 1000);
    }
    
    console.log(`📅 Last sync: ${status?.last_sync_at || 'Never'}`);
    console.log(`⏰ Using start_time: ${startTime} (${new Date(startTime * 1000).toISOString()})`);
    
    await updateSyncStatus('tickets', 'syncing');
    
    let totalTicketsSynced = 0;
    let page = 1;
    let hasMore = true;
    let endOfStream = false;
    let currentStartTime = startTime;
    
    // Fetch up to 50 pages (5000 tickets) per sync
    // CRITICAL: Save each page immediately to avoid memory issues
    while (hasMore && page <= 50) {
      const url = `${ZENDESK_API_BASE}/incremental/tickets.json?start_time=${startTime}&per_page=${SYNC_CONFIG.batchSizes.tickets}&include=metric_sets`;
      console.log(`🔄 Fetching incremental page ${page}...`);
      
      const data = await makeZendeskRequest(url);

      if (data.tickets && data.tickets.length > 0) {
        // Extract metric_sets from response and create lookup map
        const metricSetsMap = new Map();
        if (data.metric_sets && data.metric_sets.length > 0) {
          data.metric_sets.forEach(ms => {
            metricSetsMap.set(ms.ticket_id, ms);
          });
          console.log(`📊 Extracted ${data.metric_sets.length} metric_sets`);
        }
        
        // Save tickets IMMEDIATELY after fetching (stream processing)
        let savedCount = 0;
        for (const ticket of data.tickets) {
          // Attach metric_set to ticket
          ticket.metric_set = metricSetsMap.get(ticket.id) || null;
          try {
            await pool.query(`
              INSERT INTO tickets (
                id, subject, description, status, priority, request_type,
                created_at, updated_at, requester_id, assignee_id,
                organization_id, group_id, tags, custom_fields,
                metric_set, reply_count, comment_count, reopens,
                first_resolution_time_minutes, full_resolution_time_minutes,
                agent_wait_time_minutes, requester_wait_time_minutes, on_hold_time_minutes
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb,
                $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23)
              ON CONFLICT (id) DO UPDATE SET
                subject = EXCLUDED.subject,
                description = EXCLUDED.description,
                status = EXCLUDED.status,
                priority = EXCLUDED.priority,
                request_type = EXCLUDED.request_type,
                updated_at = EXCLUDED.updated_at,
                assignee_id = EXCLUDED.assignee_id,
                group_id = EXCLUDED.group_id,
                tags = EXCLUDED.tags,
                custom_fields = EXCLUDED.custom_fields,
                metric_set = EXCLUDED.metric_set,
                reply_count = EXCLUDED.reply_count,
                comment_count = EXCLUDED.comment_count,
                reopens = EXCLUDED.reopens,
                first_resolution_time_minutes = EXCLUDED.first_resolution_time_minutes,
                full_resolution_time_minutes = EXCLUDED.full_resolution_time_minutes,
                agent_wait_time_minutes = EXCLUDED.agent_wait_time_minutes,
                requester_wait_time_minutes = EXCLUDED.requester_wait_time_minutes,
                on_hold_time_minutes = EXCLUDED.on_hold_time_minutes
            `, [
              ticket.id,
              ticket.subject,
              ticket.description,
              ticket.status,
              ticket.priority,
              ticket.type,
              ticket.created_at,
              ticket.updated_at,
              ticket.requester_id,
              ticket.assignee_id,
              ticket.organization_id,
              ticket.group_id,
              JSON.stringify(ticket.tags),
              JSON.stringify(ticket.custom_fields),
              // Metrics fields
              ticket.metric_set ? JSON.stringify(ticket.metric_set) : null,
              ticket.metric_set?.replies ?? null,
              ticket.metric_set?.full_resolution_time_in_minutes?.business ?? null,
              ticket.metric_set?.reopens ?? 0,
              ticket.metric_set?.reply_time_in_minutes?.business ?? null,
              ticket.metric_set?.full_resolution_time_in_minutes?.business ?? null,
              ticket.metric_set?.agent_wait_time_in_minutes?.business ?? null,
              ticket.metric_set?.requester_wait_time_in_minutes?.business ?? null,
              ticket.metric_set?.on_hold_time_in_minutes?.business ?? null
            ]);
            savedCount++;
          } catch (err) {
            console.error(`Error upserting ticket ${ticket.id}:`, err.message);
          }
        }
        
        totalTicketsSynced += savedCount;
        console.log(`✅ Saved ${savedCount} tickets from page ${page} (Total synced: ${totalTicketsSynced})`);
        
        // CRITICAL: Use end_time from response for next request
        if (data.end_time) {
          currentStartTime = data.end_time;
        }
        
        // Track if we've reached the end of the stream
        endOfStream = data.end_of_stream;
        hasMore = !endOfStream;
        page++;
      } else {
        hasMore = false;
        endOfStream = true; // No more data means we're at the end
      }
    }
    
    console.log(`📊 Final end_time from Zendesk: ${currentStartTime}`);
    console.log(`📦 Total tickets synced: ${totalTicketsSynced}`);
    console.log(`🏁 End of stream: ${endOfStream}`);
    
    // FIXED: Only update timestamp if we reached end_of_stream
    if (endOfStream) {
      await updateSyncStatus('tickets', 'success', null, totalTicketsSynced, true);
      console.log('✅ Ticket sync completed (end of stream reached)');
    } else {
      // Save the cursor position for next sync but don't update to NOW()
      const newTimestamp = new Date(currentStartTime * 1000).toISOString();
      await updateSyncStatus('tickets', 'success', null, totalTicketsSynced, false, newTimestamp);
      console.log(`✅ Ticket sync paused at ${newTimestamp} (will continue next run)`);
    }
    
  } catch (error) {
    console.error('❌ Ticket sync failed:', error.message);
    await updateSyncStatus('tickets', 'error', error.message);
  }
}

// ============================================
// ORGANIZATION SYNC
// ============================================

async function syncOrganizations() {
  console.log('\n🏢 Starting organization sync...');
  
  try {
    await updateSyncStatus('organizations', 'syncing');
    
    let allOrganizations = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const url = `${ZENDESK_API_BASE}/organizations.json?per_page=${SYNC_CONFIG.batchSizes.organizations}&page=${page}`;
      const data = await makeZendeskRequest(url);
      
      if (data.organizations && data.organizations.length > 0) {
        allOrganizations.push(...data.organizations);
        console.log(`✅ Retrieved ${data.organizations.length} organizations (Total: ${allOrganizations.length})`);
        hasMore = data.next_page !== null;
        page++;
      } else {
        hasMore = false;
      }
    }
    
    if (allOrganizations.length > 0) {
      for (const org of allOrganizations) {
        try {
          await pool.query(`
            INSERT INTO organizations (
              id, name, created_at, updated_at, domain_names, details, notes, tags
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              updated_at = EXCLUDED.updated_at,
              domain_names = EXCLUDED.domain_names,
              details = EXCLUDED.details,
              notes = EXCLUDED.notes,
              tags = EXCLUDED.tags
          `, [
            org.id,
            org.name,
            org.created_at,
            org.updated_at,
            JSON.stringify(org.domain_names),
            org.details,
            org.notes,
            JSON.stringify(org.tags)
          ]);
        } catch (err) {
          console.error(`Error upserting organization ${org.id}:`, err.message);
        }
      }
    }
    
    await updateSyncStatus('organizations', 'success', null, allOrganizations.length, true);
    console.log(`✅ Organization sync completed: ${allOrganizations.length} synced`);
    
  } catch (error) {
    console.error('❌ Organization sync failed:', error.message);
    await updateSyncStatus('organizations', 'error', error.message);
  }
}

// ============================================
// AGENT SYNC
// ============================================

async function syncAgents() {
  console.log('\n👤 Starting agent sync...');
  
  try {
    await updateSyncStatus('agents', 'syncing');
    
    let allAgents = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const url = `${ZENDESK_API_BASE}/users.json?role[]=agent&role[]=admin&per_page=${SYNC_CONFIG.batchSizes.agents}&page=${page}`;
      const data = await makeZendeskRequest(url);
      
      if (data.users && data.users.length > 0) {
        allAgents.push(...data.users);
        console.log(`✅ Retrieved ${data.users.length} agents (Total: ${allAgents.length})`);
        hasMore = data.next_page !== null;
        page++;
      } else {
        hasMore = false;
      }
    }
    
    if (allAgents.length > 0) {
      for (const agent of allAgents) {
        try {
          await pool.query(`
            INSERT INTO agents (
              id, name, email, role, created_at, updated_at, last_login_at, active, suspended, tags
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              email = EXCLUDED.email,
              role = EXCLUDED.role,
              updated_at = EXCLUDED.updated_at,
              last_login_at = EXCLUDED.last_login_at,
              active = EXCLUDED.active,
              suspended = EXCLUDED.suspended,
              tags = EXCLUDED.tags
          `, [
            agent.id,
            agent.name,
            agent.email,
            agent.role,
            agent.created_at,
            agent.updated_at,
            agent.last_login_at,
            agent.active,
            agent.suspended,
            JSON.stringify(agent.tags)
          ]);
        } catch (err) {
          console.error(`Error upserting agent ${agent.id}:`, err.message);
        }
      }
    }
    
    await updateSyncStatus('agents', 'success', null, allAgents.length, true);
    console.log(`✅ Agent sync completed: ${allAgents.length} synced`);
    
  } catch (error) {
    console.error('❌ Agent sync failed:', error.message);
    await updateSyncStatus('agents', 'error', error.message);
  }
}

// ============================================
// GROUP SYNC
// ============================================

async function syncGroups() {
  console.log('\n👥 Starting group sync...');
  
  try {
    await updateSyncStatus('groups', 'syncing');
    
    let allGroups = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const url = `${ZENDESK_API_BASE}/groups.json?per_page=${SYNC_CONFIG.batchSizes.groups}&page=${page}`;
      const data = await makeZendeskRequest(url);
      
      if (data.groups && data.groups.length > 0) {
        allGroups.push(...data.groups);
        console.log(`✅ Retrieved ${data.groups.length} groups (Total: ${allGroups.length})`);
        hasMore = data.next_page !== null;
        page++;
      } else {
        hasMore = false;
      }
    }
    
    if (allGroups.length > 0) {
      for (const group of allGroups) {
        try {
          await pool.query(`
            INSERT INTO groups (
              id, name, created_at, updated_at, deleted
            ) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              updated_at = EXCLUDED.updated_at,
              deleted = EXCLUDED.deleted
          `, [
            group.id,
            group.name,
            group.created_at,
            group.updated_at,
            group.deleted
          ]);
        } catch (err) {
          console.error(`Error upserting group ${group.id}:`, err.message);
        }
      }
    }
    
    await updateSyncStatus('groups', 'success', null, allGroups.length, true);
    console.log(`✅ Group sync completed: ${allGroups.length} synced`);
    
  } catch (error) {
    console.error('❌ Group sync failed:', error.message);
    await updateSyncStatus('groups', 'error', error.message);
  }
}

// ============================================
// ANALYTICS AGGREGATION FUNCTIONS (NEW)
// ============================================

/**
 * Aggregate daily analytics from tickets table
 * Runs at 2 AM daily to aggregate yesterday's data
 */
async function aggregateDailyAnalytics(targetDate = null) {
  // Default to yesterday if no date provided
  const date = targetDate || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dateStr = date.toISOString().split('T')[0];
  
  console.log(`\n📊 Starting daily analytics aggregation for ${dateStr}...`);
  
  try {
    // Log start of aggregation
    await pool.query(`
      INSERT INTO aggregation_log (aggregation_type, date_processed, status)
      VALUES ('daily', $1, 'running')
      ON CONFLICT (aggregation_type, date_processed) 
      DO UPDATE SET status = 'running', started_at = NOW()
    `, [dateStr]);

    // Aggregate by organization, agent, group, priority
    const result = await pool.query(`
      INSERT INTO analytics_daily (
        date, organization_id, agent_id, group_id, priority,
        tickets_created, tickets_solved, tickets_closed, tickets_reopened,
        total_time_minutes, billable_time_minutes,
        avg_first_reply_minutes, avg_full_resolution_minutes,
        avg_agent_wait_minutes, avg_requester_wait_minutes,
        sla_met, sla_breached,
        one_touch_count, two_touch_count, multi_touch_count,
        updated_at
      )
      SELECT
        $1::date as date,
        organization_id,
        assignee_id as agent_id,
        group_id,
        priority,
        
        -- Volume metrics
        COUNT(*) FILTER (WHERE DATE(created_at) = $1::date) as tickets_created,
        COUNT(*) FILTER (WHERE status = 'solved' AND DATE(updated_at) = $1::date) as tickets_solved,
        COUNT(*) FILTER (WHERE status = 'closed' AND DATE(updated_at) = $1::date) as tickets_closed,
        COALESCE(SUM(reopens), 0) as tickets_reopened,
        
        -- Time metrics (using your existing columns)
        COALESCE(SUM(agent_wait_time_minutes), 0) as total_time_minutes,
        COALESCE(SUM(
          CASE WHEN tags::text ILIKE '%billable%' THEN agent_wait_time_minutes ELSE 0 END
        ), 0) as billable_time_minutes,
        
        -- Average time metrics
        ROUND(AVG(first_resolution_time_minutes) FILTER (WHERE first_resolution_time_minutes > 0)) as avg_first_reply_minutes,
        ROUND(AVG(full_resolution_time_minutes) FILTER (WHERE full_resolution_time_minutes > 0)) as avg_full_resolution_minutes,
        ROUND(AVG(agent_wait_time_minutes) FILTER (WHERE agent_wait_time_minutes > 0)) as avg_agent_wait_minutes,
        ROUND(AVG(requester_wait_time_minutes) FILTER (WHERE requester_wait_time_minutes > 0)) as avg_requester_wait_minutes,
        
        -- SLA metrics (adjust threshold based on your SLA targets)
        COUNT(*) FILTER (
          WHERE status IN ('solved', 'closed') 
          AND first_resolution_time_minutes IS NOT NULL
          AND first_resolution_time_minutes <= CASE 
            WHEN priority = 'urgent' THEN 60
            WHEN priority = 'high' THEN 240
            WHEN priority = 'normal' THEN 480
            ELSE 1440
          END
        ) as sla_met,
        COUNT(*) FILTER (
          WHERE status IN ('solved', 'closed') 
          AND first_resolution_time_minutes IS NOT NULL
          AND first_resolution_time_minutes > CASE 
            WHEN priority = 'urgent' THEN 60
            WHEN priority = 'high' THEN 240
            WHEN priority = 'normal' THEN 480
            ELSE 1440
          END
        ) as sla_breached,
        
        -- Touch metrics (based on reply_count)
        COUNT(*) FILTER (WHERE status IN ('solved', 'closed') AND COALESCE(reply_count, 0) <= 1) as one_touch_count,
        COUNT(*) FILTER (WHERE status IN ('solved', 'closed') AND reply_count = 2) as two_touch_count,
        COUNT(*) FILTER (WHERE status IN ('solved', 'closed') AND reply_count > 2) as multi_touch_count,
        
        NOW() as updated_at
        
      FROM tickets
      WHERE (
        DATE(created_at) = $1::date
        OR (status IN ('solved', 'closed') AND DATE(updated_at) = $1::date)
      )
      GROUP BY organization_id, assignee_id, group_id, priority
      
      ON CONFLICT ON CONSTRAINT analytics_daily_unique
      DO UPDATE SET
        tickets_created = EXCLUDED.tickets_created,
        tickets_solved = EXCLUDED.tickets_solved,
        tickets_closed = EXCLUDED.tickets_closed,
        tickets_reopened = EXCLUDED.tickets_reopened,
        total_time_minutes = EXCLUDED.total_time_minutes,
        billable_time_minutes = EXCLUDED.billable_time_minutes,
        avg_first_reply_minutes = EXCLUDED.avg_first_reply_minutes,
        avg_full_resolution_minutes = EXCLUDED.avg_full_resolution_minutes,
        avg_agent_wait_minutes = EXCLUDED.avg_agent_wait_minutes,
        avg_requester_wait_minutes = EXCLUDED.avg_requester_wait_minutes,
        sla_met = EXCLUDED.sla_met,
        sla_breached = EXCLUDED.sla_breached,
        one_touch_count = EXCLUDED.one_touch_count,
        two_touch_count = EXCLUDED.two_touch_count,
        multi_touch_count = EXCLUDED.multi_touch_count,
        updated_at = NOW()
    `, [dateStr]);

    const recordCount = result.rowCount || 0;
    
    // Log completion
    await pool.query(`
      UPDATE aggregation_log 
      SET status = 'success', completed_at = NOW(), records_created = $1
      WHERE aggregation_type = 'daily' AND date_processed = $2
    `, [recordCount, dateStr]);

    console.log(`✅ Daily aggregation complete: ${recordCount} records for ${dateStr}`);
    return { success: true, date: dateStr, records: recordCount };
    
  } catch (error) {
    console.error(`❌ Daily aggregation failed for ${dateStr}:`, error.message);
    
    await pool.query(`
      UPDATE aggregation_log 
      SET status = 'error', completed_at = NOW(), error_message = $1
      WHERE aggregation_type = 'daily' AND date_processed = $2
    `, [error.message, dateStr]);
    
    return { success: false, date: dateStr, error: error.message };
  }
}

/**
 * Aggregate weekly agent performance
 * Runs Monday at 3 AM to aggregate last week's data
 */
async function aggregateWeeklyAgentPerformance(targetWeekStart = null) {
  // Default to last week's Monday
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const lastMonday = new Date(now);
  lastMonday.setDate(now.getDate() - daysToLastMonday - 7);
  lastMonday.setHours(0, 0, 0, 0);
  
  const weekStart = targetWeekStart || lastMonday;
  const weekStartStr = weekStart.toISOString().split('T')[0];
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = weekEnd.toISOString().split('T')[0];
  
  console.log(`\n📊 Aggregating weekly agent performance for week of ${weekStartStr}...`);
  
  try {
    const result = await pool.query(`
      INSERT INTO analytics_agent_weekly (
        week_start, agent_id,
        tickets_solved, tickets_touched, total_hours,
        avg_resolution_minutes, avg_first_reply_minutes,
        sla_compliance_rate, one_touch_rate, two_touch_rate,
        updated_at
      )
      SELECT
        $1::date as week_start,
        assignee_id as agent_id,
        
        COUNT(*) FILTER (WHERE status IN ('solved', 'closed')) as tickets_solved,
        COUNT(*) as tickets_touched,
        ROUND(SUM(agent_wait_time_minutes)::numeric / 60, 2) as total_hours,
        
        ROUND(AVG(full_resolution_time_minutes) FILTER (WHERE full_resolution_time_minutes > 0)) as avg_resolution_minutes,
        ROUND(AVG(first_resolution_time_minutes) FILTER (WHERE first_resolution_time_minutes > 0)) as avg_first_reply_minutes,
        
        -- SLA compliance rate
        CASE 
          WHEN COUNT(*) FILTER (WHERE status IN ('solved', 'closed') AND first_resolution_time_minutes IS NOT NULL) > 0
          THEN ROUND(
            COUNT(*) FILTER (
              WHERE status IN ('solved', 'closed') 
              AND first_resolution_time_minutes <= CASE 
                WHEN priority = 'urgent' THEN 60
                WHEN priority = 'high' THEN 240
                WHEN priority = 'normal' THEN 480
                ELSE 1440
              END
            )::numeric / 
            COUNT(*) FILTER (WHERE status IN ('solved', 'closed') AND first_resolution_time_minutes IS NOT NULL) * 100, 1
          )
          ELSE NULL
        END as sla_compliance_rate,
        
        -- Touch rates
        CASE 
          WHEN COUNT(*) FILTER (WHERE status IN ('solved', 'closed')) > 0
          THEN ROUND(
            COUNT(*) FILTER (WHERE status IN ('solved', 'closed') AND COALESCE(reply_count, 0) <= 1)::numeric / 
            COUNT(*) FILTER (WHERE status IN ('solved', 'closed')) * 100, 1
          )
          ELSE NULL
        END as one_touch_rate,
        
        CASE 
          WHEN COUNT(*) FILTER (WHERE status IN ('solved', 'closed')) > 0
          THEN ROUND(
            COUNT(*) FILTER (WHERE status IN ('solved', 'closed') AND reply_count = 2)::numeric / 
            COUNT(*) FILTER (WHERE status IN ('solved', 'closed')) * 100, 1
          )
          ELSE NULL
        END as two_touch_rate,
        
        NOW() as updated_at
        
      FROM tickets
      WHERE assignee_id IS NOT NULL
        AND updated_at >= $1::date
        AND updated_at < $2::date
      GROUP BY assignee_id
      
      ON CONFLICT (week_start, agent_id)
      DO UPDATE SET
        tickets_solved = EXCLUDED.tickets_solved,
        tickets_touched = EXCLUDED.tickets_touched,
        total_hours = EXCLUDED.total_hours,
        avg_resolution_minutes = EXCLUDED.avg_resolution_minutes,
        avg_first_reply_minutes = EXCLUDED.avg_first_reply_minutes,
        sla_compliance_rate = EXCLUDED.sla_compliance_rate,
        one_touch_rate = EXCLUDED.one_touch_rate,
        two_touch_rate = EXCLUDED.two_touch_rate,
        updated_at = NOW()
    `, [weekStartStr, weekEndStr]);

    console.log(`✅ Weekly agent aggregation complete: ${result.rowCount} agents for week of ${weekStartStr}`);
    return { success: true, weekStart: weekStartStr, records: result.rowCount };
    
  } catch (error) {
    console.error(`❌ Weekly agent aggregation failed:`, error.message);
    return { success: false, weekStart: weekStartStr, error: error.message };
  }
}

/**
 * Aggregate monthly organization performance
 * Runs 1st of month at 4 AM to aggregate last month's data
 */
async function aggregateMonthlyOrgPerformance(targetMonth = null) {
  // Default to last month
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = targetMonth || lastMonth;
  const monthStr = month.toISOString().split('T')[0];
  const nextMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const nextMonthStr = nextMonth.toISOString().split('T')[0];
  
  console.log(`\n📊 Aggregating monthly org performance for ${monthStr.substring(0, 7)}...`);
  
  try {
    const result = await pool.query(`
      INSERT INTO analytics_org_monthly (
        month, organization_id,
        tickets_created, tickets_solved,
        total_hours, billable_hours, avg_resolution_hours,
        sla_compliance_rate, one_touch_rate,
        updated_at
      )
      SELECT
        $1::date as month,
        organization_id,
        
        COUNT(*) FILTER (WHERE DATE(created_at) >= $1::date AND DATE(created_at) < $2::date) as tickets_created,
        COUNT(*) FILTER (WHERE status IN ('solved', 'closed')) as tickets_solved,
        
        ROUND(SUM(agent_wait_time_minutes)::numeric / 60, 2) as total_hours,
        ROUND(SUM(
          CASE WHEN tags::text ILIKE '%billable%' THEN agent_wait_time_minutes ELSE 0 END
        )::numeric / 60, 2) as billable_hours,
        ROUND(AVG(full_resolution_time_minutes)::numeric / 60, 2) as avg_resolution_hours,
        
        -- SLA compliance rate
        CASE 
          WHEN COUNT(*) FILTER (WHERE status IN ('solved', 'closed') AND first_resolution_time_minutes IS NOT NULL) > 0
          THEN ROUND(
            COUNT(*) FILTER (
              WHERE status IN ('solved', 'closed') 
              AND first_resolution_time_minutes <= CASE 
                WHEN priority = 'urgent' THEN 60
                WHEN priority = 'high' THEN 240
                WHEN priority = 'normal' THEN 480
                ELSE 1440
              END
            )::numeric / 
            COUNT(*) FILTER (WHERE status IN ('solved', 'closed') AND first_resolution_time_minutes IS NOT NULL) * 100, 1
          )
          ELSE NULL
        END as sla_compliance_rate,
        
        -- One touch rate
        CASE 
          WHEN COUNT(*) FILTER (WHERE status IN ('solved', 'closed')) > 0
          THEN ROUND(
            COUNT(*) FILTER (WHERE status IN ('solved', 'closed') AND COALESCE(reply_count, 0) <= 1)::numeric / 
            COUNT(*) FILTER (WHERE status IN ('solved', 'closed')) * 100, 1
          )
          ELSE NULL
        END as one_touch_rate,
        
        NOW() as updated_at
        
      FROM tickets
      WHERE organization_id IS NOT NULL
        AND updated_at >= $1::date
        AND updated_at < $2::date
      GROUP BY organization_id
      
      ON CONFLICT (month, organization_id)
      DO UPDATE SET
        tickets_created = EXCLUDED.tickets_created,
        tickets_solved = EXCLUDED.tickets_solved,
        total_hours = EXCLUDED.total_hours,
        billable_hours = EXCLUDED.billable_hours,
        avg_resolution_hours = EXCLUDED.avg_resolution_hours,
        sla_compliance_rate = EXCLUDED.sla_compliance_rate,
        one_touch_rate = EXCLUDED.one_touch_rate,
        updated_at = NOW()
    `, [monthStr, nextMonthStr]);

    console.log(`✅ Monthly org aggregation complete: ${result.rowCount} orgs for ${monthStr.substring(0, 7)}`);
    return { success: true, month: monthStr, records: result.rowCount };
    
  } catch (error) {
    console.error(`❌ Monthly org aggregation failed:`, error.message);
    return { success: false, month: monthStr, error: error.message };
  }
}

/**
 * Backfill historical analytics data
 * Use this to populate analytics_daily for past dates
 */
async function backfillDailyAnalytics(startDate, endDate) {
  console.log(`\n📊 Backfilling daily analytics from ${startDate} to ${endDate}...`);
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  let current = new Date(start);
  let totalRecords = 0;
  let processedDays = 0;
  
  while (current <= end) {
    const result = await aggregateDailyAnalytics(current);
    if (result.success) {
      totalRecords += result.records;
    }
    processedDays++;
    
    // Progress update every 7 days
    if (processedDays % 7 === 0) {
      console.log(`   Processed ${processedDays} days, ${totalRecords} total records...`);
    }
    
    current.setDate(current.getDate() + 1);
  }
  
  console.log(`✅ Backfill complete: ${processedDays} days, ${totalRecords} records`);
  return { days: processedDays, records: totalRecords };
}

/**
 * Get aggregation status for monitoring
 */
async function getAggregationStatus() {
  try {
    const result = await pool.query(`
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
    
    return result.rows;
  } catch (error) {
    console.error('Error getting aggregation status:', error.message);
    return [];
  }
}

// ============================================
// SCHEDULER
// ============================================

function scheduleSync() {
  console.log('🚀 Scheduling background sync jobs...');
  
  // Existing sync jobs
  cron.schedule(SYNC_CONFIG.schedules.tickets, () => {
    console.log('\n⏰ Running scheduled ticket sync...');
    syncTickets().catch(err => console.error('Scheduled ticket sync error:', err));
  });
  
  cron.schedule(SYNC_CONFIG.schedules.organizations, () => {
    console.log('\n⏰ Running scheduled organization sync...');
    syncOrganizations().catch(err => console.error('Scheduled organization sync error:', err));
  });
  
  cron.schedule(SYNC_CONFIG.schedules.agents, () => {
    console.log('\n⏰ Running scheduled agent sync...');
    syncAgents().catch(err => console.error('Scheduled agent sync error:', err));
  });
  
  cron.schedule(SYNC_CONFIG.schedules.groups, () => {
    console.log('\n⏰ Running scheduled group sync...');
    syncGroups().catch(err => console.error('Scheduled group sync error:', err));
  });
  
  // NEW: Analytics aggregation jobs
  cron.schedule(SYNC_CONFIG.schedules.dailyAggregation, () => {
    console.log('\n⏰ Running daily analytics aggregation...');
    aggregateDailyAnalytics()
      .catch(err => console.error('Daily aggregation error:', err));
  });

  cron.schedule(SYNC_CONFIG.schedules.weeklyAggregation, () => {
    console.log('\n⏰ Running weekly agent performance aggregation...');
    aggregateWeeklyAgentPerformance()
      .catch(err => console.error('Weekly aggregation error:', err));
  });

  cron.schedule(SYNC_CONFIG.schedules.monthlyAggregation, () => {
    console.log('\n⏰ Running monthly organization aggregation...');
    aggregateMonthlyOrgPerformance()
      .catch(err => console.error('Monthly aggregation error:', err));
  });
  
  console.log('✅ All sync jobs scheduled successfully');
  console.log('📅 Schedules:');
  console.log(`   - Tickets: ${SYNC_CONFIG.schedules.tickets} (every 5 minutes)`);
  console.log(`   - Organizations: ${SYNC_CONFIG.schedules.organizations} (every hour)`);
  console.log(`   - Agents: ${SYNC_CONFIG.schedules.agents} (every hour)`);
  console.log(`   - Groups: ${SYNC_CONFIG.schedules.groups} (every hour)`);
  console.log(`   - Daily Analytics: ${SYNC_CONFIG.schedules.dailyAggregation} (2 AM daily)`);
  console.log(`   - Weekly Agent Perf: ${SYNC_CONFIG.schedules.weeklyAggregation} (3 AM Mondays)`);
  console.log(`   - Monthly Org Perf: ${SYNC_CONFIG.schedules.monthlyAggregation} (4 AM 1st of month)`);
  
  const initialDelay = Math.floor(Math.random() * 10000) + 10000;
  console.log(`⏳ Initial sync will run in ${initialDelay/1000} seconds...`);
  
  setTimeout(() => {
    console.log('\n🎬 Running initial sync...');
    Promise.all([
      syncOrganizations(),
      syncAgents(),
      syncGroups()
    ]).then(() => {
      console.log('✅ Initial sync of orgs/agents/groups complete');
      return syncTickets();
    }).then(() => {
      console.log('✅ Initial ticket sync complete');
    }).catch(err => {
      console.error('❌ Initial sync error:', err);
    });
  }, initialDelay);
}

module.exports = {
  scheduleSync,
  syncTickets,
  syncOrganizations,
  syncAgents,
  syncGroups,
  getSyncStatus,
  // NEW: Analytics functions
  aggregateDailyAnalytics,
  aggregateWeeklyAgentPerformance,
  aggregateMonthlyOrgPerformance,
  backfillDailyAnalytics,
  getAggregationStatus
};
