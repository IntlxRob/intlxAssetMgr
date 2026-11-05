// routes/api.js
// This file defines all the API endpoints and calls the appropriate service functions.

const express = require('express');
const router = express.Router();
const zendeskService = require('../services/zendesk');
const { authHeader } = require('../services/zendeskAuth');
const googleSheetsService = require('../services/googleSheets');
const { google } = require('googleapis');
const calendar = google.calendar('v3');
const db = require('../db'); 
const pool = db.getPool();

// The ticket-field ids and the derivation rules, from the module the SYNC
// already uses. Importing rather than restating them: two copies of the same
// facts is the shape behind several bugs in this project, and a wrong field id
// here would read one field's options and write to another, with a 200 and no
// complaint.
const {
    computeDerivedFields,
    REQUEST_TYPE_FIELD_ID,
    STARLING_LOCATION_FIELD_ID,
    STARLING_DEPARTMENT_FIELD_ID
} = require('../services/derived');

// Billable's id and computation. Owned by billing.js, which reads it from
// process.env.BILLABLE_FIELD_ID with NO fallback — computeBillable() returns
// false outright when it is unset — so a hardcoded copy here would diverge
// silently the day that variable changes, and this editor would write a field
// the Billable column does not read.
const { BILLABLE_FIELD_ID, computeBillingFields } = require('../services/billing');
const https = require('https'); // PagerDuty OnCall Calendar Webcal
const ical = require('ical'); // PagerDuty OnCall Calendar Webcal

// Initialize OAuth2 client for Google Calendar
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

// Use service account or OAuth2 tokens
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    // For Render.com deployment - JSON stored as env variable
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/calendar']
    });
    google.options({ auth });
} else if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    // For local development - JSON file path
    const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
        scopes: ['https://www.googleapis.com/auth/calendar']
    });
    google.options({ auth });
} else if (process.env.GOOGLE_REFRESH_TOKEN) {
    // OAuth2 with refresh token
    oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });
    google.options({ auth: oauth2Client });
}

// Auto-refresh ServerData token on startup using saved refresh token
(async function initializeFromSavedToken() {
    if (process.env.SERVERDATA_REFRESH_TOKEN && !global.addressBookToken) {
        console.log('[OAuth] Found saved refresh token, attempting to get new access token...');
        
        global.addressBookRefreshToken = process.env.SERVERDATA_REFRESH_TOKEN;
        
        try {
            const clientId = process.env.SERVERDATA_CLIENT_ID;
            const clientSecret = process.env.SERVERDATA_CLIENT_SECRET;

            // No fallback literal. A committed credential behind `||` means the
            // code works whether or not the env var was ever set, so nobody
            // notices - and the secret in source is what authenticates. That is
            // exactly how this one survived: live in Render AND in git history.
            if (!clientId || !clientSecret) {
                console.error(
                    '[OAuth] SERVERDATA_CLIENT_ID / SERVERDATA_CLIENT_SECRET are not set - ' +
                    'skipping address book initialisation.'
                );
                return;
            }
            const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
            
            const response = await fetch('https://login.serverdata.net/user/connect/token', {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${basicAuth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: process.env.SERVERDATA_REFRESH_TOKEN
                })
            });
            
            if (response.ok) {
                const tokenData = await response.json();
                
                global.addressBookToken = tokenData.access_token;
                if (tokenData.refresh_token) {
                    global.addressBookRefreshToken = tokenData.refresh_token;
                    
                    if (tokenData.refresh_token !== process.env.SERVERDATA_REFRESH_TOKEN) {
                        console.log('========================================');
                        console.log('NEW REFRESH TOKEN - Update SERVERDATA_REFRESH_TOKEN in Render:');
                        console.log(tokenData.refresh_token);
                        console.log('========================================');
                    }
                }
                global.addressBookTokenExpiry = Date.now() + ((tokenData.expires_in - 300) * 1000);
                
                console.log('[OAuth] Successfully initialized with saved refresh token');
            } else {
                console.error('[OAuth] Failed to refresh with saved token:', response.status);
            }
        } catch (error) {
            console.error('[OAuth] Error using saved refresh token:', error);
        }
    }
})();

/**
 * Debug endpoint to search for companies containing specific text
 */

/**
 * Debug endpoint to test BILH company discovery
 * GET /api/debug-bilh-companies
 */

/**
 * Cache for SiPortal companies - refreshed periodically
 */
let companiesCache = {
    companies: [],
    lastUpdated: null,
    isUpdating: false
};

/**
 * Refresh the companies cache - FIXED to handle pagination properly
 */
async function refreshCompaniesCache() {
    if (companiesCache.isUpdating) {
        console.log('[Cache] Already updating companies cache, skipping...');
        return;
    }

    try {
        companiesCache.isUpdating = true;
        console.log('[Cache] Refreshing companies cache...');
        
        let allCompanies = [];
        let page = 1;
        let consecutiveEmptyPages = 0;
        
        // Companies endpoint still uses page parameter (not offset)
        while (page <=50) { // Safety limit of 50 pages
            const response = await fetch(`https://www.siportal.net/api/2.0/companies?page=${page}`, {
                method: 'GET',
                headers: {
                    'Authorization': process.env.SIPORTAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.log(`[Cache] API error on page ${page}: ${response.status}`);
                break;
            }

            const data = await response.json();
            const companies = data.data?.results || [];
            
            if (companies.length === 0) {
            consecutiveEmptyPages++;
            console.log(`[Cache] Empty page ${page}, consecutive empty: ${consecutiveEmptyPages}`);
            if (consecutiveEmptyPages >= 2) {
                console.log(`[Cache] Two consecutive empty pages, stopping at page ${page}`);
                break;
            }
            } else {
                consecutiveEmptyPages = 0;
                allCompanies.push(...companies);
                
                // Log every 10th page for progress tracking
                if (page % 10 === 0) {
                    console.log(`[Cache] Page ${page}: ${companies.length} companies (total: ${allCompanies.length})`);
                }
            }
            
            page++;
            
            // Add small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        companiesCache.companies = allCompanies;
        companiesCache.lastUpdated = new Date();
        console.log(`[Cache] Updated companies cache with ${allCompanies.length} companies from ${page-1} pages`);
        
        // Log some sample company names for debugging
        console.log(`[Cache] Sample companies:`, allCompanies.slice(0, 5).map(c => c.name).join(', '));
        
        // Check if Arbella is in the cache
        const arbella = allCompanies.find(c => c.name?.toLowerCase().includes('arbella'));
        if (arbella) {
            console.log(`[Cache] Found Arbella in cache: ID ${arbella.id} - "${arbella.name}"`);
        }
        
    } catch (error) {
        console.error('[Cache] Error refreshing companies cache:', error.message);
    } finally {
        companiesCache.isUpdating = false;
    }
}

/**
 * Filter agents to only show known users from your organization
 */
function filterKnownUsers(agents) {
    if (!agents || !Array.isArray(agents)) {
        return [];
    }
    
    return agents.filter(agent => {
        return agent && 
               !agent.name.startsWith('Unknown User') && 
               !agent.name.includes('Unknown User') &&
               agent.email && 
               agent.email.includes('@intlxsolutions.com');
    });
}

// Helper functions to extract metadata from event descriptions
function extractEventType(description) {
    if (!description) return 'meeting';
    const match = description.match(/\[Event Type: (.*?)\]/);
    return match ? match[1] : 'meeting';
}

function extractTicketId(description) {
    if (!description) return null;
    const match = description.match(/\[Ticket: #(.*?)\]/);
    return match ? match[1] : null;
}

function extractAssetIds(description) {
    if (!description) return [];
    const match = description.match(/\[Assets: (.*?)\]/);
    return match ? match[1].split(',').map(id => id.trim()) : [];
}

/**
 * Advanced company name normalization and matching
 */
function normalizeCompanyName(name) {
    if (!name) return '';
    
    return name
        .toLowerCase()
        .trim()
        // Remove common suffixes
        .replace(/[,.]?\s*(llc|inc|corp|ltd|limited|corporation|company|co\.|co)\.?$/i, '')
        // Normalize punctuation
        .replace(/[.,&]/g, ' ')
        // Handle "and" variations
        .replace(/\s+and\s+/g, ' ')
        .replace(/\s+&\s+/g, ' ')
        // Remove extra spaces
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Generate alternative name variations for better matching
 */
function generateNameVariations(orgName) {
    const variations = new Set();
    const normalized = normalizeCompanyName(orgName);
    
    variations.add(normalized);
    variations.add(orgName.toLowerCase().trim());
    
    // Add acronym variations
    const words = normalized.split(/\s+/).filter(w => w.length > 0);
    if (words.length > 1) {
        // Try first letters of each word
        const acronym = words.map(w => w[0]).join('');
        variations.add(acronym);
        
        // Try abbreviations (keep first word, acronym rest)
        if (words.length > 2) {
            variations.add(words[0] + ' ' + words.slice(1).map(w => w[0]).join(''));
        }
    }
    
    // Add partial matches (for "University of X" vs "X University")
    if (words.length > 2) {
        variations.add(words.slice(-1)[0] + ' ' + words.slice(0, -1).join(' '));
    }
    
    return Array.from(variations);
}

/**
 * Enhanced search with multiple strategies
 */
function searchCompaniesInCache(orgName) {
    const variations = generateNameVariations(orgName);
    let bestMatch = null;
    let bestScore = 0;
    let matchMethod = '';

    for (const company of companiesCache.companies) {
        const companyName = company.name;
        if (!companyName) continue;

        const normalizedCompany = normalizeCompanyName(companyName);
        
        // Try each variation
        for (const variation of variations) {
            let score = 0;
            let method = '';

            // Exact match after normalization
            if (normalizedCompany === variation) {
                return { company, score: 100, method: 'normalized_exact' };
            }

            // Substring matching
            if (normalizedCompany.includes(variation) || variation.includes(normalizedCompany)) {
                score = Math.max(score, 85);
                method = 'substring';
            }

            // Word-based similarity
            const companyWords = normalizedCompany.split(/\s+/);
            const searchWords = variation.split(/\s+/);
            
            if (companyWords.length > 0 && searchWords.length > 0) {
                const matchingWords = searchWords.filter(word => 
                    companyWords.some(cWord => 
                        cWord === word || 
                        (word.length > 2 && cWord.includes(word)) ||
                        (cWord.length > 2 && word.includes(cWord))
                    )
                );
                
                const matchRatio = matchingWords.length / Math.max(searchWords.length, companyWords.length);
                if (matchRatio >= 0.7) {
                    score = Math.max(score, 70 + (matchRatio - 0.7) * 50);
                    method = 'word_similarity';
                }
            }

            // Levenshtein distance for close matches
            if (score === 0 && variation.length > 3 && normalizedCompany.length > 3) {
                const distance = levenshteinDistance(variation, normalizedCompany);
                const maxLen = Math.max(variation.length, normalizedCompany.length);
                const similarity = 1 - (distance / maxLen);
                
                if (similarity >= 0.8) {
                    score = similarity * 60;
                    method = 'edit_distance';
                }
            }

            if (score > bestScore) {
                bestMatch = company;
                bestScore = score;
                matchMethod = method;
            }
        }
    }

    return bestMatch && bestScore >= 60 ? { company: bestMatch, score: bestScore, method: matchMethod } : null;
}

/**
 * Simple Levenshtein distance implementation
 */
function levenshteinDistance(str1, str2) {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    
    return matrix[str2.length][str1.length];
}

/**
 * Endpoint to test the direct connection to the Zendesk API.
 */

/**
 * Endpoint to fetch the service catalog from Google Sheets.
 */
router.get('/catalog', async (req, res) => {
    try {
        const catalog = await googleSheetsService.getCatalog();
        res.json(catalog);
    } catch (error) {
        console.error('Error fetching catalog:', error.message);
        res.status(500).json({ error: 'Failed to fetch catalog from Google Sheets.', details: error.message });
    }
});
/**
 * Fetch manager name and email for a user by their email address.
 * Uses admin credentials so it works for all users regardless of field visibility settings.
 * Called by the service catalog page to auto-fill the Approving Manager section.
 */
router.get('/user-manager-fields', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ error: 'Missing email parameter' });

        const response = await fetch(
            `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/search.json?query=email:${encodeURIComponent(email)}`,
            {
                headers: {
                    'Authorization': await authHeader(),
                }
            }
        );

        if (!response.ok) throw new Error(`Zendesk API error: ${response.status}`);

        const data = await response.json();
        const user = data.users?.[0];
        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({
            manager_name: user.user_fields?.manager_name || '',
            manager_email: user.user_fields?.manager_email || ''
        });

    } catch (error) {
        console.error('Error fetching manager fields:', error.message);
        res.status(500).json({ error: 'Failed to fetch manager fields' });
    }
});



// ============================================
// GET TICKETS WITH PAGINATION & SORTING
// ============================================
/**
 * Get tickets from database with pagination and sorting
 * GET /api/tickets
 * Query params:
 *   - startDate (required): Start date for ticket creation filter
 *   - endDate (required): End date for ticket creation filter
 *   - limit (optional): Number of tickets per page (default: 5000)
 *   - offset (optional): Pagination offset (default: 0)
 *   - organizationId (optional): Filter by organization
 *   - sortBy (optional): Field to sort by (default: created_at)
 *   - sortOrder (optional): asc or desc (default: desc)
 */

router.get('/tickets', async (req, res) => {
  try {
    const { 
      startDate, 
      endDate, 
      limit = 5000,           // ✅ Default 5000 per page
      offset = 0,             // ✅ Pagination offset
      organizationId,
      sortBy = 'created_at',  // ✅ Default sort field
      sortOrder = 'desc'      // ✅ Default newest first
    } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ 
        error: 'startDate and endDate are required' 
      });
    }

    // Validate sort order
    const validSortOrder = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    
    // Validate sort field (prevent SQL injection)
    const validSortFields = [
      'created_at', 'updated_at', 'id', 'status', 
      'priority', 'organization_id', 'assignee_id'
    ];
    const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'created_at';

    console.log(`📊 Fetching tickets: ${startDate} to ${endDate}`);
    console.log(`📄 Pagination: limit=${limit}, offset=${offset}`);
    console.log(`🔄 Sorting: ${safeSortBy} ${validSortOrder}`);

    // Build PostgreSQL query with $1, $2, $3 placeholders
    let query = `
      SELECT 
        t.id,
        t.subject,
        t.description,
        t.status,
        t.priority,
        t.request_type,
        t.created_at,
        t.updated_at,
        t.requester_id,
        t.assignee_id,
        t.organization_id,
        t.group_id,
        t.tags,
        t.custom_fields,
        t.metric_set,
        t.reply_count,
        t.comment_count,
        t.reopens,
        t.first_resolution_time_minutes,
        t.full_resolution_time_minutes,
        t.agent_wait_time_minutes,
        t.requester_wait_time_minutes,
        t.on_hold_time_minutes
      FROM tickets t
      WHERE t.created_at >= $1
        AND t.created_at <= $2
    `;

    const params = [startDate, endDate];
    let paramIndex = 3;

    // Add organization filter if provided
    if (organizationId) {
      query += ` AND t.organization_id = $${paramIndex}`;
      params.push(organizationId);
      paramIndex++;
    }

    // Add sorting (safely injected, validated above)
    query += ` ORDER BY t.${safeSortBy} ${validSortOrder}`;

    // Add pagination
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const startTime = Date.now();
    const result = await pool.query(query, params);
    const queryTime = Date.now() - startTime;

    console.log(`✅ Fetched ${result.rows.length} tickets in ${queryTime}ms`);

    // PostgreSQL may store JSON fields as JSONB (already parsed) or as text
    // Try to parse if they're strings, otherwise use as-is
    const processedTickets = result.rows.map(ticket => ({
      ...ticket,
      tags: ticket.tags || [],
      custom_fields: ticket.custom_fields || [],
      metric_set: ticket.metric_set || null
    }));

    res.json({
      tickets: processedTickets,
      count: processedTickets.length,
      limit: parseInt(limit),
      offset: parseInt(offset),
      queryTime: queryTime
    });

  } catch (error) {
    console.error('❌ Error fetching tickets:', error);
    res.status(500).json({ 
      error: 'Failed to fetch tickets',
      message: error.message 
    });
  }
});

/**
 * Agent Time Report: Returns tickets where time was logged by a given agent
 * within a date range based on updated_at. Optionally filter by assignee_id.
 */
router.get('/tickets/agent-time-report', async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      assigneeId,
      limit = 10000,
      offset = 0
    } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const TIME_FIELD_ID = 17213443224599;

    let query = `
      SELECT
        t.id,
        t.subject,
        t.status,
        t.priority,
        t.created_at,
        t.updated_at,
        t.assignee_id,
        t.organization_id,
        t.group_id,
        t.tags,
        t.custom_fields,
        t.metric_set,
        t.reply_count,
        t.comment_count
      FROM tickets t
      WHERE t.updated_at >= $1
        AND t.updated_at <= $2
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(t.custom_fields) cf
          WHERE (cf->>'id')::bigint = ${TIME_FIELD_ID}
            AND cf->>'value' IS NOT NULL
            AND cf->>'value' != ''
            AND cf->>'value' != '0'
            AND (cf->>'value') ~ '^[0-9]+$'
AND (cf->>'value')::bigint > 0
        )
    `;

    const params = [startDate, endDate];
    let paramIndex = 3;

    if (assigneeId) {
      query += ` AND t.assignee_id = $${paramIndex}`;
      params.push(parseInt(assigneeId));
      paramIndex++;
    }

    query += ` ORDER BY t.updated_at DESC`;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const startTime = Date.now();
    const result = await pool.query(query, params);
    const queryTime = Date.now() - startTime;

    let countQuery = `
      SELECT COUNT(*) FROM tickets t
      WHERE t.updated_at >= $1
        AND t.updated_at <= $2
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(t.custom_fields) cf
          WHERE (cf->>'id')::bigint = ${TIME_FIELD_ID}
            AND cf->>'value' IS NOT NULL
            AND cf->>'value' != ''
            AND cf->>'value' != '0'
            AND (cf->>'value') ~ '^[0-9]+$'
AND (cf->>'value')::bigint > 0
        )
    `;
    const countParams = [startDate, endDate];
    if (assigneeId) {
      countQuery += ` AND t.assignee_id = $3`;
      countParams.push(parseInt(assigneeId));
    }
    const countResult = await pool.query(countQuery, countParams);
    const totalCount = parseInt(countResult.rows[0].count);

    const processedTickets = result.rows.map(ticket => ({
      ...ticket,
      tags: ticket.tags || [],
      custom_fields: ticket.custom_fields || [],
      metric_set: ticket.metric_set || null
    }));

    console.log(`✅ Agent time report: ${processedTickets.length} tickets in ${queryTime}ms`);

    res.json({
      tickets: processedTickets,
      count: processedTickets.length,
      totalCount,
      queryTime
    });

  } catch (error) {
    console.error('❌ Error in agent-time-report:', error);
    res.status(500).json({ error: 'Failed to fetch agent time report', message: error.message });
  }
});

/**
 * Time Entries Report: Returns individual agent time entries from ticket_time_entries table
 */
router.get('/time-entries', async (req, res) => {
  try {
    const { startDate, endDate, assigneeId, limit = 10000, offset = 0 } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    let query = `
      SELECT
        te.id,
        te.ticket_event_id,
        te.ticket_id,
        te.agent_id,
        te.time_seconds,
        te.total_time_seconds,
        te.created_at,
        t.subject,
        t.status,
        t.organization_id,
        t.group_id,
        t.assignee_id AS ticket_assignee_id,
        t.custom_fields,
        t.tags,
        a.name AS agent_name
      FROM ticket_time_entries te
      LEFT JOIN tickets t ON t.id = te.ticket_id
      LEFT JOIN agents a ON a.id = te.agent_id
      WHERE te.created_at >= $1
        AND te.created_at <= $2
        AND te.time_seconds > 0
    `;

    const params = [startDate, endDate];
    let paramIndex = 3;

    if (assigneeId) {
      query += ` AND te.agent_id = $${paramIndex}`;
      params.push(parseInt(assigneeId));
      paramIndex++;
    }

    query += ` ORDER BY te.created_at DESC`;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const startTime = Date.now();
    const result = await pool.query(query, params);
    const queryTime = Date.now() - startTime;

    console.log(`✅ Time entries report: ${result.rows.length} entries in ${queryTime}ms`);

    res.json({
      entries: result.rows,
      count: result.rows.length,
      queryTime
    });

  } catch (error) {
    console.error('❌ Error in time-entries:', error);
    res.status(500).json({ error: 'Failed to fetch time entries', message: error.message });
  }
});

/**
 * Endpoint to create a new ticket and associated asset records.
 */
router.post('/ticket', async (req, res) => {
    try {
        const { name, email, subject, body, approved_by, approved_by_email, tags, assets } = req.body;

        // ---- Update manager fields on the requester's Zendesk profile ----
        // This ensures ticket.requester.manager_email always matches what was submitted,
        // so the Approve app sends the approval request to the correct person.
        if (email && (approved_by || approved_by_email)) {
            try {
                // First find the user by email
                const searchRes = await fetch(
                    `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/search.json?query=email:${encodeURIComponent(email)}`,
                    { headers: { 'Authorization': await authHeader() } }
                );
                const searchData = await searchRes.json();
                const zendeskUser = searchData.users?.[0];

                if (zendeskUser) {
                    await fetch(
                        `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${zendeskUser.id}.json`,
                        {
                            method: 'PUT',
                            headers: {
                                'Authorization': await authHeader(),
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                user: {
                                    user_fields: {
                                        manager_name: approved_by || '',
                                        manager_email: approved_by_email || ''
                                    }
                                }
                            })
                        }
                    );
                    console.log(`[Ticket] Updated manager fields for ${email}: ${approved_by} <${approved_by_email}>`);
                }
            } catch (managerUpdateErr) {
                // Non-fatal — log but continue with ticket creation
                console.warn('[Ticket] Failed to update manager fields:', managerUpdateErr.message);
            }
        }
        // ------------------------------------------------------------------

        // Handle new React app format if assets are provided
        if (assets && Array.isArray(assets)) {
            const ticketDescription = `
New Asset Catalog Request

Requester: ${name} (${email})
Approved by: ${approved_by}

Requested Assets:
${assets.map(asset => `
- Asset Name: ${asset.asset_name}
- Manufacturer: ${asset.manufacturer}
- Model Number: ${asset.model_number}
- Serial Number: ${asset.serial_number || 'N/A'}
- Status: ${asset.status || 'N/A'}
`).join('')}
            `.trim();

            const ticketData = {
                subject: subject || 'New Asset Catalog Request',
                description: ticketDescription,
                type: 'task',
                priority: 'normal',
                requester: {
                    name: name,
                    email: email
                },
                tags: tags || []
            };

            const ticket = await zendeskService.createTicket(ticketData);
            res.status(201).json({ ticket });
        } else {
            // Handle service catalog format
            const ticketData = {
                subject: subject || 'New Service Catalog Request',
                description: body || 'Service catalog request',
                type: 'task',
                priority: 'normal',
                requester: {
                    name: name,
                    email: email
                },
                tags: tags || [],
                comment: {
                    html_body: body || 'Service catalog request'
                }
            };

            const ticket = await zendeskService.createTicket(ticketData);
            console.log('Ticket created successfully:', ticket.id);
            res.status(201).json({ ticket });
        }
    } catch (error) {
        console.error('Error in the /api/ticket POST endpoint:', error.message);
        res.status(500).json({ error: 'Failed to create ticket.', details: error.message });
    }
});

/**
 * Handle CORS preflight for upload endpoint
 */
router.options('/zendesk/upload', (req, res) => {
    // Don't set headers - let global CORS middleware handle it
    res.sendStatus(200);
});

/**
 * Upload file to Zendesk (for attachments)
 * POST /api/zendesk/upload
 */
router.post('/zendesk/upload', async (req, res) => {
    const requestId = Math.random().toString(36).substring(7);
    
    console.log(`[Zendesk Upload:${requestId}] File upload request`);
    console.log(`[Zendesk Upload:${requestId}] Origin:`, req.headers.origin);
    console.log(`[Zendesk Upload:${requestId}] Content-Type:`, req.headers['content-type']);
    console.log(`[Zendesk Upload:${requestId}] Content-Length:`, req.headers['content-length']);
    console.log(`[Zendesk Upload:${requestId}] Query params:`, req.query);
    console.log(`[Zendesk Upload:${requestId}] Body keys:`, Object.keys(req.body));
    console.log(`[Zendesk Upload:${requestId}] Body size:`, JSON.stringify(req.body).length);
    
    try {
        // Get filename from query params OR body
        const filename = req.query.filename || req.body.filename;
        const content = req.body.content;
        const contentType = req.body.contentType || 'application/octet-stream';

        if (!filename) {
            console.error(`[Zendesk Upload:${requestId}] Missing filename`);
            return res.status(400).json({ 
                error: 'Missing filename',
                received: { query: req.query, bodyKeys: Object.keys(req.body) }
            });
        }

        if (!content) {
            console.error(`[Zendesk Upload:${requestId}] Missing content`);
            return res.status(400).json({ 
                error: 'Missing file content',
                received: { query: req.query, bodyKeys: Object.keys(req.body) }
            });
        }

        console.log(`[Zendesk Upload:${requestId}] Uploading: ${filename} (${contentType})`);

        // ✅ CHANGED: Accept plain text, convert to buffer
        const fileBuffer = Buffer.from(content, 'utf-8');
        console.log(`[Zendesk Upload:${requestId}] File size: ${fileBuffer.length} bytes`);

        // Upload to Zendesk
        const axios = require('axios');
        const config = {
            headers: {
                'Content-Type': contentType,
                'Authorization': await authHeader()
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        };

        const response = await axios.post(
            `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/uploads.json?filename=${encodeURIComponent(filename)}`,
            fileBuffer,
            config
        );

        console.log(`[Zendesk Upload:${requestId}] Upload successful: ${response.data.upload.token}`);

        res.json({
            success: true,
            token: response.data.upload.token,
            attachment: response.data.upload.attachment
        });

    } catch (error) {
        console.error(`[Zendesk Upload:${requestId}] Error:`, error.response?.data || error.message);
        
        res.status(error.response?.status || 500).json({
            error: 'Failed to upload file',
            details: error.response?.data || error.message
        });
    }
});

/**
 * Handle CORS preflight for create-ticket endpoint
 */
router.options('/zendesk/create-ticket', (req, res) => {
    // Don't set headers - let global CORS middleware handle it
    res.sendStatus(200);
});

/**
 * Create Zendesk ticket from 3rd party application
 * POST /api/zendesk/create-ticket
 */
router.post('/zendesk/create-ticket', async (req, res) => {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();
    
    console.log(`[Zendesk:${requestId}] New ticket request from ${req.ip}`);

    console.log(`[Zendesk:${requestId}] Request body keys:`, Object.keys(req.body));
    console.log(`[Zendesk:${requestId}] Attachments received:`, req.body.attachments);
    console.log(`[Zendesk:${requestId}] Uploads received:`, req.body.uploads);
    
    try {
        const { name, email, subject, description, priority, tags, customFields, attachments, uploads, uploadTokens, commentUploads } = req.body;

        // Validation
        if (!name || !email || !subject || !description) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                required: ['name', 'email', 'subject', 'description']
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Create Zendesk ticket
        const ticketData = {
            subject: subject,
            description: description,
            type: 'question',
            priority: priority || 'normal',
            requester: {
                name: name,
                email: email
            },
            tags: [...(tags || []), 'intlx360']
        };

        // Add custom fields if provided
        if (customFields && Object.keys(customFields).length > 0) {
            ticketData.custom_fields = Object.entries(customFields).map(
                ([id, value]) => ({ 
                    id: id,
                    value: value 
                })
            );
            console.log(`[Zendesk:${requestId}] Custom fields:`, ticketData.custom_fields);
        }

        // Add comment with attachments if provided
        // Accept attachments from multiple possible field names
        const attachmentTokens = attachments || uploads || uploadTokens || commentUploads || [];

        if (attachmentTokens && attachmentTokens.length > 0) {
            const tokens = attachmentTokens.map(att => 
                typeof att === 'string' ? att : att.token || att
            );
                    
            ticketData.comment = {
                body: description,
                uploads: tokens
            };
            console.log(`[Zendesk:${requestId}] Including ${attachmentTokens.length} attachment(s)`, tokens);
        }

        console.log(`[Zendesk:${requestId}] Creating ticket...`);

        // Use your existing zendeskService
        const ticket = await zendeskService.createTicket(ticketData);
        
        const duration = Date.now() - startTime;
        console.log(`[Zendesk:${requestId}] Ticket ${ticket.id} created in ${duration}ms`);

        // ✅ Return proper support portal URL for viewing all requests
        const supportPortalUrl = 'https://intlxsolutions.zendesk.com/hc/en-us/requests';

        res.json({
            success: true,
            ticketId: ticket.id,
            ticketUrl: supportPortalUrl,
            message: 'Ticket created successfully'
        });

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[Zendesk:${requestId}] Error after ${duration}ms:`, error.response?.data || error.message);
        
        res.status(error.response?.status || 500).json({
            error: 'Failed to create ticket',
            details: error.response?.data?.error || error.message
        });
    }
});

/**
 * Health check for Zendesk integration
 * GET /api/zendesk/health
 */
router.get('/zendesk/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'zendesk-integration',
        timestamp: new Date().toISOString()
    });
});

/**
 * Get Zendesk groups (escalation targets) for the Assign To dropdown.
 * GET /api/groups
 */
router.get('/groups', async (req, res) => {
    try {
        const subdomain = process.env.ZENDESK_SUBDOMAIN || 'intlxsolutions';
        const auth = await authHeader();

        const response = await fetch(
            `https://${subdomain}.zendesk.com/api/v2/groups.json?per_page=100`,
            { headers: { 'Authorization': auth } }
        );

        if (!response.ok) throw new Error(`Zendesk API error: ${response.status}`);

        const data = await response.json();
        const groups = (data.groups || []).map(g => ({ id: g.id, name: g.name }));
        res.json({ groups });
    } catch (error) {
        console.error('Error fetching groups:', error.message);
        res.status(500).json({ error: 'Failed to fetch groups', details: error.message });
    }
});

/**
 * Get the allowed escalation groups and their member agents for the
 * "Assign To" dropdown. Restricted to Triage, Engineering, Escalations, DevOPS.
 * GET /api/escalation-assignees
 */
router.get('/escalation-assignees', async (req, res) => {
    const ALLOWED_GROUPS = ['Triage', 'Engineering', 'Escalations', 'DevOPS'];
    try {
        const subdomain = process.env.ZENDESK_SUBDOMAIN || 'intlxsolutions';
        const auth = await authHeader();
        const headers = { 'Authorization': auth };

        // 1. Get all groups, keep only the allowed ones
        const groupsResp = await fetch(
            `https://${subdomain}.zendesk.com/api/v2/groups.json?per_page=100`,
            { headers }
        );
        if (!groupsResp.ok) throw new Error(`Groups fetch failed: ${groupsResp.status}`);
        const groupsData = await groupsResp.json();
        const allowedGroups = (groupsData.groups || []).filter(g =>
            ALLOWED_GROUPS.includes(g.name)
        );

        // 2. For each group, get its member user IDs (keep them per-group)
        const groupMemberIds = {}; // groupId -> [userId]
        const allMemberIds = new Set();
        for (const group of allowedGroups) {
            groupMemberIds[group.id] = [];
            const memResp = await fetch(
                `https://${subdomain}.zendesk.com/api/v2/groups/${group.id}/memberships.json?per_page=100`,
                { headers }
            );
            if (!memResp.ok) continue;
            const memData = await memResp.json();
            (memData.group_memberships || []).forEach(m => {
                groupMemberIds[group.id].push(m.user_id);
                allMemberIds.add(m.user_id);
            });
        }

        // 3. Resolve all member user IDs to names in one call
        const userNames = {}; // userId -> name
        if (allMemberIds.size > 0) {
            const idList = Array.from(allMemberIds).join(',');
            const usersResp = await fetch(
                `https://${subdomain}.zendesk.com/api/v2/users/show_many.json?ids=${idList}`,
                { headers }
            );
            if (usersResp.ok) {
                const usersData = await usersResp.json();
                (usersData.users || [])
                    .filter(u => u.active !== false)
                    .forEach(u => { userNames[u.id] = u.name; });
            }
        }

        // 4. Build nested structure: each group with its members attached
        const groups = allowedGroups.map(g => ({
            id: g.id,
            name: g.name,
            members: (groupMemberIds[g.id] || [])
                .filter(uid => userNames[uid])
                .map(uid => ({ id: uid, name: userNames[uid] }))
                .sort((a, b) => a.name.localeCompare(b.name))
        }));

        res.json({ groups });
    } catch (error) {
        console.error('Error fetching escalation assignees:', error.message);
        res.status(500).json({ error: 'Failed to fetch escalation assignees', details: error.message });
    }
});

/**
 * Get active custom ticket statuses for the escalation Status dropdown.
 * Returns { statuses: [{ id, label, category }] }.
 * GET /api/custom-statuses
 */
router.get('/custom-statuses', async (req, res) => {
    try {
        const subdomain = process.env.ZENDESK_SUBDOMAIN || 'intlxsolutions';
        const auth = await authHeader();

        const response = await fetch(
            `https://${subdomain}.zendesk.com/api/v2/custom_statuses.json`,
            { headers: { 'Authorization': auth } }
        );
        if (!response.ok) throw new Error(`Zendesk API error: ${response.status}`);

        const data = await response.json();
        const EXCLUDED_CATEGORIES = ['solved', 'closed'];
        const statuses = (data.custom_statuses || [])
            .filter(s => s.active !== false)
            .filter(s => !EXCLUDED_CATEGORIES.includes(s.status_category))
            .map(s => ({
                id: s.id,
                label: s.agent_label || s.raw_agent_label || s.status_category,
                category: s.status_category
            }));
        res.json({ statuses });
    } catch (error) {
        console.error('Error fetching custom statuses:', error.message);
        res.status(500).json({ error: 'Failed to fetch custom statuses', details: error.message });
    }
});

// ============================================
// END OF KNOWI 3RD PARTY ZENDESK ENDPOINTS
// ============================================

/**
 * Endpoint to get all asset records associated with a given user_id.
 * Used by React app.
 */
router.get('/user-assets', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) {
        return res.status(400).json({ error: 'Missing user_id query parameter.' });
    }
    try {
        const assets = await zendeskService.getUserAssetsById(user_id);
        console.log('Fetched assets:', assets);
        res.json({ assets: assets || [] });
    } catch (error) {
        console.error('Error fetching user assets:', error.message);
        res.status(500).json({ error: 'Failed to fetch user assets.', details: error.message });
    }
});

/**
 * Enhanced endpoint to get assets by user ID or organization ID.
 * Supports multiple query modes:
 * - /api/assets (get all assets)
 * - /api/assets?user_id=123 (get assets for specific user)
 * - /api/assets?organization_id=456 (get assets for specific organization)
 * Used by client-side API helper and React app.
 */
router.get('/assets', async (req, res) => {
    const { user_id, organization_id } = req.query;
    
    console.log(`[API] Assets request - user_id: ${user_id}, organization_id: ${organization_id}`);
    
    try {
        let assets = [];
        
        if (organization_id) {
            // If organization_id is provided, get all assets for that organization
            console.log(`[API] Fetching assets for organization: ${organization_id}`);
            assets = await zendeskService.getAssetsByOrganizationId(organization_id);
        } else if (user_id) {
            // If user_id is provided, get user assets
            console.log(`[API] Fetching assets for user: ${user_id}`);
            assets = await zendeskService.getUserAssetsById(user_id);
        } else {
            // If neither parameter provided, get all assets
            console.log(`[API] Fetching all assets`);
            assets = await zendeskService.getAllAssets();
        }
        
        console.log(`[API] Returning ${assets?.length || 0} assets`);
        
        res.json({ 
            custom_object_records: assets || [],
            assets: assets || []
        });
        
    } catch (error) {
        console.error('Error fetching assets:', error.message);
        const errorType = organization_id ? 'organization' : user_id ? 'user' : 'all';
        res.status(500).json({ 
            error: `Failed to fetch ${errorType} assets.`, 
            details: error.message 
        });
    }
});

/**
 * Endpoint to get a single asset by ID.
 * Used by client-side API getAssetById function.
 */
router.get('/assets/:id', async (req, res) => {
    try {
        const assetId = req.params.id;
        const asset = await zendeskService.getAssetById(assetId);
        
        if (!asset) {
            return res.status(404).json({ error: 'Asset not found' });
        }
        
        // Return in format expected by client-side API
        res.json({ 
            custom_object_record: asset,
            record: asset
        });
    } catch (error) {
        console.error('Error fetching asset by ID:', error.message);
        res.status(500).json({ error: 'Failed to fetch asset.', details: error.message });
    }
});

/**
 * Endpoint to create a new asset.
 */
router.post('/assets', async (req, res) => {
    try {
        const assetData = req.body;
        const result = await zendeskService.createAsset(assetData);
        res.status(201).json(result);
    } catch (error) {
        console.error('Error in the /api/assets POST endpoint:', error.message, error.response?.data);
        res.status(500).json({ error: 'Failed to create asset.', details: error.message });
    }
});

/**
 * Endpoint to update an existing asset.
 */
router.patch('/assets/:id', async (req, res) => {
    const assetId = req.params.id;
    let fieldsToUpdate = req.body;
    
    try {
        // Handle both formats: direct properties or wrapped in 'properties'
        if (fieldsToUpdate.properties) {
            fieldsToUpdate = fieldsToUpdate.properties;
        }
        
        console.log(`[API] Updating asset ${assetId} with:`, fieldsToUpdate);
        
        const result = await zendeskService.updateAsset(assetId, fieldsToUpdate);
        
        // Return in format expected by client-side API
        res.status(200).json({
            custom_object_record: result,
            record: result
        });
    } catch (error) {
        console.error('Error in the /api/assets/:id PATCH endpoint:', error.message, error.response?.data);
        res.status(500).json({ error: 'Failed to update asset.', details: error.message });
    }
});

/**
 * Endpoint to delete an asset by ID.
 * Used by React app delete functionality.
 */
router.delete('/assets/:id', async (req, res) => {
    try {
        const assetId = req.params.id;
        console.log(`[API] DELETE request for asset: ${assetId}`);
        
        const result = await zendeskService.deleteAsset(assetId);
        
        if (!result) {
            return res.status(404).json({ 
                error: 'Asset not found',
                message: `Asset with ID ${assetId} does not exist`
            });
        }
        
        console.log(`[API] Asset ${assetId} deleted successfully`);
        res.status(200).json({ 
            success: true, 
            message: 'Asset deleted successfully',
            deletedId: assetId 
        });
        
    } catch (error) {
        console.error('[API] Error deleting asset:', error.message);
        
        if (error.response?.status === 404) {
            res.status(404).json({ 
                error: 'Asset not found',
                message: `Asset with ID ${req.params.id} does not exist`
            });
        } else {
            res.status(500).json({ 
                error: 'Internal server error',
                message: error.message || 'Failed to delete asset'
            });
        }
    }
});

/**
 * Endpoint to get asset schema/fields.
 * Used by client-side API and React app.
 */
router.get('/assets/schema', async (req, res) => {
    try {
        const fields = await zendeskService.getAssetFields();
        
        // Transform fields for client-side API compatibility
        const properties = {};
        fields.forEach(field => {
            properties[field.key] = {
                type: field.type,
                title: field.title,
                options: field.custom_field_options || []
            };
        });
        
        res.json({ 
            fields,
            properties // Format expected by client-side API
        });
    } catch (error) {
        console.error('Error fetching asset schema:', error.message);
        res.status(500).json({ error: 'Failed to fetch schema.', details: error.message });
    }
});

/**
 * Endpoint to fetch IT Portal (SiPortal) assets for a company/organization.
 * Used by React app IT Portal Assets section.
 * SUPPORTS BILH with direct API search
 */
router.get('/it-portal-assets', async (req, res) => {
    try {
        const { user_id } = req.query;
        
        if (!user_id) {
            return res.status(400).json({ error: 'user_id parameter is required' });
        }

        // Get the user's organization from Zendesk
        const user = await zendeskService.getUserById(user_id);
        
        if (!user.organization_id) {
            console.log(`[API] User ${user_id} has no organization, returning empty assets`);
            return res.json({ assets: [] });
        }

        // Get organization details
        const organization = await zendeskService.getOrganizationById(user.organization_id);
        const orgName = organization.name;
        
        console.log(`[API] Fetching SiPortal devices for organization: ${orgName}`);

        // Check if this is BILH
        const lowerOrgName = orgName.toLowerCase().trim();
        let matchingCompanies = [];
        
        // Special handling for Beth Israel Lahey Health
        if (lowerOrgName === 'beth israel lahey health' || lowerOrgName.includes('bilh')) {
            console.log(`[API] Detected Beth Israel Lahey Health - using direct API search with nameStartsWith`);
            
            try {
                const bilhResponse = await fetch(`https://www.siportal.net/api/2.0/companies/?nameStartsWith=bilh`, {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (bilhResponse.ok) {
                    const bilhData = await bilhResponse.json();
                    matchingCompanies = bilhData.data?.results || [];
                    console.log(`[API] Found ${matchingCompanies.length} BILH companies via nameStartsWith search`);
                    console.log(`[API] BILH companies:`, matchingCompanies.map(c => ({ id: c.id, name: c.name })));
                } else {
                    console.log(`[API] Failed to search for BILH companies: ${bilhResponse.status}`);
                    matchingCompanies = [];
                }
            } catch (searchError) {
                console.error(`[API] Error searching for BILH companies:`, searchError.message);
                matchingCompanies = [];
            }
            
        } else {
    // Single company search (existing logic)
    console.log(`[API] Using single company search for "${orgName}"`);
    
    const knownMappings = {
        'keep me home, llc': 3632,
        'keep me home,llc': 3632,
        'intlx solutions, llc': 3492,
        'starling physicians mso, llc': 4133,
    };

    if (knownMappings[lowerOrgName]) {
        matchingCompanies.push({
            id: knownMappings[lowerOrgName],
            name: orgName
        });
    } else {
        // Search in cache for single company
        if (companiesCache.companies.length === 0) {
            await refreshCompaniesCache();
        }
        
        if (companiesCache.companies.length > 0) {
            console.log(`[API] Searching in cache (${companiesCache.companies.length} companies)`);
            const cacheResult = searchCompaniesInCache(orgName);
            
            if (cacheResult) {
                matchingCompanies.push(cacheResult.company);
                console.log(`[API] Cache match found: "${cacheResult.company.name}" (ID: ${cacheResult.company.id})`);
            }
        }
        
        // 🆕 NEW: If not found in cache, try direct API search
        if (matchingCompanies.length === 0) {
            console.log(`[API] Company not in cache, trying direct API search for "${orgName}"`);
            
            try {
                // Use first 10 chars of org name for search
                const searchTerm = orgName.substring(0, 10);
                const directSearchResponse = await fetch(
                    `https://www.siportal.net/api/2.0/companies/?nameStartsWith=${encodeURIComponent(searchTerm)}`,
                    {
                        method: 'GET',
                        headers: {
                            'Authorization': process.env.SIPORTAL_API_KEY,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                
                if (directSearchResponse.ok) {
                    const directData = await directSearchResponse.json();
                    const directCompanies = directData.data?.results || [];
                    
                    console.log(`[API] Direct search found ${directCompanies.length} companies starting with "${searchTerm}"`);
                    
                    if (directCompanies.length > 0) {
                        // Try exact match first
                        const exactMatch = directCompanies.find(c => 
                            normalizeCompanyName(c.name) === normalizeCompanyName(orgName)
                        );
                        
                        if (exactMatch) {
                            matchingCompanies.push(exactMatch);
                            console.log(`[API] ✅ Direct search EXACT match: "${exactMatch.name}" (ID: ${exactMatch.id})`);
                        } else {
                            // Use fuzzy matching on direct search results
                            const variations = generateNameVariations(orgName);
                            let bestMatch = null;
                            let bestScore = 0;
                            
                            for (const company of directCompanies) {
                                const companyNorm = normalizeCompanyName(company.name);
                                
                                for (const variation of variations) {
                                    let score = 0;
                                    
                                    // Exact normalized match
                                    if (companyNorm === variation) {
                                        bestMatch = company;
                                        bestScore = 100;
                                        break;
                                    }
                                    
                                    // Substring match
                                    if (companyNorm.includes(variation) || variation.includes(companyNorm)) {
                                        score = 85;
                                    }
                                    
                                    if (score > bestScore) {
                                        bestMatch = company;
                                        bestScore = score;
                                    }
                                }
                                
                                if (bestScore === 100) break;
                            }
                            
                            if (bestMatch && bestScore >= 70) {
                                matchingCompanies.push(bestMatch);
                                console.log(`[API] ✅ Direct search FUZZY match: "${bestMatch.name}" (ID: ${bestMatch.id}, score: ${bestScore})`);
                            } else {
                                console.log(`[API] ❌ Direct search found companies but no good match (best score: ${bestScore})`);
                            }
                        }
                    } else {
                        console.log(`[API] ❌ Direct search returned no companies for "${searchTerm}"`);
                    }
                } else {
                    console.log(`[API] ❌ Direct search API failed: ${directSearchResponse.status}`);
                }
            } catch (directSearchError) {
                console.error(`[API] Direct search error:`, directSearchError.message);
            }
        }
    }
}

        if (matchingCompanies.length === 0) {
            console.log(`[API] No matching companies found for "${orgName}"`);
            return res.json({ 
                assets: [],
                message: `No matching IT Portal company found for "${orgName}".`,
                companies_searched: companiesCache.companies.length || 20
            });
        }

        console.log(`[API] Found ${matchingCompanies.length} matching companies for ${orgName}`);

        // Fetch devices from ALL matching companies in parallel
        let allAssets = [];
        const companiesWithAssets = [];
        
        const devicePromises = matchingCompanies.map(async (company) => {
    console.log(`[API] Fetching devices for company ${company.id} (${company.name})`);
    
    try {
        // 🆕 ADD PAGINATION HERE
        let allDevices = [];
        let offset = 0;
        const limit = 20;
        let hasMore = true;

        while (hasMore && offset < 500) { // Safety limit: 500 devices max
            const devicesResponse = await fetch(
                `https://www.siportal.net/api/2.0/devices?companyId=${company.id}&offset=${offset}&limit=${limit}`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!devicesResponse.ok) {
                if (offset === 0) {
                    // Only throw error on first page
                    console.log(`[API] Failed to fetch devices for company ${company.id}: ${devicesResponse.status}`);
                    return { company, devices: [] };
                }
                // If error on subsequent pages, just stop pagination
                break;
            }

            const siPortalData = await devicesResponse.json();
            const devices = siPortalData.data?.results || [];
            
            console.log(`[API] Page ${Math.floor(offset/limit) + 1}: Found ${devices.length} devices for ${company.name} (offset: ${offset})`);
            
            if (devices.length > 0) {
                // Check for duplicates before adding
                const existingIds = new Set(allDevices.map(d => d.id));
                const newDevices = devices.filter(d => !existingIds.has(d.id));
                
                if (newDevices.length > 0) {
                    allDevices.push(...newDevices);
                    hasMore = devices.length === limit; // Continue if we got a full page
                    offset += limit;
                } else {
                    // All devices were duplicates, stop
                    hasMore = false;
                }
            } else {
                // Empty page, stop pagination
                hasMore = false;
            }
        }
        
        console.log(`[API] ✅ Total devices for ${company.name}: ${allDevices.length}`);
        
        const devices = allDevices; // Use allDevices instead of single fetch
                
                // Update company name from device data if available
                if (devices.length > 0 && devices[0].company?.name) {
                    company.name = devices[0].company.name;
                }
                
                return { company, devices };
                
            } catch (deviceError) {
                console.error(`[API] Error fetching devices for company ${company.id}:`, deviceError.message);
                return { company, devices: [] };
            }
        });
        
        // Wait for all device fetches to complete
        const results = await Promise.all(devicePromises);
        
        // Process results and transform devices
        for (const { company, devices } of results) {
            if (devices.length > 0) {
                companiesWithAssets.push({
                    id: company.id,
                    name: company.name,
                    device_count: devices.length
                });
                
                // Transform devices
                const transformedAssets = devices.map(device => ({
                    // Basic identification
                    id: device.id,
                    asset_tag: device.name || device.hostName || device.id,
                    
                    // IT Portal specific fields
                    device_type: device.type?.name || device.deviceType || 'Unknown',
                    name: device.name || 'Unnamed Device',
                    host_name: device.hostName || device.hostname || '',
                    description: device.description || '',
                    domain: device.domain || device.realm || '',
                    realm: device.realm || device.domain || '',
                    facility: typeof device.facility === 'object' ? (device.facility?.name || '') : (device.facility || ''),
                    username: device.username || device.user || '',
                    preferred_access: device.preferredAccess || device.preferred_access || '',
                    access_method: device.accessMethod || device.access_method || '',
                    credentials: device.credentials || device.credential || '',
                    
                    // Standard fields
                    manufacturer: device.type?.name || device.manufacturer || 'Unknown',
                    model: device.model || device.type?.name || 'Unknown',
                    serial_number: device.serialNumber || device.serial_number || '',
                    status: device.status || 'active',
                    
                    // Metadata
                    source: 'SiPortal',
                    imported_date: new Date().toISOString(),
                    notes: Array.isArray(device.notes) ? device.notes.join(', ') : (device.notes || ''),
                    assigned_user: device.assignedUser || device.assigned_user || '',
                    
                    // Company info
                    company_name: company.name,
                    company_id: company.id,
                    hospital_name: company.name.replace(/^BILH[-\s]+/i, ''),
                    
                    // Additional fields
                    location: typeof device.location === 'object' ? (device.location?.name || '') : (device.location || ''),
                    ip_address: device.ipAddress || device.ip_address || '',
                    mac_address: device.macAddress || device.mac_address || '',
                    os: device.operatingSystem || device.os || '',
                    last_seen: device.lastSeen || device.last_seen || ''
                }));
                
                allAssets = allAssets.concat(transformedAssets);
            }
        }

        console.log(`[API] Total devices across all companies: ${allAssets.length}`);
        
        // Sort assets by company name, then by device name
        allAssets.sort((a, b) => {
            const companyCompare = (a.company_name || '').localeCompare(b.company_name || '');
            if (companyCompare !== 0) return companyCompare;
            return (a.name || '').localeCompare(b.name || '');
        });

        res.json({ 
            assets: allAssets,
            companies: companiesWithAssets,
            organization: {
                name: orgName,
                id: user.organization_id
            },
            is_multi_company: matchingCompanies.length > 1,
            is_bilh: lowerOrgName === 'beth israel lahey health' || lowerOrgName.includes('bilh')
        });
        
    } catch (error) {
        console.error('[API] Error fetching SiPortal devices:', error.message);
        res.status(500).json({ 
            error: 'Failed to fetch IT Portal assets',
            details: error.message 
        });
    }
});

/**
 * Test direct BILH search using nameStartsWith
 */

/**
 * Test endpoint to simulate BILH organization fetch
 * GET /api/test-bilh-fetch
 */

/**
 * SiPortal webhook endpoint
 * Receives webhook notifications from SiPortal when devices are updated
 */
router.post('/webhooks/siportal', async (req, res) => {
    try {
        const { event, company_id, device_id, timestamp } = req.body;
        
        console.log(`[Webhook] Received SiPortal ${event} event for company ${company_id}, device ${device_id}`);
        
        if (!company_id) {
            return res.status(400).json({ error: 'company_id is required' });
        }

        // Fetch updated device data from SiPortal with OFFSET pagination
        console.log(`[API] Fetching SiPortal devices for company ID: ${company_id}`);
        
        let allDevices = [];
        let offset = 0;
        const limit = 20;
        let hasMore = true;

        while (hasMore && offset < 200) {
            const response = await fetch(
                `https://www.siportal.net/api/2.0/devices?companyId=${company_id}&offset=${offset}&limit=${limit}`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`SiPortal API returned ${response.status}: ${response.statusText}`);
            }

            const siPortalData = await response.json();
            const devices = siPortalData.data?.results || [];
            
            if (devices.length > 0) {
                const existingIds = new Set(allDevices.map(d => d.id));
                const newDevices = devices.filter(d => !existingIds.has(d.id));
                
                if (newDevices.length > 0) {
                    allDevices.push(...newDevices);
                    hasMore = devices.length === limit;
                    offset += limit;
                } else {
                    hasMore = false;
                }
            } else {
                hasMore = false;
            }
        }
        
        console.log(`[API] Successfully fetched ${allDevices.length} unique devices from SiPortal`);
        console.log(`[Webhook] Processed ${event} event for company ${company_id}`);
        
        res.json({ 
            success: true, 
            message: 'Webhook processed successfully',
            device_count: allDevices.length
        });
        
    } catch (error) {
        console.error('[Webhook] Error processing SiPortal webhook:', error.message);
        res.status(500).json({ 
            error: 'Failed to process webhook',
            details: error.message 
        });
    }
});

/**
 * Endpoint to import SiPortal devices as Zendesk assets for an organization
 * FIXED: Now uses offset/limit pagination
 */
router.post('/import-siportal-devices', async (req, res) => {
    try {
        const { user_id, organization_id } = req.body;
        
        if (!user_id && !organization_id) {
            return res.status(400).json({ error: 'Either user_id or organization_id is required' });
        }

        let orgId = organization_id;
        let orgName = '';

        // If user_id provided, get their organization
        if (user_id && !organization_id) {
            const user = await zendeskService.getUserById(user_id);
            if (!user.organization_id) {
                return res.status(400).json({ error: 'User has no organization associated' });
            }
            orgId = user.organization_id;
        }

        // Get organization details
        const organization = await zendeskService.getOrganizationById(orgId);
        orgName = organization.name;
        
        console.log(`[Import] Starting SiPortal device import for organization: ${orgName} (ID: ${orgId})`);

        // Find matching company (using same logic as /it-portal-assets)
        let matchingCompany = null;
        
        // ... [Company matching logic - same as in /it-portal-assets endpoint] ...
        
        if (!matchingCompany) {
            return res.status(404).json({
                error: 'No matching company found',
                message: `No matching IT Portal company found for organization "${orgName}"`,
            });
        }

        console.log(`[Import] Match found: "${matchingCompany.name}" (ID: ${matchingCompany.id})`);

        // Fetch devices from SiPortal with OFFSET pagination
        let allDevices = [];
        let offset = 0;
        const limit = 20;
        let hasMore = true;

        while (hasMore && offset < 500) {
            const response = await fetch(
                `https://www.siportal.net/api/2.0/devices?companyId=${matchingCompany.id}&offset=${offset}&limit=${limit}`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.ok) {
                if (offset === 0) {
                    throw new Error(`SiPortal API returned ${response.status}: ${response.statusText}`);
                }
                break;
            }

            const siPortalData = await response.json();
            const devices = siPortalData.data?.results || [];
            
            if (devices.length > 0) {
                const existingIds = new Set(allDevices.map(d => d.id));
                const newDevices = devices.filter(d => !existingIds.has(d.id));
                
                if (newDevices.length > 0) {
                    allDevices.push(...newDevices);
                    hasMore = devices.length === limit;
                    offset += limit;
                } else {
                    hasMore = false;
                }
            } else {
                hasMore = false;
            }
        }
        
        console.log(`[Import] Found ${allDevices.length} unique devices in SiPortal for company ${matchingCompany.name}`);

        if (allDevices.length === 0) {
            return res.json({
                success: true,
                message: 'No devices found to import',
                imported: 0,
                skipped: 0
            });
        }

        let imported = 0;
        let skipped = 0;
        const importResults = [];

        // Import each device as a Zendesk asset
        for (const device of allDevices) {
            try {
                // Check if asset already exists (by serial number or device ID)
                const existingAssets = await zendeskService.getUserAssetsById(user_id || 'search');
                const assetExists = existingAssets?.some(asset => 
                    asset.serial_number === device.serialNumber ||
                    (asset.notes && asset.notes.includes(`SiPortal ID: ${device.id}`))
                );

                if (assetExists) {
                    console.log(`[Import] Skipping device ${device.id} - already exists`);
                    skipped++;
                    importResults.push({
                        device_id: device.id,
                        status: 'skipped',
                        reason: 'Asset already exists'
                    });
                    continue;
                }

                // Create asset data
                const assetData = {
                    name: device.name || device.hostName || `Device ${device.id}`,
                    asset_tag: device.name || device.hostName || device.id,
                    description: device.description || 'Imported from SiPortal',
                    status: 'active',
                    assigned_user_id: user_id,
                    organization_id: orgId,
                    manufacturer: device.type?.name || device.manufacturer || 'Unknown',
                    model: device.model || device.type?.name || 'Unknown',
                    serial_number: device.serialNumber || device.serial_number || '',
                    purchase_date: device.purchaseDate || null,
                    notes: `Imported from SiPortal\nSiPortal ID: ${device.id}\n...`,
                    source: 'SiPortal'
                };

                // Create the asset in Zendesk
                const createdAsset = await zendeskService.createAsset(assetData);
                
                imported++;
                importResults.push({
                    device_id: device.id,
                    asset_id: createdAsset.id,
                    status: 'imported',
                    name: assetData.name
                });
                
                console.log(`[Import] Successfully imported device ${device.id} as asset ${createdAsset.id}`);

            } catch (deviceError) {
                console.error(`[Import] Failed to import device ${device.id}:`, deviceError.message);
                skipped++;
                importResults.push({
                    device_id: device.id,
                    status: 'failed',
                    reason: deviceError.message
                });
            }
        }

        console.log(`[Import] Import completed: ${imported} imported, ${skipped} skipped`);

        res.json({
            success: true,
            message: `Successfully imported ${imported} devices from SiPortal`,
            imported,
            skipped,
            organization: {
                id: orgId,
                name: orgName
            },
            company: {
                id: matchingCompany.id,
                name: matchingCompany.name
            },
            results: importResults
        });

    } catch (error) {
        console.error('[Import] Error importing SiPortal devices:', error.message);
        res.status(500).json({
            error: 'Failed to import devices from SiPortal',
            details: error.message
        });
    }
});

/**
 * Endpoint to get import preview - shows what devices would be imported
 * FIXED: Now uses offset/limit pagination
 */
router.get('/preview-siportal-import', async (req, res) => {
    try {
        const { user_id, organization_id } = req.query;
        
        if (!user_id && !organization_id) {
            return res.status(400).json({ error: 'Either user_id or organization_id is required' });
        }

        let orgId = organization_id;
        let orgName = '';

        // Get organization details
        if (user_id && !organization_id) {
            const user = await zendeskService.getUserById(user_id);
            if (!user.organization_id) {
                return res.status(400).json({ error: 'User has no organization associated' });
            }
            orgId = user.organization_id;
        }

        const organization = await zendeskService.getOrganizationById(orgId);
        orgName = organization.name;

        // Find matching company (simplified for preview)
        // ... [Company matching logic] ...
        
        let matchingCompany = null; // Would be found via matching logic

        if (!matchingCompany) {
            return res.status(404).json({
                error: 'No matching company found',
                message: `No matching IT Portal company found for organization "${orgName}"`
            });
        }

        // Fetch devices with offset pagination
        let allDevices = [];
        let offset = 0;
        const limit = 20;
        
        // Just get first 100 devices for preview
        while (offset < 100) {
            const response = await fetch(
                `https://www.siportal.net/api/2.0/devices?companyId=${matchingCompany.id}&offset=${offset}&limit=${limit}`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.ok) break;

            const siPortalData = await response.json();
            const devices = siPortalData.data?.results || [];
            
            if (devices.length === 0) break;
            
            const existingIds = new Set(allDevices.map(d => d.id));
            const newDevices = devices.filter(d => !existingIds.has(d.id));
            
            if (newDevices.length > 0) {
                allDevices.push(...newDevices);
                offset += limit;
            } else {
                break;
            }
        }

        // Get existing assets to check for duplicates
        const existingAssets = user_id ? await zendeskService.getUserAssetsById(user_id) : [];

        // Preview what would be imported
        const preview = allDevices.map(device => {
            const assetExists = existingAssets?.some(asset => 
                asset.serial_number === device.serialNumber ||
                (asset.notes && asset.notes.includes(`SiPortal ID: ${device.id}`))
            );

            return {
                device_id: device.id,
                name: device.name || 'Unnamed Device',
                host_name: device.hostName || device.hostname || '',
                device_type: device.type?.name || device.deviceType || 'Unknown',
                serial_number: device.serialNumber || device.serial_number || '',
                status: assetExists ? 'exists' : 'new'
            };
        });

        const newDevices = preview.filter(d => d.status === 'new');
        const existingDevices = preview.filter(d => d.status === 'exists');

        res.json({
            success: true,
            organization: {
                id: orgId,
                name: orgName
            },
            company: {
                id: matchingCompany.id,
                name: matchingCompany.name
            },
            total_devices: allDevices.length,
            new_devices: newDevices.length,
            existing_devices: existingDevices.length,
            preview: preview.slice(0, 50) // Limit preview to first 50
        });

    } catch (error) {
        console.error('[Preview] Error previewing SiPortal import:', error.message);
        res.status(500).json({
            error: 'Failed to preview import',
            details: error.message
        });
    }
});

/**
 * Search users by name/email.
 * Used by React app SearchInput component.
 */
router.get('/users/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: 'Missing query parameter' });

        const users = await zendeskService.searchUsers(query);
        res.json({ users });
    } catch (error) {
        console.error('Error searching users:', error.message);
        res.status(500).json({ error: 'Failed to search users' });
    }
});

/**
 * Get all users (for React app dropdowns).
 */
router.get('/users', async (req, res) => {
    try {
        // Get first 100 users for dropdown
        const users = await zendeskService.searchUsers('*');
        res.json({ users: users.slice(0, 100) });
    } catch (error) {
        console.error('Error fetching users:', error.message);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

/**
 * Get user by ID.
 * Used by client-side API.
 */
router.get('/users/:id', async (req, res) => {
    try {
        const userId = req.params.id;
        const user = await zendeskService.getUserById(userId);
        res.json({ user, ...user }); // Provide both wrapped and unwrapped
    } catch (error) {
        console.error('Error fetching user:', error.message);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

/**
 * Search organizations by name.
 * Used by React app SearchInput component.
 */
router.get('/organizations/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: 'Missing query parameter' });

        const organizations = await zendeskService.searchOrganizations(query);
        res.json({ organizations });
    } catch (error) {
        console.error('Error searching organizations:', error.message);
        res.status(500).json({ error: 'Failed to search organizations' });
    }
});

/**
 * Get all organizations (for React app dropdowns).
 */
router.get('/organizations', async (req, res) => {
    try {
        const organizations = await zendeskService.getOrganizations();
        res.json({ organizations });
    } catch (error) {
        console.error('Error fetching organizations:', error.message);
        res.status(500).json({ error: 'Failed to fetch organizations' });
    }
});

/**
 * Get organization by ID.
 * Used by client-side API.
 */
router.get('/organizations/:id', async (req, res) => {
    try {
        const orgId = req.params.id;
        const organization = await zendeskService.getOrganizationById(orgId);
        res.json({ organization, ...organization }); // Provide both wrapped and unwrapped
    } catch (error) {
        console.error('Error fetching organization:', error.message);
        res.status(500).json({ error: 'Failed to fetch organization' });
    }
});

/**
 * Update organization by ID.
 * Used by client-side API for customer notes editing.
 */
// ============================================
// TICKET FIELD EDITING
// ============================================

/**
 * The ticket fields the rebuild is allowed to edit.
 *
 * Keyed by name rather than id so the frontend never carries a field id, and
 * so an unrecognised key is a 400 rather than a custom_fields entry that
 * Zendesk accepts and silently ignores.
 *
 * All three are taggers: they accept only their configured values, so the UI
 * wants dropdowns and a bad value comes back as a 422.
 *
 * Billable (21223282485911, checkbox) is deliberately absent — it exists in
 * Zendesk but was never used in the old app.
 */
const EDITABLE_TICKET_FIELDS = {
    requestType:        { id: Number(REQUEST_TYPE_FIELD_ID),        label: 'Request Type',        type: 'tagger' },
    starlingLocation:   { id: Number(STARLING_LOCATION_FIELD_ID),   label: 'Starling Location',   type: 'tagger' },
    starlingDepartment: { id: Number(STARLING_DEPARTMENT_FIELD_ID), label: 'Starling Department', type: 'tagger' },
    // A checkbox, not a tagger — no custom_field_options, boolean values, and
    // it feeds billed_minutes through the tickets_billed view.
    billable:           { id: Number(BILLABLE_FIELD_ID),            label: 'Billable',            type: 'checkbox' }
};

/**
 * A checkbox's two states, in the same shape a tagger's options arrive in, so
 * the UI needs no special case for it.
 *
 * There is deliberately no empty state. Zendesk stores a checkbox as true or
 * false; null only means never written, and once written there is no way back
 * to it. Offering "none" would be offering something the field cannot do.
 */
const CHECKBOX_OPTIONS = [
    { name: 'Billable', value: 'true' },
    { name: 'Not billable', value: 'false' }
];

// These were hardcoded here and verified against live tickets before the ids
// came from derived.js. If the two ever disagree, say so at startup rather than
// reading one field's options and writing to another.
{
    const VERIFIED = {
        requestType: 22563831352855,
        starlingLocation: 24086888738455,
        starlingDepartment: 24087305679511
    };
    for (const [key, expected] of Object.entries(VERIFIED)) {
        const actual = EDITABLE_TICKET_FIELDS[key].id;
        if (actual !== expected) {
            console.error(
                `[API] ticket field id mismatch for ${key}: derived.js says ${actual}, ` +
                `verified value is ${expected}. One of them is wrong and ticket editing ` +
                'will write to the wrong field. Not failing startup, but fix this.'
            );
        }
    }
}

/**
 * Tagger options, cached in-process for five minutes.
 *
 * Field definitions change about never, and staleness here cannot cause a
 * silent no-op: an option that has been removed upstream now fails as a 400
 * rather than being written and discarded. The cache exists so that a save
 * does not cost an extra Zendesk round trip.
 */
const OPTIONS_TTL_MS = 5 * 60 * 1000;
const optionsCache = new Map();  // fieldId -> { at, options }

async function cachedFieldOptions(fieldId) {
    const key = String(fieldId);
    const hit = optionsCache.get(key);
    if (hit && (Date.now() - hit.at) < OPTIONS_TTL_MS) return hit.options;

    const options = await zendeskService.getTicketFieldOptions(fieldId);
    optionsCache.set(key, { at: Date.now(), options });
    return options;
}

/** null, undefined and '' all mean "no value" — Zendesk uses them interchangeably. */
const isEmptyValue = (v) => v === null || v === undefined || v === '';

/**
 * GET /api/ticket-fields/editable
 *
 * What the UI may edit. Lets the frontend build its form from the backend's
 * list instead of a second hardcoded copy that can drift out of step.
 */
router.get('/ticket-fields/editable', async (req, res) => {
    const entries = Object.entries(EDITABLE_TICKET_FIELDS);

    // Options come from Zendesk, never from a list held here or in the
    // frontend. Zendesk accepts any value for a tagger and silently keeps the
    // old one when it is not a configured option, so a stale copy of this list
    // turns every save into a no-op that reports success.
    const results = await Promise.all(
        entries.map(async ([key, f]) => {
            // A checkbox has no custom_field_options. Asking for them would
            // return an empty list, which the UI cannot distinguish from "the
            // options could not be read" — so answer from here instead.
            if (f.type === 'checkbox') {
                return {
                    key,
                    id: String(f.id),
                    label: f.label,
                    type: 'checkbox',
                    options: CHECKBOX_OPTIONS
                };
            }

            try {
                const options = await zendeskService.getTicketFieldOptions(f.id);
                return {
                    key,
                    id: String(f.id),
                    label: f.label,
                    type: 'tagger',
                    options
                };
            } catch (error) {
                // Log the status only — the axios error carries the request
                // config, Authorization header included.
                const status = error.response ? error.response.status : null;
                console.error(`[API] options for ${key} (${f.id}) failed: HTTP ${status || '?'}`);
                return {
                    key,
                    id: String(f.id),
                    label: f.label,
                    type: 'tagger',
                    options: null,
                    error: 'options-unavailable'
                };
            }
        })
    );

    const broken = results.filter((r) => r.options === null).map((r) => r.key);

    // A field whose options could not be read must not render as an editable
    // dropdown — an empty or guessed list is how a silent no-op gets shipped.
    // Say so explicitly rather than returning a plausible-looking empty array.
    res.json({
        fields: results,
        incomplete: broken.length > 0,
        ...(broken.length ? { unavailable: broken } : {})
    });
});

/**
 * PATCH /api/tickets/:id
 *
 * Body is named keys only, e.g. { "requestType": "Move/Add/Change" }.
 * An empty string clears the field.
 *
 * Partial by design: only the keys present are written, so the UI can send one
 * field without reading and resending the others.
 */
/**
 * GET /api/tickets/:id/editable
 *
 * The three editable fields' ACTUAL stored values, read from Zendesk.
 *
 * Deliberately not served from the synced table. request_type_derived there is
 * the custom field falling back to alarm tags, so it cannot distinguish a
 * stored value from an inferred one — and an editor that cannot make that
 * distinction will eventually write an inferred value as though a human had
 * chosen it.
 *
 * `status` comes back so the UI can say a ticket is closed. Zendesk permits
 * the write either way (measured 2026-10-30 on closed ticket 123456), so
 * whether to allow it is a product decision rather than a constraint.
 */
router.get('/tickets/:id/editable', async (req, res) => {
    const ticketId = req.params.id;

    let ticket;
    try {
        ticket = await zendeskService.getTicket(ticketId);
    } catch (error) {
        // Status only — an axios error carries the Authorization header.
        const status = error.response ? error.response.status : null;
        console.error(`[API] GET /tickets/${ticketId}/editable failed: HTTP ${status || '?'}`);

        if (status === 404) {
            return res.status(404).json({
                error: 'not-found',
                message: `ticket ${ticketId} not found`
            });
        }
        return res.status(502).json({
            error: 'zendesk-unavailable',
            status,
            message: 'could not read the ticket from Zendesk'
        });
    }

    const byId = new Map(
        (ticket.custom_fields || []).map((f) => [String(f.id), f.value])
    );

    const values = {};
    for (const [key, field] of Object.entries(EDITABLE_TICKET_FIELDS)) {
        const raw = byId.has(String(field.id)) ? byId.get(String(field.id)) : null;
        // Zendesk returns '' for a cleared field and null for one never set.
        // Both mean empty, and a UI that distinguishes them invents a
        // difference that does not exist.
        values[key] = (raw === '' || raw === undefined) ? null : raw;
    }

    res.json({
        ticketId: String(ticket.id),
        status: ticket.status,
        values
    });
});

router.patch('/tickets/:id', async (req, res) => {
    const ticketId = req.params.id;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    const unknown = Object.keys(body).filter((k) => !(k in EDITABLE_TICKET_FIELDS));
    if (unknown.length) {
        return res.status(400).json({
            error: 'unknown-field',
            message: `not editable: ${unknown.join(', ')}`,
            editable: Object.keys(EDITABLE_TICKET_FIELDS)
        });
    }

    // -----------------------------------------------------------------
    // Resolve every value against the field's configured options BEFORE
    // writing anything.
    //
    // This is not defensive politeness. The echoed value cannot distinguish
    // these two cases on its own:
    //
    //   sent "Question", got "question"  -> normalised, write SUCCEEDED
    //   sent "anything",  got "question" -> rejected, old value KEPT
    //
    // Identical shape, opposite meaning. Resolving up front removes the
    // ambiguity instead of trying to interpret it afterwards.
    //
    // Accepts either the API value or the display name, because the two are
    // routinely different ('service_request' vs 'Service Request') and a UI
    // sending the name is the most likely mistake.
    // -----------------------------------------------------------------
    const resolved = [];
    const rejected = [];

    for (const [key, raw] of Object.entries(body)) {
        if (raw === undefined) continue;
        const field = EDITABLE_TICKET_FIELDS[key];

        if (isEmptyValue(raw)) {
            // A checkbox cannot be returned to "never written", so clearing one
            // is a request Zendesk cannot honour. Say so rather than sending it
            // and reporting whatever comes back.
            if (field.type === 'checkbox') {
                rejected.push({
                    key,
                    requested: raw,
                    validValues: CHECKBOX_OPTIONS.map((o) => o.value)
                });
                continue;
            }
            resolved.push({ key, id: field.id, value: null });
            continue;
        }

        if (field.type === 'checkbox') {
            // Matching computeBillable()'s reading in services/billing.js,
            // which treats true / 'true' / 'yes' / '1' / 'billable' as billable
            // and everything else as not. Accepting the same spellings here
            // means the editor and the sync cannot disagree about a value.
            const want = String(raw).trim().toLowerCase();
            const isTrue = raw === true || ['true', 'yes', '1', 'billable'].includes(want);
            const isFalse = raw === false || ['false', 'no', '0', 'non-billable'].includes(want);

            if (!isTrue && !isFalse) {
                rejected.push({
                    key,
                    requested: raw,
                    validValues: CHECKBOX_OPTIONS.map((o) => o.value)
                });
                continue;
            }

            resolved.push({ key, id: field.id, value: isTrue });
            continue;
        }

        let options;
        try {
            options = await cachedFieldOptions(field.id);
        } catch (error) {
            // Status only — the axios error carries the Authorization header.
            const status = error.response ? error.response.status : null;
            console.error(`[API] options for ${key} (${field.id}) failed: HTTP ${status || '?'}`);
            return res.status(502).json({
                error: 'options-unavailable',
                message: `could not read the configured options for ${field.label}, ` +
                         'so the value cannot be validated and the write was not attempted',
                field: key
            });
        }

        const want = String(raw).trim().toLowerCase();
        const match = options.find((o) =>
            String(o.value).trim().toLowerCase() === want ||
            String(o.name).trim().toLowerCase() === want
        );

        if (!match) {
            rejected.push({
                key,
                requested: raw,
                validValues: options.map((o) => o.value)
            });
            continue;
        }

        resolved.push({ key, id: field.id, value: match.value });
    }

    if (rejected.length) {
        // Nothing has been written at this point — a rejected value fails
        // before the request leaves the process, rather than being sent and
        // silently discarded by Zendesk.
        return res.status(400).json({
            error: 'invalid-value',
            message: 'not a configured option: ' +
                rejected.map((r) => `${r.key}=${JSON.stringify(r.requested)}`).join(', '),
            rejected
        });
    }

    const custom_fields = resolved.map((r) => ({ id: r.id, value: r.value }));

    if (!custom_fields.length) {
        return res.status(400).json({
            error: 'no-fields',
            message: 'nothing to update',
            editable: Object.keys(EDITABLE_TICKET_FIELDS)
        });
    }

    try {
        const ticket = await zendeskService.updateTicketCustomFields(ticketId, custom_fields);

        // ---------------------------------------------------------------
        // Zendesk can return 200 OK having applied NOTHING.
        //
        // A closed ticket, or a value outside a tagger field's configured
        // options, is accepted and silently dropped — no error, no warning,
        // and a response body that looks like success. Measured 2026-10-30:
        // PATCH {"requestType":"anything"} on closed ticket 123456 returned
        // 200 with the field still holding its previous value.
        //
        // So the only trustworthy signal is the ticket Zendesk echoes back.
        // Reporting success from the request body would be asserting an
        // outcome rather than checking it.
        // ---------------------------------------------------------------
        const echoed = new Map(
            (ticket.custom_fields || []).map((f) => [String(f.id), f.value])
        );

        const applied = [];
        const ignored = [];

        // Compare against the RESOLVED value — the canonical option value
        // actually sent — not against what the caller typed. Comparing against
        // the caller's spelling is what produced two false failures on
        // 2026-10-30: "Question" normalised to "question", and a cleared field
        // came back as '' rather than null, and both were reported as
        // not-applied despite having worked.
        for (const r of resolved) {
            const id = String(r.id);
            const actual = echoed.has(id) ? echoed.get(id) : null;

            const same = isEmptyValue(r.value)
                ? isEmptyValue(actual)
                : (!isEmptyValue(actual) &&
                   String(actual).trim().toLowerCase() === String(r.value).trim().toLowerCase());

            (same ? applied : ignored).push({
                key: r.key,
                requested: r.value,
                actual: actual === undefined ? null : actual
            });
        }

        if (ignored.length) {
            return res.status(409).json({
                error: 'not-applied',
                message:
                    'Zendesk returned success but did not apply ' +
                    ignored.map((f) => f.key).join(', ') +
                    '. The value was a valid option and Zendesk accepted the ' +
                    'request, so the ticket itself did not take the change. ' +
                    'Note that a closed ticket is NOT a cause — closed tickets ' +
                    'accept these writes (verified on ticket 123456).',
                ticketId,
                ticketStatus: ticket.status,
                ignored,
                applied: applied.map((f) => f.key)
            });
        }

        // -----------------------------------------------------------
        // Keep the synced row in step.
        //
        // The TABLE reads Postgres; this route writes Zendesk. Without this the
        // UI shows the old value until the next sync, and a page refresh makes
        // a saved edit look like it reverted — measured on ticket 138570.
        //
        // Only the three columns this route can change, and the values come
        // from computeDerivedFields() against the ticket Zendesk just echoed
        // back, so request_type_derived keeps its real rule (the custom field
        // falling back to alarm tags) rather than acquiring a second one here.
        // -----------------------------------------------------------
        let localRowUpdated = false;
        try {
            const derived = computeDerivedFields(ticket);
            // is_billable comes from billing.js rather than derived.js, and it
            // matters more than the others: billed_minutes is computed by the
            // tickets_billed VIEW from this column, so leaving it stale would
            // put a Billable flag and a billed figure in disagreement on an
            // invoice. Because it is a view, setting the column here is
            // sufficient — nothing needs refreshing.
            const billing = computeBillingFields(ticket);
            const result = await pool.query(
                `UPDATE tickets
                    SET request_type_derived = $1,
                        starling_location    = $2,
                        starling_department  = $3,
                        is_billable          = $4,
                        derived_computed_at  = NOW()
                  WHERE id = $5`,
                [
                    derived.request_type_derived,
                    derived.starling_location,
                    derived.starling_department,
                    billing.is_billable,
                    ticketId
                ]
            );
            localRowUpdated = result.rowCount > 0;
            if (!localRowUpdated) {
                // Not an error: a ticket created since the last sync has no row
                // yet. Worth saying, because the UI will show nothing for it
                // until the sync catches up.
                console.warn(
                    `[API] PATCH /tickets/${ticketId}: Zendesk updated, but no local ` +
                    'row to refresh — not synced yet.'
                );
            }
        } catch (dbError) {
            // The Zendesk write already succeeded and is the thing that
            // matters. A failure here means the table is briefly stale, not
            // that the edit was lost, so it must not turn a successful save
            // into an error the user sees.
            console.error(
                `[API] PATCH /tickets/${ticketId}: local row refresh failed — ` +
                (dbError && dbError.message ? dbError.message : 'unknown')
            );
        }

        return res.json({
            ticket,
            updated: applied.map((f) => f.key),
            // So the UI can tell the difference between "saved and the table is
            // current" and "saved, but the table will lag until the next sync".
            localRowUpdated
        });
    } catch (error) {
        // Log the STATUS only. The axios error object carries the request
        // config, Authorization header included, so it must never be logged or
        // returned wholesale.
        const status = error.response ? error.response.status : null;
        const data = error.response ? error.response.data : null;
        const detail = data
            ? (data.description || data.error ||
               (data.details ? JSON.stringify(data.details).slice(0, 300) : null))
            : null;

        console.error(`[API] PATCH /tickets/${ticketId} failed: HTTP ${status || '?'}`);

        if (status === 404) {
            return res.status(404).json({
                error: 'not-found',
                message: `ticket ${ticketId} not found`
            });
        }

        if (status === 422) {
            // Zendesk uses 422 both for a closed ticket and for a tagger value
            // outside the field's options. Its description distinguishes them,
            // so pass it through rather than guessing.
            return res.status(409).json({
                error: 'not-editable',
                message: detail ||
                    'Zendesk rejected the update. A closed ticket cannot be edited, ' +
                    'and a tagger field only accepts its configured values.',
                ticketId
            });
        }

        if (status === 403) {
            return res.status(403).json({
                error: 'forbidden',
                message: detail || 'the credential lacks permission to update this ticket'
            });
        }

        return res.status(502).json({
            error: 'zendesk-unavailable',
            status,
            message: detail || error.message
        });
    }
});


router.put('/organizations/:id', async (req, res) => {
    try {
        const orgId = req.params.id;
        const updateData = req.body;
        
        console.log(`[API] Updating organization ${orgId} with:`, updateData);
        
        const result = await zendeskService.updateOrganization(orgId, updateData);
        
        res.json({ 
            organization: result,
            ...result 
        });
    } catch (error) {
        console.error('Error updating organization:', error.message);
        res.status(500).json({ error: 'Failed to update organization' });
    }
});

/**
 * Debug endpoint to check SiPortal company by ID
 * GET /api/debug-siportal-company/:id
 */

// Initialize companies cache on startup
if (process.env.SIPORTAL_API_KEY) {
    refreshCompaniesCache().catch(err => 
        console.error('[Startup] Initial cache refresh failed:', err.message)
    );
}

// ============================================
// GOOGLE CALENDAR / OPS CALENDAR ENDPOINTS
// ============================================

/**
 * Get OPS Calendar configuration
 */
router.get('/ops-calendar/config', (req, res) => {
    res.json({
        calendarId: process.env.OPS_CALENDAR_ID || 'primary',
        ptoCalendarId: process.env.INTLXSOLUTIONS_CALENDAR_ID, 
        timezone: process.env.OPS_CALENDAR_TIMEZONE || 'America/New_York',
        workingHours: {
            start: '09:00',
            end: '17:00'
        },
        eventTypes: [
            { value: 'meeting', label: 'Meeting', color: '#4285f4' },
            { value: 'maintenance', label: 'Maintenance', color: '#ea4335' },
            { value: 'deployment', label: 'Deployment', color: '#fbbc04' },
            { value: 'training', label: 'Training', color: '#34a853' },
            { value: 'outage', label: 'Outage', color: '#ff6d00' },
            { value: 'other', label: 'Other', color: '#9e9e9e' }
        ]
    });
});

/**
 * Get events from OPS Calendar
 */
router.get('/ops-calendar/events', async (req, res) => {
    try {
        const { 
            calendarId = process.env.OPS_CALENDAR_ID || 'primary',
            timeMin = new Date().toISOString(),
            timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            maxResults = 250,
            q: searchQuery
        } = req.query;

        console.log(`[Calendar] Fetching events from ${calendarId} between ${timeMin} and ${timeMax}`);

        const response = await calendar.events.list({
            auth: oauth2Client,
            calendarId: calendarId,
            timeMin: timeMin,
            timeMax: timeMax,
            maxResults: parseInt(maxResults),
            singleEvents: true,
            orderBy: 'startTime',
            q: searchQuery // Optional search query
        });

        const events = response.data.items || [];
        
        // Transform events to include extracted metadata
        const transformedEvents = events.map(event => ({
            id: event.id,
            summary: event.summary,
            description: event.description,
            location: event.location,
            start: event.start,
            end: event.end,
            status: event.status,
            htmlLink: event.htmlLink,
            created: event.created,
            updated: event.updated,
            creator: event.creator,
            organizer: event.organizer,
            attendees: event.attendees || [],
            reminders: event.reminders,
            // Extract custom metadata
            eventType: extractEventType(event.description),
            ticketId: extractTicketId(event.description),
            assetIds: extractAssetIds(event.description),
            // Additional useful fields
            isAllDay: !event.start?.dateTime,
            duration: event.start?.dateTime && event.end?.dateTime ? 
                (new Date(event.end.dateTime) - new Date(event.start.dateTime)) / 60000 : null
        }));

        console.log(`[Calendar] Retrieved ${transformedEvents.length} events`);

        res.json({
            success: true,
            events: transformedEvents,
            calendar: calendarId,
            range: {
                start: timeMin,
                end: timeMax
            }
        });

    } catch (error) {
        console.error('[Calendar] Error fetching events:', error.message);
        res.status(500).json({
            error: 'Failed to fetch calendar events',
            details: error.message
        });
    }
});

/**
 * Get a single event by ID
 */
router.get('/ops-calendar/events/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params;
        const calendarId = req.query.calendarId || process.env.OPS_CALENDAR_ID || 'primary';

        const response = await calendar.events.get({
            auth: oauth2Client,
            calendarId: calendarId,
            eventId: eventId
        });

        const event = response.data;
        
        res.json({
            success: true,
            event: {
                ...event,
                eventType: extractEventType(event.description),
                ticketId: extractTicketId(event.description),
                assetIds: extractAssetIds(event.description)
            }
        });

    } catch (error) {
        console.error('[Calendar] Error fetching event:', error.message);
        
        if (error.code === 404) {
            res.status(404).json({
                error: 'Event not found',
                eventId: req.params.eventId
            });
        } else {
            res.status(500).json({
                error: 'Failed to fetch event',
                details: error.message
            });
        }
    }
});

/**
 * Create a new calendar event
 */
router.post('/ops-calendar/events', async (req, res) => {
    try {
        const {
            summary,
            description,
            location,
            startDateTime,
            endDateTime,
            startDate, // For all-day events
            endDate,   // For all-day events
            attendees = [],
            eventType = 'meeting',
            ticketId,
            assetIds = [],
            reminders = { useDefault: true },
            calendarId = process.env.OPS_CALENDAR_ID || 'primary'
        } = req.body;

        // Build enhanced description with metadata
        let enhancedDescription = description || '';
        if (eventType) {
            enhancedDescription += `\n[Event Type: ${eventType}]`;
        }
        if (ticketId) {
            enhancedDescription += `\n[Ticket: #${ticketId}]`;
        }
        if (assetIds.length > 0) {
            enhancedDescription += `\n[Assets: ${assetIds.join(',')}]`;
        }

        // Build event object
        const event = {
            summary: summary || 'New OPS Event',
            description: enhancedDescription,
            location: location,
            reminders: reminders
        };

        // Handle date/time
        if (startDateTime && endDateTime) {
            // Timed event
            event.start = { dateTime: startDateTime, timeZone: process.env.OPS_CALENDAR_TIMEZONE || 'America/New_York' };
            event.end = { dateTime: endDateTime, timeZone: process.env.OPS_CALENDAR_TIMEZONE || 'America/New_York' };
        } else if (startDate && endDate) {
            // All-day event
            event.start = { date: startDate };
            event.end = { date: endDate };
        } else {
            return res.status(400).json({
                error: 'Invalid date/time format',
                message: 'Provide either startDateTime/endDateTime or startDate/endDate'
            });
        }

        // Add attendees if provided
        if (attendees.length > 0) {
            event.attendees = attendees.map(email => ({ email }));
            event.sendNotifications = true;
        }

        console.log(`[Calendar] Creating event in calendar ${calendarId}:`, event.summary);

        const response = await calendar.events.insert({
            auth: oauth2Client,
            calendarId: calendarId,
            resource: event,
            sendNotifications: true
        });

        console.log(`[Calendar] Event created successfully: ${response.data.id}`);

        res.status(201).json({
            success: true,
            event: response.data,
            message: 'Event created successfully'
        });

    } catch (error) {
        console.error('[Calendar] Error creating event:', error.message);
        res.status(500).json({
            error: 'Failed to create event',
            details: error.message
        });
    }
});

/**
 * Update an existing calendar event
 */
router.put('/ops-calendar/events/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params;
        const {
            summary,
            description,
            location,
            startDateTime,
            endDateTime,
            startDate,
            endDate,
            attendees,
            eventType,
            ticketId,
            assetIds,
            calendarId = process.env.OPS_CALENDAR_ID || 'primary'
        } = req.body;

        // First, get the existing event
        const existingResponse = await calendar.events.get({
            auth: oauth2Client,
            calendarId: calendarId,
            eventId: eventId
        });

        const event = existingResponse.data;

        // Update fields if provided
        if (summary !== undefined) event.summary = summary;
        if (location !== undefined) event.location = location;

        // Handle description with metadata
        if (description !== undefined || eventType !== undefined || ticketId !== undefined || assetIds !== undefined) {
            let baseDescription = description !== undefined ? description : 
                (event.description ? event.description.split('\n[')[0] : '');
            
            let enhancedDescription = baseDescription;
            
            if (eventType) {
                enhancedDescription += `\n[Event Type: ${eventType}]`;
            } else if (event.description && event.description.includes('[Event Type:')) {
                const existingType = extractEventType(event.description);
                if (existingType) enhancedDescription += `\n[Event Type: ${existingType}]`;
            }
            
            if (ticketId) {
                enhancedDescription += `\n[Ticket: #${ticketId}]`;
            } else if (event.description && event.description.includes('[Ticket:')) {
                const existingTicket = extractTicketId(event.description);
                if (existingTicket) enhancedDescription += `\n[Ticket: #${existingTicket}]`;
            }
            
            if (assetIds && assetIds.length > 0) {
                enhancedDescription += `\n[Assets: ${assetIds.join(',')}]`;
            } else if (event.description && event.description.includes('[Assets:')) {
                const existingAssets = extractAssetIds(event.description);
                if (existingAssets.length > 0) enhancedDescription += `\n[Assets: ${existingAssets.join(',')}]`;
            }
            
            event.description = enhancedDescription;
        }

        // Update date/time if provided
        if (startDateTime && endDateTime) {
            event.start = { dateTime: startDateTime, timeZone: process.env.OPS_CALENDAR_TIMEZONE || 'America/New_York' };
            event.end = { dateTime: endDateTime, timeZone: process.env.OPS_CALENDAR_TIMEZONE || 'America/New_York' };
        } else if (startDate && endDate) {
            event.start = { date: startDate };
            event.end = { date: endDate };
        }

        // Update attendees if provided
        if (attendees !== undefined) {
            event.attendees = attendees.map(email => 
                typeof email === 'string' ? { email } : email
            );
        }

        console.log(`[Calendar] Updating event ${eventId} in calendar ${calendarId}`);

        const response = await calendar.events.update({
            auth: oauth2Client,
            calendarId: calendarId,
            eventId: eventId,
            resource: event,
            sendNotifications: true
        });

        console.log(`[Calendar] Event updated successfully: ${eventId}`);

        res.json({
            success: true,
            event: response.data,
            message: 'Event updated successfully'
        });

    } catch (error) {
        console.error('[Calendar] Error updating event:', error.message);
        
        if (error.code === 404) {
            res.status(404).json({
                error: 'Event not found',
                eventId: req.params.eventId
            });
        } else {
            res.status(500).json({
                error: 'Failed to update event',
                details: error.message
            });
        }
    }
});

/**
 * Delete a calendar event
 */
router.delete('/ops-calendar/events/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params;
        const calendarId = req.query.calendarId || process.env.OPS_CALENDAR_ID || 'primary';
        const sendNotifications = req.query.sendNotifications !== 'false'; // Default true

        console.log(`[Calendar] Deleting event ${eventId} from calendar ${calendarId}`);

        await calendar.events.delete({
            auth: oauth2Client,
            calendarId: calendarId,
            eventId: eventId,
            sendNotifications: sendNotifications
        });

        console.log(`[Calendar] Event deleted successfully: ${eventId}`);

        res.json({
            success: true,
            message: 'Event deleted successfully',
            eventId: eventId
        });

    } catch (error) {
        console.error('[Calendar] Error deleting event:', error.message);
        
        if (error.code === 404) {
            res.status(404).json({
                error: 'Event not found',
                eventId: req.params.eventId
            });
        } else {
            res.status(500).json({
                error: 'Failed to delete event',
                details: error.message
            });
        }
    }
});

/**
 * Check free/busy time for multiple calendars
 */
router.post('/ops-calendar/freebusy', async (req, res) => {
    try {
        const {
            timeMin = new Date().toISOString(),
            timeMax = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            calendars = [{ id: process.env.OPS_CALENDAR_ID || 'primary' }]
        } = req.body;

        console.log(`[Calendar] Checking free/busy for ${calendars.length} calendars`);

        const response = await calendar.freebusy.query({
            auth: oauth2Client,
            resource: {
                timeMin: timeMin,
                timeMax: timeMax,
                items: calendars
            }
        });

        res.json({
            success: true,
            timeMin: timeMin,
            timeMax: timeMax,
            calendars: response.data.calendars
        });

    } catch (error) {
        console.error('[Calendar] Error checking free/busy:', error.message);
        res.status(500).json({
            error: 'Failed to check free/busy time',
            details: error.message
        });
    }
});

/**
 * Get list of available calendars
 */
router.get('/ops-calendar/list', async (req, res) => {
    try {
        console.log('[Calendar] Fetching calendar list');

        const response = await calendar.calendarList.list({
            auth: oauth2Client,
            minAccessRole: 'reader'
        });

        const calendars = response.data.items || [];

        res.json({
            success: true,
            calendars: calendars.map(cal => ({
                id: cal.id,
                summary: cal.summary,
                description: cal.description,
                primary: cal.primary,
                accessRole: cal.accessRole,
                backgroundColor: cal.backgroundColor,
                foregroundColor: cal.foregroundColor,
                timeZone: cal.timeZone
            }))
        });

    } catch (error) {
        console.error('[Calendar] Error fetching calendar list:', error.message);
        res.status(500).json({
            error: 'Failed to fetch calendar list',
            details: error.message
        });
    }
});

/**
 * Quick add event using natural language
 */
router.post('/ops-calendar/quickadd', async (req, res) => {
    try {
        const {
            text,
            calendarId = process.env.OPS_CALENDAR_ID || 'primary'
        } = req.body;

        if (!text) {
            return res.status(400).json({
                error: 'Missing required field: text'
            });
        }

        console.log(`[Calendar] Quick adding event: "${text}"`);

        const response = await calendar.events.quickAdd({
            auth: oauth2Client,
            calendarId: calendarId,
            text: text
        });

        console.log(`[Calendar] Quick add successful: ${response.data.id}`);

        res.status(201).json({
            success: true,
            event: response.data,
            message: 'Event created via quick add'
        });

    } catch (error) {
        console.error('[Calendar] Error with quick add:', error.message);
        res.status(500).json({
            error: 'Failed to quick add event',
            details: error.message
        });
    }
});

/**
 * Get upcoming events (next 7 days)
 */
router.get('/ops-calendar/upcoming', async (req, res) => {
    try {
        const calendarId = req.query.calendarId || process.env.OPS_CALENDAR_ID || 'primary';
        const days = parseInt(req.query.days) || 7;
        
        const timeMin = new Date().toISOString();
        const timeMax = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

        console.log(`[Calendar] Fetching upcoming events for next ${days} days`);

        const response = await calendar.events.list({
            auth: oauth2Client,
            calendarId: calendarId,
            timeMin: timeMin,
            timeMax: timeMax,
            maxResults: 50,
            singleEvents: true,
            orderBy: 'startTime'
        });

        const events = response.data.items || [];

        // Group events by day
        const eventsByDay = {};
        events.forEach(event => {
            const startDate = event.start?.dateTime || event.start?.date;
            const dayKey = new Date(startDate).toLocaleDateString();
            
            if (!eventsByDay[dayKey]) {
                eventsByDay[dayKey] = [];
            }
            
            eventsByDay[dayKey].push({
                id: event.id,
                summary: event.summary,
                start: event.start,
                end: event.end,
                location: event.location,
                attendees: event.attendees?.length || 0,
                eventType: extractEventType(event.description),
                isAllDay: !event.start?.dateTime
            });
        });

        res.json({
            success: true,
            days: days,
            totalEvents: events.length,
            eventsByDay: eventsByDay
        });

    } catch (error) {
        console.error('[Calendar] Error fetching upcoming events:', error.message);
        res.status(500).json({
            error: 'Failed to fetch upcoming events',
            details: error.message
        });
    }
});

// ============================================
// END OF CALENDAR ENDPOINTS
// ============================================

// ============================================
// PAGERDUTY ONCALL ENDPOINT
// ============================================

/**
 * Get current PagerDuty oncall agent from Webcal feed
 * GET /api/pagerduty-oncall
 */
router.get('/pagerduty-oncall', async (req, res) => {
    try {
        // Get the webcal URL from environment variable
        const webcalUrl = process.env.PAGERDUTY_WEBCAL_URL;
        
        if (!webcalUrl) {
            return res.status(400).json({ 
                error: 'PagerDuty Webcal URL not configured',
                note: 'Set PAGERDUTY_WEBCAL_URL in environment variables'
            });
        }
        
        // Convert webcal:// to https://
        const httpsUrl = webcalUrl.replace('webcal://', 'https://');
        
        console.log('[PagerDuty] Fetching oncall schedule from:', httpsUrl);
        
        // Fetch the iCalendar feed
        const icsData = await new Promise((resolve, reject) => {
            https.get(httpsUrl, (response) => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => resolve(data));
                response.on('error', reject);
            }).on('error', reject);
        });
        
        // Parse the iCalendar data
        const events = ical.parseICS(icsData);
        const now = new Date();
        
        let currentOncall = null;
        let upcomingOncall = null;
        let upcomingEvents = [];
        
        // Find current and upcoming oncall events
        for (const event of Object.values(events)) {
            if (event.type === 'VEVENT') {
                const start = new Date(event.start);
                const end = new Date(event.end);
                
                // Check if event is currently active
                if (start <= now && now <= end) {
                    currentOncall = {
                        name: event.summary,
                        start: start.toISOString(),
                        end: end.toISOString(),
                        description: event.description || '',
                        status: 'current'
                    };
                }
                // Collect upcoming events
                else if (start > now) {
                    upcomingEvents.push({
                        name: event.summary,
                        start: start.toISOString(),
                        end: end.toISOString(),
                        description: event.description || '',
                        status: 'upcoming',
                        startTime: start.getTime()
                    });
                }
            }
        }
        
        // Sort upcoming events by start time and get the next one
        if (upcomingEvents.length > 0) {
            upcomingEvents.sort((a, b) => a.startTime - b.startTime);
            upcomingOncall = upcomingEvents[0];
            delete upcomingOncall.startTime; // Remove helper field
        }
        
        // Return current oncall, or next upcoming if no one is current
        const oncallToShow = currentOncall || upcomingOncall;
        
        console.log('[PagerDuty] Current oncall:', currentOncall);
        console.log('[PagerDuty] Next upcoming:', upcomingOncall);
        console.log('[PagerDuty] Showing:', oncallToShow);
        
        res.json({
            oncall: oncallToShow,
            current: currentOncall,
            upcoming: upcomingOncall,
            updated_at: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('[PagerDuty] Error fetching oncall:', error);
        res.status(500).json({ 
            error: 'Failed to fetch oncall schedule',
            details: error.message 
        });
    }
});

// ============================================
// END OF PAGERDUTY ONCALL ENDPOINT
// ============================================

// ============================================
// ZENDESK USER POP ENDPOINT (for Unite CRM Screen Pop)
// ============================================

/**
 * Zendesk User Pop - Screen pop redirector for Unite
 * GET /zendesk-user-pop?phone={phone_number}
 */
router.get('/zendesk-user-pop', async (req, res) => {
    try {
        let phone = req.query.phone;
        
        console.log(`[Zendesk User Pop] Incoming: ${phone}`);
        
        if (!phone) {
            return res.redirect(302, 'https://intlxsolutions.zendesk.com/agent/users');
        }
        
        // Normalize to E.164
        phone = phone.replace(/\D/g, ''); // Strip non-digits
        if (phone.length === 10) {
            phone = '+1' + phone;
        } else if (phone.length === 11 && phone.startsWith('1')) {
            phone = '+' + phone;
        } else if (!phone.startsWith('+')) {
            phone = '+' + phone;
        }
        
        console.log(`[Zendesk User Pop] Normalized: ${phone}`);
        
        const zendeskAuth = await authHeader();
        
        const response = await fetch(
            `https://intlxsolutions.zendesk.com/api/v2/users/search.json?query=phone:"${phone}"`,
            {
                headers: {
                    'Authorization': zendeskAuth,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (!response.ok) {
            console.error(`[Zendesk User Pop] API error: ${response.status}`);
            return res.redirect(302, `https://intlxsolutions.zendesk.com/agent/search?q=${encodeURIComponent(phone)}`);
        }
        
        const data = await response.json();
        const users = data.users || [];
        
        console.log(`[Zendesk User Pop] Found ${users.length} user(s)`);
        
        if (users.length === 1) {
            console.log(`[Zendesk User Pop] ✅ Match: ${users[0].name}`);
            return res.redirect(302, `https://intlxsolutions.zendesk.com/agent/users/${users[0].id}`);
        } else {
            console.log(`[Zendesk User Pop] ${users.length === 0 ? '⚠️ No match' : '⚠️ Multiple matches'}`);
            return res.redirect(302, `https://intlxsolutions.zendesk.com/agent/search?q=${encodeURIComponent(phone)}`);
        }
        
    } catch (error) {
        console.error('[Zendesk User Pop] Error:', error);
        return res.redirect(302, `https://intlxsolutions.zendesk.com/agent/users?query=${encodeURIComponent(req.query.phone || '')}`);
    }
});

// ============================================
// END OF ZENDESK USER POP ENDPOINT
// ============================================

// Get database sync status
router.get('/sync-status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT entity_type, last_sync_at, status, records_synced, error_message
      FROM sync_status
      WHERE entity_type = 'tickets'
      ORDER BY last_sync_at DESC
      LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      return res.json({
        lastSync: null,
        status: 'never',
        recordsSynced: 0
      });
    }
    
    const syncData = result.rows[0];
    res.json({
      lastSync: syncData.last_sync_at,
      status: syncData.status,
      recordsSynced: syncData.records_synced,
      error: syncData.error_message
    });
    
  } catch (error) {
    console.error('❌ Error fetching sync status:', error);
    res.status(500).json({ error: 'Failed to fetch sync status' });
  }
});

// ============================================
// ANALYTICS API ENDPOINTS
// Add this entire section to your api.js file
// Place it anywhere after your router initialization
// ============================================

// ============================================
// FAST ANALYTICS ENDPOINTS (Pre-aggregated)
// ============================================

/**
 * Dashboard summary - FAST (reads pre-aggregated data)
 * GET /api/analytics/dashboard?days=30&org_id=123&agent_id=456
 */


// ============================================
// END OF ANALYTICS ENDPOINTS
// ============================================


/* =========================================================================
 * Billing audit
 *
 * The monthly T&M audit's decision, per ticket. Stored here rather than in
 * Zendesk because closed tickets reject custom field writes and the audit runs
 * on closed tickets - Zendesk closes four days after solved, the audit runs
 * after month end. Measured 2026-11-05 on #137579:
 *
 *   HTTP 422 {"status":[{"description":"One of the updates to a closed
 *             ticket was rejected"}]}
 *
 * A row means audited. No row means not audited. chargeable_minutes is never
 * null, so 0 - audited and not chargeable - is an ordinary value rather than a
 * convention that has to be remembered at every read.
 *
 * Deliberately does not touch is_billable. That write hits the same 422, and
 * the two facts are different anyway: is_billable is what the agent marked,
 * this is what accounting decided. The spreadsheet keeps them in two columns
 * for the same reason.
 * ========================================================================= */

/** Shared by the single and bulk writes so they cannot disagree about what a
 *  valid figure is. Returns a number, or null if the input is not one. */
function parseChargeableMinutes(raw) {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    // Integer and non-negative. Zero is valid and is the whole write-off case,
    // so this must not reject falsy values.
    return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Optional, trimmed, and bounded. A free-text field eventually receives a
 *  pasted email thread; 200 characters is more than a reason needs and less
 *  than a document. Empty becomes null rather than '' so "no reason" has one
 *  representation. */
function parseReason(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().slice(0, 200);
    return s.length ? s : null;
}

/** Shared by both bulk routes, so a cap raised in one cannot be missed in the
 *  other. Returns { ids } or { error }; the caller sends the response, which
 *  keeps this unaware of res. */
function parseTicketIds(raw) {
    const ids = Array.isArray(raw) ? raw : null;

    if (!ids || ids.length === 0) {
        return { error: { error: 'no-tickets', message: 'ticketIds must be a non-empty array' } };
    }
    // A cap, because an unbounded array is a way to hold the database open.
    // A month is in the hundreds; 5000 is far past any real selection.
    if (ids.length > 5000) {
        return { error: { error: 'too-many', message: 'at most 5000 tickets per call', count: ids.length } };
    }

    const bad = ids.filter((i) => !/^\d+$/.test(String(i).trim()));
    if (bad.length) {
        return { error: { error: 'bad-ticket-id', message: 'non-numeric ticket ids', bad: bad.slice(0, 10) } };
    }

    return { ids: ids.map((i) => String(i).trim()) };
}

/**
 * PUT /api/tickets/:id/billing-audit
 *
 * Body: { chargeableMinutes }
 */
router.put('/tickets/:id/billing-audit', async (req, res) => {
    const ticketId = String(req.params.id || '').trim();
    if (!/^\d+$/.test(ticketId)) {
        return res.status(400).json({ error: 'bad-ticket-id', ticketId });
    }

    const minutes = parseChargeableMinutes(req.body && req.body.chargeableMinutes);
    if (minutes === null) {
        return res.status(400).json({
            error: 'invalid-value',
            message: 'chargeableMinutes must be a whole number of minutes, 0 or greater',
            requested: req.body ? req.body.chargeableMinutes : undefined
        });
    }

    try {
        // An absent reason writes NULL rather than keeping the old one: a

        // reason that no longer describes the charge is worse than none.

        const reason = parseReason(req.body && req.body.reason);


        const result = await db.query(
            `INSERT INTO ticket_billing_audit (ticket_id, chargeable_minutes, reason)
                  VALUES ($1, $2, $3)
             ON CONFLICT (ticket_id) DO UPDATE
                     SET chargeable_minutes = EXCLUDED.chargeable_minutes,
                         reason             = EXCLUDED.reason,
                         audited_at         = now()
               RETURNING ticket_id, chargeable_minutes, reason, audited_at`,
            [ticketId, minutes, reason]

        );
        res.json({ audit: result.rows[0] });
    } catch (error) {
        console.error(`[API] billing audit write for ${ticketId} failed: ${error.message}`);
        res.status(500).json({ error: 'write-failed', ticketId });
    }
});

/**
 * DELETE /api/tickets/:id/billing-audit
 *
 * Returns the ticket to un-audited. A real operation, not a tidy-up: row
 * presence is what distinguishes "audited, charge nothing" from "nobody has
 * looked at this yet".
 */
router.delete('/tickets/:id/billing-audit', async (req, res) => {
    const ticketId = String(req.params.id || '').trim();
    if (!/^\d+$/.test(ticketId)) {
        return res.status(400).json({ error: 'bad-ticket-id', ticketId });
    }

    try {
        const result = await db.query(
            'DELETE FROM ticket_billing_audit WHERE ticket_id = $1 RETURNING ticket_id',
            [ticketId]
        );
        // Not 404 when there was no row: un-auditing something already
        // un-audited is the state the caller asked for.
        res.json({ ticketId, removed: result.rowCount > 0 });
    } catch (error) {
        console.error(`[API] billing audit delete for ${ticketId} failed: ${error.message}`);
        res.status(500).json({ error: 'delete-failed', ticketId });
    }
});

/**
 * POST /api/billing-audit/bulk
 *
 * Body: { ticketIds: [...], chargeableMinutes }
 *
 * One value across many tickets, because that is the shape of the work: in
 * October's sample 16 tickets capped at 15 and 9 were written off entirely.
 * Twenty-five decisions, two gestures.
 */
router.post('/billing-audit/bulk', async (req, res) => {
    const body = req.body || {};

    const parsed = parseTicketIds(body.ticketIds);
    if (parsed.error) return res.status(400).json(parsed.error);
    const ids = parsed.ids;

    const minutes = parseChargeableMinutes(body.chargeableMinutes);
    if (minutes === null) {
        return res.status(400).json({
            error: 'invalid-value',
            message: 'chargeableMinutes must be a whole number of minutes, 0 or greater',
            requested: body.chargeableMinutes
        });
    }

    try {
        const reason = parseReason(body.reason);


        const result = await db.query(
            `INSERT INTO ticket_billing_audit (ticket_id, chargeable_minutes, reason)
                  SELECT unnest($1::bigint[]), $2::int, $3::text
             ON CONFLICT (ticket_id) DO UPDATE
                     SET chargeable_minutes = EXCLUDED.chargeable_minutes,
                         reason             = EXCLUDED.reason,
                         audited_at         = now()
               RETURNING ticket_id`,
            [ids, minutes, reason]

        );
        res.json({ updated: result.rowCount, chargeableMinutes: minutes, reason });
    } catch (error) {
        console.error(`[API] bulk billing audit failed: ${error.message}`);
        res.status(500).json({ error: 'write-failed' });
    }
});

/**
 * POST /api/billing-audit/bulk-full
 *
 * Body: { ticketIds: [...], reason? }
 *
 * Bill each at its OWN rounded figure. Separate from /bulk because that route
 * applies one value to many tickets and this is a different value per ticket —
 * so the figure comes from tickets_billed rather than from the request, and
 * the client's idea of a ticket's rounding cannot disagree with the view's.
 *
 * The largest batch in the audit: 39 of 72 in October's sample.
 */
router.post('/billing-audit/bulk-full', async (req, res) => {
    const body = req.body || {};

    const parsed = parseTicketIds(body.ticketIds);
    if (parsed.error) return res.status(400).json(parsed.error);
    const ids = parsed.ids;

    const reason = parseReason(body.reason);

    try {
        const result = await db.query(
            `INSERT INTO ticket_billing_audit (ticket_id, chargeable_minutes, reason)
                  SELECT t.id, COALESCE(t.billed_minutes, 0)::int, $2::text
                    FROM tickets_billed t
                   WHERE t.id = ANY($1::bigint[])
             ON CONFLICT (ticket_id) DO UPDATE
                     SET chargeable_minutes = EXCLUDED.chargeable_minutes,
                         reason             = EXCLUDED.reason,
                         audited_at         = now()
               RETURNING ticket_id, chargeable_minutes`,
            [ids, reason]
        );

        // requested as well as updated: an id absent from tickets_billed
        // produces no row, and silently auditing fewer tickets than were
        // selected is the sort of thing nobody notices until a total is wrong.
        res.json({
            updated: result.rowCount,
            requested: ids.length,
            reason,
            rows: result.rows
        });
    } catch (error) {
        console.error(`[API] bulk-full billing audit failed: ${error.message}`);
        res.status(500).json({ error: 'write-failed' });
    }
});

module.exports = router;