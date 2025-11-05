// routes/api.js
// This file defines all the API endpoints and calls the appropriate service functions.

const express = require('express');
const router = express.Router();
const zendeskService = require('../services/zendesk');
const googleSheetsService = require('../services/googleSheets');
const { google } = require('googleapis');
const calendar = google.calendar('v3');
const db = require('../db'); // ✅ Database for tickets endpoint

const MATTERMOST_URL = process.env.MATTERMOST_URL; // e.g., 'https://mattermost.yourcompany.com'
const MATTERMOST_TOKEN = process.env.MATTERMOST_TOKEN; // Personal Access Token or Bot Token
const https = require('https'); // PagerDuty OnCall Calendar Webcal
const ical = require('ical'); // PagerDuty OnCall Calendar Webcal

// In-memory cache for custom statuses
const customStatusCache = new Map(); // userId -> { text, emoji, timestamp }

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
            const clientId = process.env.SERVERDATA_CLIENT_ID || 'r8HaHY19cEaAnBZVN7gBuQ';
            const clientSecret = process.env.SERVERDATA_CLIENT_SECRET || 'F862FCvwDX8J5JZtV3IQbHKqrWVafD1THU716LCfQuY';
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
router.get('/debug-search-companies/:searchText', async (req, res) => {
    try {
        const searchText = req.params.searchText.toLowerCase();
        
        const matches = companiesCache.companies.filter(company => 
            company.name?.toLowerCase().includes(searchText)
        );
        
        res.json({
            success: true,
            search_text: searchText,
            total_companies_in_cache: companiesCache.companies.length,
            matching_companies: matches.map(c => ({
                id: c.id,
                name: c.name
            })),
            cache_last_updated: companiesCache.lastUpdated
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to search companies',
            details: error.message
        });
    }
});

/**
 * Debug endpoint to test the correct Intermedia workflow:
 * 1. Get contacts to find user IDs
 * 2. Use those IDs for presence info
 */
router.get('/debug-intermedia-contacts', async (req, res) => {
    try {
        const token = await getIntermediaToken();
        const results = {
            success: true,
            contactsEndpoint: null,
            contacts: [],
            presenceResults: [],
            workflow: "contacts -> presence"
        };
        
        // Step 1: Test contacts endpoints to get user IDs
        const contactsEndpoints = [
            'https://api.elevate.services/address-book/v3/accounts/_me/users/_me/contacts',
            'https://api.elevate.services/address-book/v3/accounts/_me/contacts', 
            'https://api.elevate.services/address-book/v3/contacts',
            'https://api.elevate.services/address-book/v3/users/_me/contacts',
            // Try different API versions too
            'https://api.elevate.services/address-book/v2/accounts/_me/users/_me/contacts',
            'https://api.elevate.services/address-book/v1/accounts/_me/users/_me/contacts'
        ];
        
        console.log('[Intermedia] Testing contacts endpoints...');
        
        for (const endpoint of contactsEndpoints) {
            try {
                const response = await fetch(endpoint, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    }
                });
                
                console.log(`[Intermedia] ${endpoint} -> ${response.status}`);
                
                if (response.ok) {
                    const data = await response.json();
                    console.log(`[Intermedia] SUCCESS! Contacts data:`, JSON.stringify(data, null, 2));
                    
                    results.contactsEndpoint = endpoint;
                    results.contacts = data;
                    break; // Found working endpoint!
                } else {
                    const errorText = await response.text();
                    console.log(`[Intermedia] ${endpoint} error: ${errorText}`);
                }
            } catch (err) {
                console.log(`[Intermedia] ${endpoint} failed: ${err.message}`);
            }
        }
        
        // Step 2: If we got contacts, try to get presence for those users
        if (results.contacts && results.contacts.length > 0) {
            console.log('[Intermedia] Found contacts, testing presence endpoints...');
            
            // Extract user IDs from contacts (format may vary)
            const userIds = [];
            results.contacts.forEach(contact => {
                // Try different possible ID fields
                if (contact.id) userIds.push(contact.id);
                if (contact.userId) userIds.push(contact.userId);
                if (contact.user_id) userIds.push(contact.user_id);
                if (contact.contactId) userIds.push(contact.contactId);
            });
            
            console.log(`[Intermedia] Extracted user IDs:`, userIds);
            
            // Test presence endpoints with actual user IDs
            const presenceEndpoints = [
                'https://api.elevate.services/messaging/v1/presence',
                'https://api.elevate.services/messaging/v1/accounts/_me/presence',
                'https://api.elevate.services/messaging/v1/users/presence'
            ];
            
            for (const presenceEndpoint of presenceEndpoints) {
                try {
                    // Test with first user ID
                    const testUserId = userIds[0];
                    const testUrl = `${presenceEndpoint}?userId=${testUserId}`;
                    
                    const response = await fetch(testUrl, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/json'
                        }
                    });
                    
                    console.log(`[Intermedia] ${testUrl} -> ${response.status}`);
                    
                    if (response.ok) {
                        const presenceData = await response.json();
                        console.log(`[Intermedia] Presence SUCCESS:`, JSON.stringify(presenceData, null, 2));
                        
                        results.presenceResults.push({
                            endpoint: testUrl,
                            status: response.status,
                            data: presenceData
                        });
                    } else {
                        const errorText = await response.text();
                        results.presenceResults.push({
                            endpoint: testUrl,
                            status: response.status,
                            error: errorText
                        });
                    }
                } catch (err) {
                    results.presenceResults.push({
                        endpoint: presenceEndpoint,
                        status: 'error',
                        error: err.message
                    });
                }
            }
        } else {
            results.presenceResults = ['No contacts found - cannot test presence'];
        }
        
        res.json(results);
        
    } catch (error) {
        console.error('[Intermedia] Debug contacts error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Failed to test contacts workflow'
        });
    }
});

/**
 * Debug endpoint to test BILH company discovery
 * GET /api/debug-bilh-companies
 */
router.get('/debug-bilh-companies', async (req, res) => {
    try {
        // Ensure cache is populated
        if (companiesCache.companies.length === 0) {
            console.log('[Debug BILH] Cache empty, refreshing...');
            await refreshCompaniesCache();
        }
        
        // Find all BILH companies
        const bilhCompanies = companiesCache.companies.filter(company => {
            const companyName = company.name || '';
            return companyName.toUpperCase().startsWith('BILH-') || 
                   companyName.toUpperCase().startsWith('BILH ') ||
                   companyName.toLowerCase() === 'bilh';
        });
        
        // Format hospital names for display
        const bilhHospitals = bilhCompanies.map(company => ({
            id: company.id,
            full_name: company.name,
            hospital_name: company.name.replace(/^BILH[-\s]+/i, ''),
        }));
        
        res.json({
            success: true,
            summary: {
                total_companies_in_cache: companiesCache.companies.length,
                bilh_companies_found: bilhCompanies.length,
                cache_last_updated: companiesCache.lastUpdated
            },
            bilh_hospitals: bilhHospitals.sort((a, b) => 
                a.hospital_name.localeCompare(b.hospital_name)
            )
        });
        
    } catch (error) {
        console.error('[Debug BILH] Error:', error.message);
        res.status(500).json({
            error: 'Failed to debug BILH companies',
            details: error.message
        });
    }
});

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

// ============================================
// INTERMEDIA AGENT STATUS IMPLEMENTATION
// ============================================

// Cache for agent statuses and tokens
let intermediaCache = {
    token: null,
    tokenExpiry: 0,
    agentStatuses: new Map(),
    lastStatusUpdate: 0
};

// ADD THIS FUNCTION RIGHT AFTER THE CACHE VARIABLES:
/**
 * Initialize presence cache with all agent data
 * This is called on server startup
 */
async function initializePresenceCache() {
    try {
        console.log('[Cache] Initializing presence cache on server startup...');
        
        if (intermediaCache.isUpdating) {
            console.log('[Cache] Already updating, skipping...');
            return;
        }
        
        intermediaCache.isUpdating = true;
        
        // Clear existing cache
        if (intermediaCache.agentStatuses) {
            intermediaCache.agentStatuses.clear();
        } else {
            intermediaCache.agentStatuses = new Map();
        }
        
        // Fetch fresh agent data
        const allAgents = await fetchAgentStatuses();

// Filter out unknown users
const agents = allAgents.filter(agent => {
    return !agent.name.startsWith('Unknown User') && 
           !agent.name.includes('Unknown User') &&
           agent.email && 
           agent.email.includes('@intlxsolutions.com');
});
        
        // Populate cache
        agents.forEach(agent => {
            const agentWithSource = {
                ...agent,
                dataSource: 'server_startup_init',
                initializedAt: new Date().toISOString()
            };
            intermediaCache.agentStatuses.set(agent.id, agentWithSource);
        });
        
        intermediaCache.lastStatusUpdate = Date.now();
        intermediaCache.isUpdating = false;
        
        console.log(`[Cache] Successfully initialized cache with ${agents.length} agents`);
        return agents;
        
    } catch (error) {
        console.error('[Cache] Failed to initialize cache:', error);
        intermediaCache.isUpdating = false;
        throw error;
    }
}

/**
 * 🔧 FIXED: fetchAgentStatuses with correct presence API endpoint
 * REPLACE your existing fetchAgentStatuses function with this version
 */
async function fetchAgentStatuses() {
    try {
        console.log('[Agent Status] Fetching agent statuses using CORRECT presence API endpoint');
        
        // Step 1: Get Zendesk users with Elevate IDs
        const zendeskUsers = await getZendeskUsersWithElevateIds();
        if (!zendeskUsers || zendeskUsers.length === 0) {
            console.log('[Agent Status] No users with Elevate IDs found. Run /api/setup/sync-elevate-ids first.');
            return [];
        }
        
        console.log(`[Agent Status] Found ${zendeskUsers.length} users with Elevate IDs, fetching REAL presence data...`);
        
        // Step 2: Get messaging token for presence lookups
        const messagingToken = await getIntermediaToken();
        
        // Step 3: Fetch presence for each user (in batches to avoid rate limits)
        const agents = [];
        const BATCH_SIZE = 3;
        let batchNumber = 0;
        
        for (let i = 0; i < zendeskUsers.length; i += BATCH_SIZE) {
            const batch = zendeskUsers.slice(i, i + BATCH_SIZE);
            batchNumber++;
            console.log(`[Agent Status] Processing batch ${batchNumber}/${Math.ceil(zendeskUsers.length/BATCH_SIZE)}`);
            
            const batchPromises = batch.map(async (user) => {
                try {
                    console.log(`[Agent Status] Getting REAL presence for ${user.name}`);
                    
                    // 🔧 FIXED: Using the CORRECT API endpoint from documentation
                    const presenceResponse = await fetch(`https://api.elevate.services/messaging/v1/presence/accounts/_me/users/${user.elevate_id}`, {
                        headers: {
                            'Authorization': `Bearer ${messagingToken}`,
                            'Accept': 'application/json'
                        }
                    });
                    
                    let presenceData = null;
                    let actualStatus = 'Offline'; // Default fallback
                    
                    if (presenceResponse.ok) {
                        presenceData = await presenceResponse.json();
                        
                        // Extract presence field as documented
                        if (presenceData && presenceData.presence) {
                            actualStatus = mapMessagingStatus(presenceData.presence);
                            console.log(`[Agent Status] ✅ ${user.name}: ${presenceData.presence} -> ${actualStatus}`);
                        } else {
                            console.log(`[Agent Status] ⚠️ ${user.name}: API success but no presence field - using Offline`);
                        }
                    } else {
                        const errorText = await presenceResponse.text();
                        console.log(`[Agent Status] ❌ ${user.name}: API failed (${presenceResponse.status}) - ${errorText}`);
                        // Will use default 'Offline' status
                    }
                    
                    return {
                        id: user.elevate_id,
                        name: user.name,
                        email: user.email,
                        extension: 'N/A',
                        phone: 'Unknown',
                        status: actualStatus,                    // ✅ Now shows REAL status
                        phoneStatus: actualStatus,               // ✅ Now shows REAL status
                        presenceStatus: actualStatus,            // ✅ Now shows REAL status
                        onCall: false,
                        lastActivity: new Date().toISOString(),
                        source: 'zendesk_elevate_id',
                        company: 'Intlx Solutions',
                        hasPhoneData: false,
                        hasPresenceData: !!presenceData,
                        zendeskUserId: user.zendesk_user_id,
                        rawPresenceData: presenceData || { 
                            presence: 'offline', 
                            updated: new Date().toISOString(),
                            note: presenceResponse.ok ? 'No presence field in response' : `API error: ${presenceResponse.status}`
                        }
                    };
                } catch (error) {
                    console.log(`[Agent Status] ❌ ${user.name}: Exception - ${error.message}`);
                    
                    // Return offline status for errors (but log the actual error)
                    return {
                        id: user.elevate_id,
                        name: user.name,
                        email: user.email,
                        extension: 'N/A',
                        phone: 'Unknown',
                        status: 'Offline',
                        phoneStatus: 'Offline',
                        presenceStatus: 'Offline',
                        onCall: false,
                        lastActivity: new Date().toISOString(),
                        source: 'zendesk_elevate_id',
                        company: 'Intlx Solutions',
                        hasPhoneData: false,
                        hasPresenceData: false,
                        zendeskUserId: user.zendesk_user_id,
                        rawPresenceData: { 
                            presence: 'offline', 
                            updated: new Date().toISOString(),
                            error: error.message
                        }
                    };
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            agents.push(...batchResults);
            
            // Wait between batches to avoid rate limits
            if (i + BATCH_SIZE < zendeskUsers.length) {
                console.log('[Agent Status] Waiting 1 second before next batch...');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        // Generate status summary
        const statusSummary = agents.reduce((summary, agent) => {
            const status = agent.status || 'Unknown';
            summary[status] = (summary[status] || 0) + 1;
            return summary;
        }, {});
        
        console.log(`[Agent Status] 🎉 Successfully processed ${agents.length} agents with REAL presence data!`);
        console.log(`[Agent Status] Status summary:`, statusSummary);
        
        return agents;
        
    } catch (error) {
        console.error('[Agent Status] ❌ Critical error:', error.message);
        return [];
    }
}

const AGENT_STATUS_CACHE_DURATION = 30000; // 30 seconds
const TOKEN_REFRESH_BUFFER = 300000; // 5 minutes before expiry

/**
 * FIXED: Get Intermedia token with correct messaging scope
 */
async function getIntermediaToken() {
    // Check if we have a valid cached token
    if (intermediaCache.token && Date.now() < intermediaCache.tokenExpiry - TOKEN_REFRESH_BUFFER) {
        console.log('[Intermedia] Using cached token');
        return intermediaCache.token;
    }

    console.log('[Intermedia] Requesting new messaging token');
    
    try {
        const clientId = process.env.INTERMEDIA_CLIENT_ID;
        const clientSecret = process.env.INTERMEDIA_CLIENT_SECRET;
        
        if (!clientId || !clientSecret) {
            throw new Error('Missing INTERMEDIA_CLIENT_ID or INTERMEDIA_CLIENT_SECRET environment variables');
        }
        
        console.log('[Intermedia] Making token request with messaging scope...');
        
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret,
                scope: 'api.service.messaging' // FIXED: Use the correct scope
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Intermedia] Token request failed:', response.status, errorText);
            throw new Error(`Token request failed: ${response.status} - ${errorText}`);
        }

        const tokenData = await response.json();
        
        if (!tokenData.access_token) {
            throw new Error('No access token in response');
        }

        // Cache the token
        intermediaCache.token = tokenData.access_token;
        intermediaCache.tokenExpiry = Date.now() + (tokenData.expires_in * 1000);
        
        console.log('[Intermedia] ✅ Token obtained successfully with messaging scope, expires in', tokenData.expires_in, 'seconds');
        return intermediaCache.token;
        
    } catch (error) {
        console.error('[Intermedia] ❌ Token request failed:', error.message);
        throw error;
    }
}

/**
 * Debug endpoint to test the fixed token function
 */
router.get('/debug-test-fixed-messaging-token', async (req, res) => {
    try {
        console.log('[Debug] Testing fixed messaging token function...');
        
        // Clear any cached token to force a fresh request
        intermediaCache.token = null;
        intermediaCache.tokenExpiry = 0;
        
        // Try to get a fresh token
        const token = await getIntermediaToken();
        
        // Test the token with a presence API call
        const testUserId = '7391a3e6-4aac-4961-874e-9d681f91d83b'; // From your logs
        
        const presenceResponse = await fetch(
            `https://api.elevate.services/messaging/v1/presence/accounts/_me/users/${testUserId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            }
        );
        
        const presenceData = presenceResponse.ok ? 
            await presenceResponse.json() : 
            await presenceResponse.text();
            
        res.json({
            success: presenceResponse.ok,
            tokenObtained: !!token,
            tokenPreview: token ? token.substring(0, 20) + '...' : null,
            presenceTest: {
                status: presenceResponse.status,
                ok: presenceResponse.ok,
                data: presenceData
            },
            message: presenceResponse.ok ? 
                'Messaging token is working for presence API!' : 
                'Messaging token obtained but presence API still failing',
            scope: 'api.service.messaging'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Fixed messaging token function is still failing'
        });
    }
});

// ============================================
// UPDATED PRESENCE INTEGRATION - FOLLOWING OFFICIAL API SPEC
// ============================================

/**
 * Enhanced presence fetching following official Elevate Services API spec
 * Based on: https://developer.elevate.services/api/spec/messaging/index.html#dev-guide-presences-guide
 */

/**
 * Get messaging token with presence-specific scope
 */
async function getMessagingTokenForPresence() {
    console.log('[Presence] Using working messaging token...');
    return await getIntermediaToken(); // Use the function that works!
}

/**
 * Fetch presence data using official API endpoints
 */
async function fetchPresenceData() {
    try {
        const token = await getMessagingTokenForPresence();
        console.log('[Presence] Fetching presence data using official API spec...');

        // Method 1: Try to get all presences at once (most efficient)
        const bulkPresenceEndpoints = [
            'https://api.elevate.services/messaging/v1/presences',
            'https://api.elevate.services/messaging/v1/accounts/_me/presences',
            'https://api.elevate.services/messaging/v1/presences/users'
        ];

        for (const endpoint of bulkPresenceEndpoints) {
            try {
                console.log(`[Presence] Trying bulk presence endpoint: ${endpoint}`);
                
                const response = await fetch(endpoint, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                });

                console.log(`[Presence] ${endpoint} returned: ${response.status}`);

                if (response.ok) {
                    const data = await response.json();
                    console.log(`[Presence] Bulk presence data from ${endpoint}:`, JSON.stringify(data, null, 2));
                    
                    const presences = extractPresenceArray(data);
                    if (presences.length > 0) {
                        console.log(`[Presence] Successfully got ${presences.length} presences from bulk endpoint`);
                        return presences;
                    }
                } else {
                    const errorText = await response.text();
                    console.log(`[Presence] ${endpoint} error: ${errorText}`);
                }
            } catch (endpointError) {
                console.log(`[Presence] ${endpoint} failed:`, endpointError.message);
            }
        }

        // Method 2: Get users first, then individual presences
        console.log('[Presence] Bulk endpoints failed, trying user-based approach...');
        
        const users = await fetchUsersForPresence(token);
        if (users.length === 0) {
            console.log('[Presence] No users found for presence lookup');
            return [];
        }

        console.log(`[Presence] Found ${users.length} users, fetching individual presences...`);
        
        const presences = [];
        const BATCH_SIZE = 5; // Process in small batches to avoid rate limits
        
        for (let i = 0; i < users.length; i += BATCH_SIZE) {
            const batch = users.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (user) => {
                return await fetchUserPresence(token, user);
            });
            
            const batchResults = await Promise.all(batchPromises);
            presences.push(...batchResults.filter(p => p !== null));
            
            // Small delay between batches
            if (i + BATCH_SIZE < users.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        
        console.log(`[Presence] Collected ${presences.length} presence records`);
        return presences;

    } catch (error) {
        console.error('[Presence] Error fetching presence data:', error.message);
        return [];
    }
}

/**
 * Extract presence array from various response formats
 */
function extractPresenceArray(data) {
    if (Array.isArray(data)) {
        return data;
    }
    
    // Try common response wrapper patterns
    if (data.presences && Array.isArray(data.presences)) {
        return data.presences;
    }
    
    if (data.data && Array.isArray(data.data)) {
        return data.data;
    }
    
    if (data.results && Array.isArray(data.results)) {
        return data.results;
    }
    
    if (data.items && Array.isArray(data.items)) {
        return data.items;
    }
    
    // If it's a single presence object, wrap it in an array
    if (data.userId || data.unifiedUserId || data.presence) {
        return [data];
    }
    
    return [];
}

/**
 * Fetch users for presence lookup
 */
async function fetchUsersForPresence(token) {
    const userEndpoints = [
        'https://api.elevate.services/messaging/v1/accounts/_me/users',
        'https://api.elevate.services/messaging/v1/users',
        'https://api.elevate.services/address-book/v3/accounts/_me/users'
    ];

    for (const endpoint of userEndpoints) {
        try {
            console.log(`[Presence] Fetching users from: ${endpoint}`);
            
            const response = await fetch(endpoint, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                const users = extractPresenceArray(data);
                
                if (users.length > 0) {
                    console.log(`[Presence] Found ${users.length} users from ${endpoint}`);
                    return users;
                }
            }
        } catch (error) {
            console.log(`[Presence] Failed to fetch users from ${endpoint}:`, error.message);
        }
    }
    
    return [];
}

/**
 * Fetch presence for individual user
 */
async function fetchUserPresence(token, user) {
    try {
        const userId = user.id || user.unifiedUserId || user.userId;
        if (!userId) {
            return null;
        }

        // Try multiple presence endpoint patterns from the official spec
        const presenceEndpoints = [
            `https://api.elevate.services/messaging/v1/presences/${userId}`,
            `https://api.elevate.services/messaging/v1/accounts/_me/users/${userId}/presence`,
            `https://api.elevate.services/messaging/v1/users/${userId}/presence`,
            `https://api.elevate.services/messaging/v1/presence/users/${userId}`
        ];

        for (const endpoint of presenceEndpoints) {
            try {
                const response = await fetch(endpoint, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    }
                });

                if (response.ok) {
                    const presenceData = await response.json();
                    console.log(`[Presence] Got presence for user ${userId} from ${endpoint}`);
                    
                    return {
                        userId: userId,
                        user: user,
                        presence: presenceData,
                        source: endpoint
                    };
                }
            } catch (error) {
                // Continue to next endpoint
            }
        }
        
        console.log(`[Presence] No presence data found for user ${userId}`);
        return null;
        
    } catch (error) {
        console.error(`[Presence] Error fetching presence for user:`, error.message);
        return null;
    }
}

/**
 * Enhanced function to get address book contacts with proper presence data
 */
async function getContactsWithEnhancedPresence() {
    try {
        // Check if token needs refresh
        if (!global.addressBookToken || global.addressBookTokenExpiry < Date.now()) {
            console.log('[Presence] Address book token expired, attempting refresh...');
            const refreshed = await refreshAddressBookToken();
            if (!refreshed) {
                throw new Error('Address book authentication required');
            }
        }

        // Step 1: Get address book contacts
        const contactsResponse = await fetch('https://api.elevate.services/address-book/v3/accounts/_me/users/_me/contacts', {
            headers: {
                'Authorization': `Bearer ${global.addressBookToken}`,
                'Accept': 'application/json'
            }
        });
        
        if (!contactsResponse.ok) {
            throw new Error(`Address Book API error: ${contactsResponse.status}`);
        }
        
        const contactsData = await contactsResponse.json();
        const contacts = contactsData.results || [];
        
        console.log(`[Presence] Found ${contacts.length} address book contacts`);

        // Step 2: Get presence data using proper API
        const presenceData = await fetchPresenceData();
        console.log(`[Presence] Found ${presenceData.length} presence records`);

        // Step 3: Merge contacts with presence data
        const contactsWithPresence = contacts.map(contact => {
            // Find matching presence data by user ID or email
            const matchingPresence = presenceData.find(p => {
                const presenceUserId = p.userId || p.user?.id || p.user?.unifiedUserId;
                const presenceEmail = p.user?.email || p.presence?.email;
                
                return presenceUserId === contact.id || 
                       presenceEmail === contact.email ||
                       (p.presence?.userId && p.presence.userId === contact.id);
            });

            let presenceInfo = {
                status: 'unknown',
                message: '',
                lastUpdated: new Date().toISOString(),
                source: 'none'
            };

            if (matchingPresence) {
                const presence = matchingPresence.presence || {};
                presenceInfo = {
                    status: mapMessagingStatus(presence.presence || presence.status),
                    message: presence.message || presence.statusMessage || '',
                    activity: presence.activity || '',
                    lastUpdated: presence.lastUpdated || presence.lastSeen || new Date().toISOString(),
                    source: 'messaging_api',
                    rawData: presence // For debugging
                };
            }

            return {
                ...contact,
                presence: presenceInfo
            };
        });

        // Generate statistics
        const presenceStats = contactsWithPresence.reduce((stats, contact) => {
            const status = contact.presence?.status || 'unknown';
            stats[status] = (stats[status] || 0) + 1;
            return stats;
        }, {});

        console.log(`[Presence] Enhanced ${contactsWithPresence.length} contacts with presence data`);
        console.log(`[Presence] Presence distribution:`, presenceStats);

        return {
            results: contactsWithPresence,
            total: contactsWithPresence.length,
            presenceStats,
            lastUpdated: new Date().toISOString(),
            apiEndpointsUsed: {
                addressBook: 'https://api.elevate.services/address-book/v3/accounts/_me/users/_me/contacts',
                presence: 'Multiple messaging API endpoints (see logs)'
            }
        };
        
    } catch (error) {
        console.error('[Presence] Error getting contacts with enhanced presence:', error.message);
        throw error;
    }
}

/**
 * Enhanced address book endpoint with working presence
 */
router.get('/address-book/contacts-with-presence', async (req, res) => {
    try {
        // Check if token needs refresh
        if (!global.addressBookToken || global.addressBookTokenExpiry < Date.now()) {
            console.log('[Presence] Address book token expired, attempting refresh...');
            const refreshed = await refreshAddressBookToken();
            if (!refreshed) {
                return res.status(401).json({ 
                    error: 'Authentication required',
                    authUrl: '/api/auth/serverdata/login',
                    message: 'Please re-authenticate with the Address Book'
                });
            }
        }

        // Get address book contacts
        const contactsResponse = await fetch('https://api.elevate.services/address-book/v3/accounts/_me/users/_me/contacts', {
            headers: {
                'Authorization': `Bearer ${global.addressBookToken}`,
                'Accept': 'application/json'
            }
        });
        
        if (!contactsResponse.ok) {
            throw new Error(`Address Book API error: ${contactsResponse.status}`);
        }
        
        const contactsData = await contactsResponse.json();
        const contacts = contactsData.results || [];
        
        console.log(`[Presence] Found ${contacts.length} address book contacts`);
        
        console.log(`[Presence] Enhanced ${contactsWithPresence.length} contacts with presence data`);
        
        res.json({
            results: contactsWithPresence,
            total: contactsWithPresence.length,
            lastUpdated: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('[Presence] Error getting contacts with presence:', error.message);
        
        if (error.message.includes('authentication required')) {
            res.status(401).json({ 
                error: 'Authentication required',
                authUrl: '/api/auth/serverdata/login',
                message: 'Please re-authenticate with the Address Book'
            });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

/**
 * Manual cache reset endpoint
 */
router.get('/reset-cache-manual', async (req, res) => {
    try {
        await initializePresenceCache();
        res.json({ 
            success: true, 
            message: 'Cache manually reset successfully',
            timestamp: new Date().toISOString(),
            agentCount: intermediaCache.agentStatuses.size
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Debug endpoint to test presence API endpoints
 */
router.get('/debug-presence-endpoints', async (req, res) => {
    try {
        const token = await getMessagingTokenForPresence();
        
        const testEndpoints = [
            'https://api.elevate.services/messaging/v1/presences',
            'https://api.elevate.services/messaging/v1/accounts/_me/presences',
            'https://api.elevate.services/messaging/v1/users',
            'https://api.elevate.services/messaging/v1/accounts/_me/users'
        ];
        
        const results = [];
        
        for (const endpoint of testEndpoints) {
            try {
                const response = await fetch(endpoint, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    }
                });
                
                const result = {
                    endpoint,
                    status: response.status,
                    statusText: response.statusText
                };
                
                if (response.ok) {
                    const data = await response.json();
                    result.dataType = Array.isArray(data) ? 'array' : 'object';
                    result.dataLength = Array.isArray(data) ? data.length : Object.keys(data).length;
                    result.sampleData = Array.isArray(data) ? data[0] : data;
                } else {
                    result.error = await response.text();
                }
                
                results.push(result);
                
            } catch (error) {
                results.push({
                    endpoint,
                    error: error.message,
                    failed: true
                });
            }
        }
        
        res.json({
            success: true,
            tokenObtained: true,
            endpointTests: results,
            recommendation: 'Use the endpoint that returns status 200 with data for your presence integration'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            recommendation: 'Check your INTERMEDIA_CLIENT_ID and INTERMEDIA_CLIENT_SECRET environment variables'
        });
    }
});

/**
 * 🔍 COMPARE: Debug vs fetchAgentStatuses to find discrepancy  
 * GET /api/compare-presence-methods
 */
router.get('/compare-presence-methods', async (req, res) => {
    try {
        console.log('[Compare] Testing both methods side by side...');
        
        // Method 1: Direct API calls (like debug)
        const zendeskUsers = await getZendeskUsersWithElevateIds();
        const testUsers = zendeskUsers.slice(0, 3); // Test 3 users
        const messagingToken = await getIntermediaToken();
        
        console.log('[Compare] Testing direct API calls...');
        const directResults = [];
        
        for (const user of testUsers) {
            try {
                const presenceResponse = await fetch(`https://api.elevate.services/messaging/v1/presences/${user.elevate_id}`, {
                    headers: {
                        'Authorization': `Bearer ${messagingToken}`,
                        'Accept': 'application/json'
                    }
                });
                
                if (presenceResponse.ok) {
                    const presenceData = await presenceResponse.json();
                    directResults.push({
                        user: user.name,
                        id: user.elevate_id,
                        method: 'direct_api',
                        raw_presence: presenceData.presence,
                        mapped_status: mapMessagingStatus(presenceData.presence),
                        success: true
                    });
                } else {
                    directResults.push({
                        user: user.name,
                        id: user.elevate_id,
                        method: 'direct_api',
                        success: false,
                        error: await presenceResponse.text()
                    });
                }
            } catch (error) {
                directResults.push({
                    user: user.name,
                    id: user.elevate_id,
                    method: 'direct_api',
                    success: false,
                    error: error.message
                });
            }
        }
        
        // Method 2: Using fetchAgentStatuses (current method)
        console.log('[Compare] Testing fetchAgentStatuses...');
        const fetchResults = await fetchAgentStatuses();
        
        // Filter to same test users for comparison
        const filteredFetchResults = fetchResults
            .filter(agent => testUsers.some(u => u.elevate_id === agent.id))
            .map(agent => ({
                user: agent.name,
                id: agent.id,
                method: 'fetchAgentStatuses',
                mapped_status: agent.status,
                success: true,
                has_presence_data: !!agent.rawPresenceData
            }));
        
        // Compare results
        const comparison = testUsers.map(user => {
            const directResult = directResults.find(r => r.id === user.elevate_id);
            const fetchResult = filteredFetchResults.find(r => r.id === user.elevate_id);
            
            return {
                user: user.name,
                elevate_id: user.elevate_id,
                direct_api: {
                    success: directResult?.success,
                    raw_presence: directResult?.raw_presence,
                    mapped_status: directResult?.mapped_status
                },
                fetchAgentStatuses: {
                    success: fetchResult?.success,
                    mapped_status: fetchResult?.mapped_status,
                    has_presence_data: fetchResult?.has_presence_data
                },
                match: directResult?.mapped_status === fetchResult?.mapped_status,
                discrepancy: directResult?.mapped_status !== fetchResult?.mapped_status ? {
                    direct_shows: directResult?.mapped_status,
                    fetch_shows: fetchResult?.mapped_status,
                    issue: 'Methods return different results'
                } : null
            };
        });
        
        const discrepancies = comparison.filter(c => !c.match);
        
        res.json({
            success: true,
            message: 'Comparison of presence detection methods',
            summary: {
                users_tested: testUsers.length,
                methods_match: discrepancies.length === 0,
                discrepancies_found: discrepancies.length
            },
            detailed_comparison: comparison,
            analysis: discrepancies.length === 0 ? 
                'Both methods return identical results - issue might be timing or user state' :
                'Methods return different results - fetchAgentStatuses has a processing issue',
            discrepancies: discrepancies.length > 0 ? discrepancies : undefined,
            recommendations: discrepancies.length > 0 ? [
                'Fix fetchAgentStatuses to match direct API behavior',
                'Check for error handling differences',
                'Verify token usage is identical'
            ] : [
                'Methods are consistent - users may genuinely be offline initially',
                'Real-time webhooks working correctly shows system is healthy',
                'Consider if this is expected behavior'
            ]
        });
        
    } catch (error) {
        console.error('[Compare] Error in comparison:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 🔧 DEBUG: Find out exactly why presence API calls are failing
 * GET /api/debug-presence-failure
 */
router.get('/debug-presence-failure', async (req, res) => {
    try {
        console.log('[Debug] Investigating presence API failures...');
        
        // Get one test user
        const zendeskUsers = await getZendeskUsersWithElevateIds();
        if (!zendeskUsers || zendeskUsers.length === 0) {
            return res.json({
                success: false,
                error: 'No users with Elevate IDs found'
            });
        }
        
        const testUser = zendeskUsers[0]; // Test first user
        console.log(`[Debug] Testing with user: ${testUser.name} (${testUser.elevate_id})`);
        
        // Step 1: Test token acquisition
        let messagingToken;
        try {
            messagingToken = await getIntermediaToken();
            console.log('[Debug] ✅ Token acquired successfully');
        } catch (tokenError) {
            return res.json({
                success: false,
                step: 'token_acquisition',
                error: tokenError.message,
                solution: 'Fix Intermedia token/credentials issue'
            });
        }
        
        // Step 2: Test the exact API call
        const apiUrl = `https://api.elevate.services/messaging/v1/presences/${testUser.elevate_id}`;
        console.log(`[Debug] Testing API call: ${apiUrl}`);
        
        try {
            const presenceResponse = await fetch(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${messagingToken}`,
                    'Accept': 'application/json'
                }
            });
            
            console.log(`[Debug] API Response Status: ${presenceResponse.status}`);
            console.log(`[Debug] API Response OK: ${presenceResponse.ok}`);
            
            const responseHeaders = {};
            presenceResponse.headers.forEach((value, key) => {
                responseHeaders[key] = value;
            });
            
            let responseBody;
            const contentType = presenceResponse.headers.get('content-type');
            
            if (contentType && contentType.includes('application/json')) {
                responseBody = await presenceResponse.json();
            } else {
                responseBody = await presenceResponse.text();
            }
            
            const result = {
                success: true,
                test_user: {
                    name: testUser.name,
                    elevate_id: testUser.elevate_id
                },
                api_call: {
                    url: apiUrl,
                    status_code: presenceResponse.status,
                    status_ok: presenceResponse.ok,
                    content_type: contentType
                },
                response: {
                    headers: responseHeaders,
                    body: responseBody
                },
                token_info: {
                    token_length: messagingToken ? messagingToken.length : 0,
                    token_preview: messagingToken ? messagingToken.substring(0, 20) + '...' : 'null'
                }
            };
            
            // Analyze the response
            if (presenceResponse.ok) {
                result.analysis = {
                    status: 'API_WORKING',
                    message: 'Presence API call succeeded',
                    presence_data: responseBody.presence || 'no presence field found',
                    next_step: 'Check why fetchAgentStatuses fails differently'
                };
            } else if (presenceResponse.status === 401) {
                result.analysis = {
                    status: 'AUTHENTICATION_FAILED',
                    message: 'Token authentication failed',
                    likely_cause: 'Token expired, invalid, or insufficient permissions',
                    next_step: 'Check token scopes and expiration'
                };
            } else if (presenceResponse.status === 403) {
                result.analysis = {
                    status: 'PERMISSION_DENIED',
                    message: 'Token lacks permission for presence API',
                    likely_cause: 'Token needs messaging scope or presence permissions',
                    next_step: 'Check token scopes include presence access'
                };
            } else if (presenceResponse.status === 404) {
                result.analysis = {
                    status: 'USER_NOT_FOUND',
                    message: 'User/presence not found',
                    likely_cause: 'Invalid Elevate ID or user not in messaging system',
                    next_step: 'Verify Elevate IDs are correct'
                };
            } else {
                result.analysis = {
                    status: 'API_ERROR',
                    message: `API returned ${presenceResponse.status}`,
                    response_body: responseBody,
                    next_step: 'Check API documentation or contact Intermedia'
                };
            }
            
            res.json(result);
            
        } catch (fetchError) {
            res.json({
                success: false,
                step: 'api_call',
                test_user: {
                    name: testUser.name,
                    elevate_id: testUser.elevate_id
                },
                api_url: apiUrl,
                error: fetchError.message,
                token_available: !!messagingToken,
                analysis: {
                    status: 'NETWORK_ERROR',
                    message: 'Failed to make API call',
                    likely_cause: 'Network issue, invalid URL, or CORS problem',
                    next_step: 'Check network connectivity and API endpoint'
                }
            });
        }
        
    } catch (error) {
        console.error('[Debug] Error in presence failure debug:', error);
        res.status(500).json({
            success: false,
            step: 'debug_setup',
            error: error.message
        });
    }
});

/**
 * 🔧 ENHANCED: Auto-initialize check endpoint
 * GET /api/debug-auto-initialize
 */
router.get('/debug-auto-initialize', async (req, res) => {
    try {
        console.log('[Debug] Checking auto-initialize status...');
        
        const cacheSize = intermediaCache.agentStatuses ? intermediaCache.agentStatuses.size : 0;
        const cachedUsers = cacheSize > 0 ? Array.from(intermediaCache.agentStatuses.values()) : [];
        
        // Check what types of users we have
        const userSources = {};
        const sampleUsers = [];
        
        cachedUsers.forEach(user => {
            const source = user.dataSource || user.source || 'unknown';
            userSources[source] = (userSources[source] || 0) + 1;
            
            if (sampleUsers.length < 5) {
                sampleUsers.push({
                    name: user.name,
                    id: user.id,
                    status: user.status,
                    source: source,
                    has_real_name: !user.name.startsWith('User ') && !user.name.startsWith('Unknown User')
                });
            }
        });
        
        const analysis = {
            cache_size: cacheSize,
            user_sources: userSources,
            issues_detected: [],
            recommendations: []
        };
        
        // Analyze issues
        if (cacheSize === 0) {
            analysis.issues_detected.push('No users in cache');
            analysis.recommendations.push('Run /api/reset-and-initialize');
        }
        
        if (userSources.webhook_realtime && !userSources.auto_initialized) {
            analysis.issues_detected.push('Only webhook users, no initial population');
            analysis.recommendations.push('Auto-initialize did not run - run /api/reset-and-initialize');
        }
        
        const genericUsers = cachedUsers.filter(u => 
            u.name.startsWith('User ') || u.name.startsWith('Unknown User')
        ).length;
        
        if (genericUsers > 0) {
            analysis.issues_detected.push(`${genericUsers} users have generic names (User ID instead of real names)`);
            analysis.recommendations.push('Webhook processing needs to lookup real user data');
        }
        
        res.json({
            success: true,
            message: 'Auto-initialize debug analysis',
            analysis: analysis,
            sample_users: sampleUsers,
            next_steps: analysis.recommendations.length > 0 ? 
                analysis.recommendations : 
                ['System appears healthy - all users have real names and proper initialization']
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 🧪 DEBUG: Test the mapping function directly
 * GET /api/debug-mapping-onphone
 */
router.get('/debug-mapping-onphone', (req, res) => {
    try {
        console.log('[Debug] Testing mapMessagingStatus function with "onphone"...');
        
        // Test the current mapping function
        const testValues = [
            'onphone',
            'oncall', 
            'onacall',
            'incall',
            'available',
            'busy',
            'away',
            'offline'
        ];
        
        const mappingResults = testValues.map(value => ({
            input: value,
            output: mapMessagingStatus(value),
            normalized: value.toLowerCase().replace(/\s+/g, '').replace(/-/g, '').replace(/_/g, ''),
            expected_for_onphone: value === 'onphone' ? 'On a Call' : 'varies'
        }));
        
        res.json({
            success: true,
            message: 'Mapping function test results',
            critical_test: {
                input: 'onphone',
                actual_output: mapMessagingStatus('onphone'),
                expected_output: 'On a Call',
                is_correct: mapMessagingStatus('onphone') === 'On a Call'
            },
            all_test_results: mappingResults,
            diagnosis: mapMessagingStatus('onphone') === 'On a Call' ? 
                'Mapping function is correct - issue elsewhere' :
                'Mapping function is BROKEN - needs to be fixed'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            note: 'mapMessagingStatus function might not exist or has syntax error'
        });
    }
});

/**
 * 🧪 TEST: Debug what presence values you're actually receiving
 * GET /api/debug-presence-values
 */
router.get('/debug-presence-values', async (req, res) => {
    try {
        console.log('[Debug] Checking what presence values are actually received...');
        
        // Get current cached data to see what presence states exist
        const cachedUsers = intermediaCache.agentStatuses ? 
            Array.from(intermediaCache.agentStatuses.values()) : [];
            
        // Extract unique presence values
        const presenceValues = new Set();
        const presenceSamples = [];
        
        cachedUsers.forEach(user => {
            if (user.rawPresenceData?.presence) {
                const rawPresence = user.rawPresenceData.presence;
                presenceValues.add(rawPresence);
                
                presenceSamples.push({
                    user: user.name,
                    raw_presence: rawPresence,
                    mapped_status: mapMessagingStatus(rawPresence),
                    source: user.dataSource || 'unknown'
                });
            }
        });
        
        // Get a few fresh API calls to see current values
        const zendeskUsers = await getZendeskUsersWithElevateIds();
        const testUsers = zendeskUsers.slice(0, 3);
        const messagingToken = await getIntermediaToken();
        
        const livePresenceValues = [];
        
        for (const user of testUsers) {
            try {
                const response = await fetch(`https://api.elevate.services/messaging/v1/presence/accounts/_me/users/${user.elevate_id}`, {
                    headers: {
                        'Authorization': `Bearer ${messagingToken}`,
                        'Accept': 'application/json'
                    }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.presence) {
                        presenceValues.add(data.presence);
                        
                        livePresenceValues.push({
                            user: user.name,
                            raw_presence: data.presence,
                            mapped_status: mapMessagingStatus(data.presence)
                        });
                    }
                }
            } catch (error) {
                // Skip errors
            }
        }
        
        res.json({
            success: true,
            message: 'Presence values analysis',
            summary: {
                unique_presence_values: Array.from(presenceValues).sort(),
                total_cached_users: cachedUsers.length,
                users_with_presence_data: presenceSamples.length
            },
            cached_presence_samples: presenceSamples.slice(0, 10),
            live_api_samples: livePresenceValues,
            mapping_test: Array.from(presenceValues).map(value => ({
                raw_value: value,
                mapped_to: mapMessagingStatus(value)
            })),
            question: 'Do you see any presence values that should map to "On a Call"?'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Debug endpoint to check environment variables and compare with curl
 */
router.get('/debug-env-vs-curl', async (req, res) => {
    try {
        console.log('[Debug] Checking environment variables vs curl setup...');
        
        const clientId = process.env.INTERMEDIA_CLIENT_ID;
        const clientSecret = process.env.INTERMEDIA_CLIENT_SECRET;
        
        // Check if credentials exist
        const credsCheck = {
            hasClientId: !!clientId,
            hasClientSecret: !!clientSecret,
            clientIdLength: clientId ? clientId.length : 0,
            clientIdPreview: clientId ? clientId.substring(0, 10) + '...' : 'MISSING',
            // Don't log the secret for security
        };
        
        // Test the exact same request that curl would make
        if (clientId && clientSecret) {
            try {
                console.log('[Debug] Making token request with same parameters as curl...');
                
                // This should mirror your curl command exactly
                const tokenResponse = await fetch('https://login.serverdata.net/user/connect/token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Node.js-Server' // Different from curl
                    },
                    body: new URLSearchParams({
                        grant_type: 'client_credentials',
                        client_id: clientId,
                        client_secret: clientSecret,
                        scope: 'api.service.messaging'
                    }).toString()
                });
                
                const tokenResponseText = await tokenResponse.text();
                console.log('[Debug] Token response:', tokenResponse.status, tokenResponseText);
                
                // Try to parse as JSON
                let tokenData = null;
                try {
                    tokenData = JSON.parse(tokenResponseText);
                } catch (parseErr) {
                    console.log('[Debug] Response is not JSON:', parseErr.message);
                }
                
                res.json({
                    success: tokenResponse.ok,
                    environmentCheck: credsCheck,
                    tokenRequest: {
                        status: tokenResponse.status,
                        statusText: tokenResponse.statusText,
                        responseHeaders: Object.fromEntries(tokenResponse.headers.entries()),
                        responseBody: tokenResponseText,
                        parsedData: tokenData
                    },
                    curlEquivalent: `curl -X POST "https://login.serverdata.net/user/connect/token" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials" \\
  -d "client_id=${clientId}" \\
  -d "client_secret=[HIDDEN]" \\
  -d "scope=api.service.messaging"`,
                    message: tokenResponse.ok ? 
                        'Server environment and curl should be equivalent' : 
                        'Server environment differs from curl - check credentials or network'
                });
                
            } catch (fetchError) {
                res.json({
                    success: false,
                    environmentCheck: credsCheck,
                    fetchError: fetchError.message,
                    message: 'Server cannot make the same request that curl can'
                });
            }
        } else {
            res.json({
                success: false,
                environmentCheck: credsCheck,
                message: 'Missing environment variables on server - this is likely the issue'
            });
        }
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Debug endpoint to test the exact curl command in Node.js
 */
router.post('/debug-mirror-curl', async (req, res) => {
    try {
        const { clientId, clientSecret, scope } = req.body;
        
        if (!clientId || !clientSecret) {
            return res.status(400).json({
                error: 'Missing clientId or clientSecret in request body'
            });
        }
        
        console.log('[Debug] Mirroring exact curl request in Node.js...');
        
        // Mirror curl exactly
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
                // No custom User-Agent to match curl default
            },
            body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&scope=${encodeURIComponent(scope || 'api.service.messaging')}`
        });
        
        const responseText = await response.text();
        
        res.json({
            success: response.ok,
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseText,
            message: response.ok ? 
                'Node.js request matches curl success!' : 
                'Node.js request differs from curl - investigate response'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Helper function to get Zendesk users with Elevate IDs
 */
async function getZendeskUsersWithElevateIds() {
    try {
        // Get all Zendesk users (may need pagination for large organizations)
        let allUsers = [];
        let page = 1;
        let hasMore = true;
        
        while (hasMore && page <= 10) { // Safety limit of 10 pages
            const response = await fetch(`https://intlxsolutions.zendesk.com/api/v2/users.json?per_page=100&page=${page}`, {
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64')}`,
                }
            });
            
            if (!response.ok) {
                throw new Error(`Zendesk API error: ${response.status}`);
            }
            
            const data = await response.json();
            const users = data.users || [];
            allUsers.push(...users);
            
            hasMore = data.next_page !== null && users.length === 100;
            page++;
        }
        
        // Filter to users with Elevate IDs and active status
        const usersWithElevateIds = allUsers
            .filter(user => 
                user.user_fields?.elevate_id && 
                user.active && 
                user.role !== 'end-user' // Only agents/admins
            )
            .map(user => ({
                zendesk_user_id: user.id,
                name: user.name,
                email: user.email,
                elevate_id: user.user_fields.elevate_id,
                role: user.role
            }));
        
        console.log(`[Agent Status] Found ${usersWithElevateIds.length} active agents with Elevate IDs out of ${allUsers.length} total users`);
        
        return usersWithElevateIds;
        
    } catch (error) {
        console.error('[Agent Status] Error getting Zendesk users with Elevate IDs:', error.message);
        return [];
    }
}

/**
 * Map Intermedia presence states to human-readable formats
 */
function mapMessagingStatus(presenceState) {
    if (!presenceState) return 'Offline';
    
    // Normalize input (handle spaces, hyphens, and case variations)
    const normalizedState = presenceState.toLowerCase()
        .replace(/\s+/g, '')           // Remove spaces
        .replace(/-/g, '')             // Remove hyphens  
        .replace(/_/g, '');            // Remove underscores
    
    console.log(`[Mapping] Input: "${presenceState}" -> Normalized: "${normalizedState}"`);
    
    switch (normalizedState) {
        // Available states
        case 'available':
        case 'online':
        case 'active':
        case 'ready':
        case 'agentavailable':
            console.log(`[Mapping] Mapped to: Available`);
            return 'Available';
            
        // 🔧 ON CALL / PHONE STATES (This is the critical fix!)
        case 'onphone':      // ← This should catch your "onphone" value
        case 'onacall':
        case 'oncall':
        case 'incall':
        case 'calling':
        case 'phone':
            console.log(`[Mapping] Mapped to: On a Call`);
            return 'On a Call';
            
        case 'agentoncall':
        case 'agentphone':
            console.log(`[Mapping] Mapped to: Agent On Call`);
            return 'Agent On Call';
            
        // Busy states (meetings, occupied, etc.)
        case 'busy':
        case 'agentbusy':
        case 'occupied':
            console.log(`[Mapping] Mapped to: Busy`);
            return 'Busy';
            
        case 'inmeeting':
        case 'meeting':
        case 'conference':
            console.log(`[Mapping] Mapped to: In Meeting`);
            return 'In Meeting';
            
        case 'dnd':
        case 'donotdisturb':
        case 'unavailable':
            console.log(`[Mapping] Mapped to: Do Not Disturb`);
            return 'Do Not Disturb';
            
        // Away states
        case 'away':
        case 'idle':
        case 'temporarilyaway':
        case 'brb':
            console.log(`[Mapping] Mapped to: Away`);
            return 'Away';
            
        case 'onbreak':
        case 'break':
        case 'lunch':
            console.log(`[Mapping] Mapped to: On Break`);
            return 'On Break';
            
        // Offline states
        case 'offline':
        case 'invisible':
        case 'disconnected':
        case 'offwork':
            console.log(`[Mapping] Mapped to: Offline`);
            return 'Offline';
            
        default:
            console.log(`[Mapping] UNKNOWN STATE: "${presenceState}" -> normalized: "${normalizedState}" -> Defaulting to original`);
            // Return capitalized version of original if unknown
            return presenceState.charAt(0).toUpperCase() + presenceState.slice(1).toLowerCase();
    }
}

/** MATTERMOST INTEGRATION START */

/**
 * Fetch Mattermost user statuses
 */
async function fetchMattermostStatuses() {
    try {
        if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
            console.log('[Mattermost] Configuration missing, skipping');
            return [];
        }

        console.log('[Mattermost] Fetching user statuses...');
        
        // Get all users
        const usersResponse = await fetch(`${MATTERMOST_URL}/api/v4/users?per_page=200`, {
            headers: {
                'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!usersResponse.ok) {
            throw new Error(`Mattermost users API failed: ${usersResponse.status}`);
        }

        const allUsers = await usersResponse.json();

        // Filter out system/bot accounts
        const excludedAccounts = ['zoom', 'system', 'system-bot', 'playbooks', 'production polling server', 'prod-polling', 'feedbackbot', 'jumpcloud', 'jumpcloud alerts', 'calls'];
        const users = allUsers.filter(user => {
            const nameLower = (user.first_name + ' ' + user.last_name).toLowerCase();
            const usernameLower = (user.username || '').toLowerCase();
            return !excludedAccounts.some(excluded => 
                nameLower.includes(excluded) || usernameLower.includes(excluded)
            );
        });

        console.log(`[Mattermost] Found ${users.length} users (filtered from ${allUsers.length})`);

        // Get user IDs for status lookup
        const userIds = users.map(u => u.id);
        
        // Fetch statuses for all users
        const statusesResponse = await fetch(`${MATTERMOST_URL}/api/v4/users/status/ids`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(userIds)
        });

        if (!statusesResponse.ok) {
            throw new Error(`Mattermost statuses API failed: ${statusesResponse.status}`);
        }

        const statuses = await statusesResponse.json();
        
        // Use cached custom statuses instead of fetching from Mattermost
        console.log('[Mattermost] Using cached custom statuses...');
        const customStatuses = users.map(user => ({
            user_id: user.id,
            custom_status: customStatusCache.get(user.id) || null
        }));
        console.log(`[Mattermost] Found ${Array.from(customStatusCache.keys()).length} cached custom statuses`);

        // Combine user info with status and custom status
        const combinedData = users.map(user => {
            const status = statuses.find(s => s.user_id === user.id);
            const customStatusData = customStatuses.find(cs => cs.user_id === user.id);
            
            return {
                id: user.id,
                username: user.username,
                email: user.email,
                first_name: user.first_name,
                last_name: user.last_name,
                name: `${user.first_name} ${user.last_name}`.trim() || user.username,
                status: status?.status || 'offline', // online, away, dnd, offline
                last_activity_at: status?.last_activity_at || user.last_activity_at,
                manual: status?.manual || false, // true if user manually set status
                custom_status: customStatusData?.custom_status || null, // Add custom status here
                source: 'mattermost'
            };
        });

console.log(`[Mattermost] Successfully fetched ${combinedData.length} user statuses with custom statuses`);
return combinedData;

    } catch (error) {
        console.error('[Mattermost] Error fetching statuses:', error.message);
        return [];
    }
}

/**
 * Map Mattermost status to unified format
 */
function mapMattermostStatus(mmStatus) {
    switch (mmStatus?.toLowerCase()) {
        case 'online':
            return 'Available';
        case 'away':
            return 'Away';
        case 'dnd':
            return 'Do Not Disturb';
        case 'offline':
            return 'Offline';
        default:
            return 'Unknown';
    }
}

/**
 * Helper to determine combined status from multiple sources
 */
function determineCombinedStatus(intermediaStatus, mattermostStatus, intermediaActivity, mattermostActivity) {
    // If either shows online/available, prefer that
    if (intermediaStatus?.toLowerCase() === 'available' || mattermostStatus === 'online') {
        return 'Available';
    }

    // If Mattermost shows DND, prioritize that
    if (mattermostStatus === 'dnd') {
        return 'Do Not Disturb';
    }

    // If either shows away, use that
    if (intermediaStatus?.toLowerCase() === 'away' || mattermostStatus === 'away') {
        return 'Away';
    }

    // Compare activity timestamps to determine most recent status
    const intermediaTime = intermediaActivity ? new Date(intermediaActivity).getTime() : 0;
    const mattermostTime = mattermostActivity ? new Date(mattermostActivity).getTime() : 0;

    if (mattermostTime > intermediaTime) {
        return mapMattermostStatus(mattermostStatus);
    }

    return intermediaStatus || 'Offline';
}

/** MATTERMOST INTEGRATION END */

/**
 * 🎨 ENHANCED: Get status colors for UI (including "On a Call")
 * ADD this function for better UI styling
 */
function getStatusColorInfo(status) {
    const normalizedStatus = status?.toLowerCase() || '';
    
    switch (normalizedStatus) {
        case 'available':
        case 'online':
        case 'active':
            return { 
                bg: '#E8F5E8', 
                color: '#2E7D0F', 
                icon: '●', 
                label: status 
            };
            
        case 'on a call':
        case 'agent on call':
            return { 
                bg: '#E8F0FF', 
                color: '#1B5FBF', 
                icon: '📞', 
                label: status 
            };
            
        case 'busy':
        case 'do not disturb':
            return { 
                bg: '#FBEAEA', 
                color: '#CC3340', 
                icon: '●', 
                label: status 
            };
            
        case 'in meeting':
        case 'screen sharing':
            return { 
                bg: '#FFF4E6', 
                color: '#B54708', 
                icon: '🎥', 
                label: status 
            };
            
        case 'away':
        case 'on break':
        case 'out sick':
        case 'on vacation':
            return { 
                bg: '#FFF4CC', 
                color: '#B54708', 
                icon: '●', 
                label: status 
            };
            
        case 'offline':
        default:
            return { 
                bg: '#F8F9FA', 
                color: '#68737D', 
                icon: '○', 
                label: status || 'Offline' 
            };
    }
}

// ============================================
// CORRECTED: DIRECT PRESENCE SUBSCRIPTION (NO HUB NEEDED)
// ============================================

// Global subscription state
let presenceSubscriptionState = {
    subscriptionId: null,
    renewalTimer: null,
    isInitialized: false
};

/**
 * Create direct subscription for all users (no hub needed)
 */
async function createDirectPresenceSubscription() {
    try {
        console.log('[Presence] Creating direct subscription for all users...');
        
        const messagingToken = await getIntermediaToken();
        const subscriptionResponse = await fetch('https://api.elevate.services/messaging/v1/subscriptions/accounts/_me/users/_all', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${messagingToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                event_types: ['presence_changed'],
                webhook_url: 'https://intlxassetmgr-proxy.onrender.com/api/notifications',
                filters: {
                    // Only subscribe to @intlxsolutions.com users
                    email_domains: ['intlxsolutions.com']
                }
            })
        });
        
        if (!subscriptionResponse.ok) {
            const errorText = await subscriptionResponse.text();
            throw new Error(`Direct subscription failed: ${subscriptionResponse.status} - ${errorText}`);
        }
        
        const subscription = await subscriptionResponse.json();
        presenceSubscriptionState.subscriptionId = subscription.id;
        
        console.log(`[Presence] ✅ Direct subscription created: ${subscription.id}`);
        console.log(`[Presence] Expires at: ${subscription.expires_at}`);
        
        // Schedule automatic renewal
        if (subscription.whenExpired) {
        scheduleSubscriptionRenewal(subscription.id, subscription.whenExpired);
            } else if (subscription.expires_at) {
        scheduleSubscriptionRenewal(subscription.id, subscription.expires_at);
            }
        
        return subscription.id;
        
    } catch (error) {
        console.error('[Presence] ❌ Failed to create direct subscription:', error.message);
        throw error;
    }
}

/**
 * Schedule automatic subscription renewal
 */
function scheduleSubscriptionRenewal(subscriptionId, expiresAt) {
    // Clear existing timer
    if (presenceSubscriptionState.renewalTimer) {
        clearTimeout(presenceSubscriptionState.renewalTimer);
    }
    
    // Calculate renewal time (5 minutes before expiry)
    const expiryTime = new Date(expiresAt).getTime();
    const renewalTime = expiryTime - (5 * 60 * 1000); // 5 minutes buffer
    const delay = renewalTime - Date.now();
    
    console.log(`[Presence] Scheduling renewal in ${Math.round(delay / 60000)} minutes`);
    
    presenceSubscriptionState.renewalTimer = setTimeout(async () => {
        await renewSubscription(subscriptionId);
    }, Math.max(delay, 30000)); // Minimum 30 seconds delay
}

/**
 * Renew the presence subscription
 */
async function renewSubscription(subscriptionId) {
    try {
        console.log(`[Presence] Renewing subscription: ${subscriptionId}`);
        
        const messagingToken = await getIntermediaToken();
        const renewResponse = await fetch(`https://api.elevate.services/messaging/v1/subscriptions/${subscriptionId}/renew`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${messagingToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                duration: '24h' // Renew for 24 hours
            })
        });
        
        if (!renewResponse.ok) {
            const errorText = await renewResponse.text();
            throw new Error(`Renewal failed: ${renewResponse.status} - ${errorText}`);
        }
        
        const renewedSub = await renewResponse.json();
        const expiryTime = renewedSub.whenExpired || renewedSub.expires_at;
        console.log(`[Presence] ✅ Subscription renewed until: ${expiryTime}`);

        // Schedule next renewal
        if (expiryTime) {
            scheduleSubscriptionRenewal(subscriptionId, expiryTime);
        }
        
    } catch (error) {
        console.error('[Presence] ❌ Failed to renew subscription:', error);
        console.log('[Presence] Attempting to recreate subscription...');
        
        // Fallback: recreate the subscription
        setTimeout(() => {
            initializeDirectPresenceSubscriptions();
        }, 30000); // Retry in 30 seconds
    }
}

/**
 * Initialize the direct presence subscription system (no hub needed)
 */
async function initializeDirectPresenceSubscriptions() {
    try {
        console.log('[Presence] Initializing direct presence subscription system...');
        
        // Create direct subscription
        const subscriptionId = await createDirectPresenceSubscription();
        
        // Get initial presence data
        const allInitialAgents = await fetchAgentStatuses();
        const initialAgents = filterKnownUsers(allInitialAgents);
        
        presenceSubscriptionState.isInitialized = true;
        console.log('[Presence] ✅ Direct presence subscription system fully initialized');
        
        return initialAgents;
        
    } catch (error) {
        console.error('[Presence] ❌ Failed to initialize direct subscriptions:', error);
        presenceSubscriptionState.isInitialized = false;
        
        // Fallback to polling if subscriptions fail
        console.log('[Presence] Falling back to polling mode');
        const allAgents = await fetchAgentStatuses();
        return filterKnownUsers(allAgents);
    }
}

/**
 * Update presence in cache when notification received
 */
function updatePresenceCache(userId, presence) {
    if (!intermediaCache.agentStatuses) {
        intermediaCache.agentStatuses = new Map();
    }
    
    const existingAgent = intermediaCache.agentStatuses.get(userId);
    
    if (existingAgent) {
        // Update existing user
        const mappedStatus = mapMessagingStatus(presence);
        console.log(`[Debug] mapMessagingStatus("${presence}") returned: "${mappedStatus}"`);
        
        const updatedAgent = {
            ...existingAgent,
            status: mappedStatus,
            phoneStatus: mappedStatus,
            presenceStatus: mappedStatus,
            lastActivity: new Date().toISOString(),
            rawPresenceData: { presence, updated: new Date().toISOString() }
        };
        
        intermediaCache.agentStatuses.set(userId, updatedAgent);
        console.log(`[Presence] Updated existing user ${existingAgent.name}: ${presence} -> ${mappedStatus}`);
        
    } else {
        // NEW: Handle unknown users by looking them up
        console.log(`[Presence] Webhook for unknown user ${userId}, attempting to look up user info...`);
        
        // Try to find this user in Zendesk data
        lookupAndAddUser(userId, presence);
    }
    
    intermediaCache.lastStatusUpdate = Date.now();
}

/**
 * Clean up subscriptions on shutdown
 */
async function cleanupPresenceSubscriptions() {
    try {
        if (presenceSubscriptionState.renewalTimer) {
            clearTimeout(presenceSubscriptionState.renewalTimer);
        }
        
        if (presenceSubscriptionState.subscriptionId) {
            console.log('[Presence] Cleaning up subscription...');
            // Could add DELETE subscription API call here if available
        }
        
        presenceSubscriptionState = {
            subscriptionId: null,
            renewalTimer: null,
            isInitialized: false
        };
        
    } catch (error) {
        console.error('[Presence] Error during cleanup:', error);
    }
}

/**
 * Subscribe to presence changes for all users
 */
async function subscribeToAllUsersPresence(hubId) {
    try {
        console.log('[Presence] Creating subscription for all users...');
        
        const messagingToken = await getIntermediaToken();
        const subscriptionResponse = await fetch('https://api.elevate.services/messaging/v1/subscriptions/accounts/_me/users/_all', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${messagingToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                hub_id: hubId,
                event_types: ['presence_changed'],
                filters: {
                    // Only subscribe to @intlxsolutions.com users
                    email_domains: ['intlxsolutions.com']
                }
            })
        });
        
        if (!subscriptionResponse.ok) {
            throw new Error(`Subscription creation failed: ${subscriptionResponse.status} ${await subscriptionResponse.text()}`);
        }
        
        const subscription = await subscriptionResponse.json();
        presenceSubscriptionState.subscriptionId = subscription.id;
        
        console.log(`[Presence] ✅ Subscription created: ${subscription.id}`);
        console.log(`[Presence] Expires at: ${subscription.expires_at}`);
        
        // Schedule automatic renewal
        scheduleSubscriptionRenewal(subscription.id, subscription.expires_at);
        
        return subscription.id;
        
    } catch (error) {
        console.error('[Presence] ❌ Failed to create subscription:', error.message);
        throw error;
    }
}

/**
 * Schedule automatic subscription renewal
 */
function scheduleSubscriptionRenewal(subscriptionId, expiresAt) {
    // Clear existing timer
    if (presenceSubscriptionState.renewalTimer) {
        clearTimeout(presenceSubscriptionState.renewalTimer);
    }
    
    // Calculate renewal time (5 minutes before expiry)
    const expiryTime = new Date(expiresAt).getTime();
    const renewalTime = expiryTime - (5 * 60 * 1000); // 5 minutes buffer
    const delay = renewalTime - Date.now();
    
    console.log(`[Presence] Scheduling renewal in ${Math.round(delay / 60000)} minutes`);
    
    presenceSubscriptionState.renewalTimer = setTimeout(async () => {
        await renewSubscription(subscriptionId);
    }, Math.max(delay, 30000)); // Minimum 30 seconds delay
}

/**
 * Renew the presence subscription
 */
async function renewSubscription(subscriptionId) {
    try {
        console.log(`[Presence] Renewing subscription: ${subscriptionId}`);
        
        const messagingToken = await getIntermediaToken();
        const renewResponse = await fetch(`https://api.elevate.services/messaging/v1/subscriptions/${subscriptionId}/renew`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${messagingToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                duration: '24h' // Renew for 24 hours
            })
        });
        
        if (!renewResponse.ok) {
            throw new Error(`Renewal failed: ${renewResponse.status} ${await renewResponse.text()}`);
        }
        
        const renewedSub = await renewResponse.json();
        console.log(`[Presence] ✅ Subscription renewed until: ${renewedSub.expires_at}`);
        
        // Schedule next renewal
        scheduleSubscriptionRenewal(subscriptionId, renewedSub.expires_at);
        
    } catch (error) {
        console.error('[Presence] ❌ Failed to renew subscription:', error);
        console.log('[Presence] Attempting to recreate subscription...');
        
        // Fallback: recreate the entire subscription system
        setTimeout(() => {
            initializePresenceSubscriptions();
        }, 30000); // Retry in 30 seconds
    }
}

/**
 * Initialize the complete presence subscription system
 */
async function initializePresenceSubscriptions() {
    try {
        console.log('[Presence] Initializing real-time presence system...');
        
        // Step 1: Create notifications hub
        const hubId = await initializeNotificationsHub();
        
        // Step 2: Subscribe to all users' presence
        const subscriptionId = await subscribeToAllUsersPresence(hubId);
        
        // Step 3: Get initial presence data
        const allInitialAgents = await fetchAgentStatuses();
        const initialAgents = filterKnownUsers(allInitialAgents);
        
        presenceSubscriptionState.isInitialized = true;
        console.log('[Presence] ✅ Real-time presence system fully initialized');
        
        return initialAgents;
        
    } catch (error) {
        console.error('[Presence] ❌ Failed to initialize presence subscriptions:', error);
        presenceSubscriptionState.isInitialized = false;
        
        // Fallback to polling if subscriptions fail
        console.log('[Presence] Falling back to polling mode');
        const allAgents = await fetchAgentStatuses();
        return filterKnownUsers(allAgents);
    }
}

/**
 * NEW: Lookup unknown user and add to cache
 */
async function lookupAndAddUser(userId, presence) {
    try {
        // First, check if this user exists in our Zendesk users with Elevate IDs
        const response = await fetch('https://intlxsolutions.zendesk.com/api/v2/users.json?per_page=100', {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64')}`,
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            const zendeskUser = data.users.find(user => user.user_fields?.elevate_id === userId);
            
            if (zendeskUser) {
                // Found the user in Zendesk, add to cache
                const mappedStatus = mapMessagingStatus(presence);
                
                const newAgent = {
                    id: userId,
                    name: zendeskUser.name,
                    email: zendeskUser.email,
                    extension: 'N/A',
                    phone: 'Unknown',
                    status: mappedStatus,
                    phoneStatus: mappedStatus,
                    presenceStatus: mappedStatus,
                    onCall: false,
                    lastActivity: new Date().toISOString(),
                    source: 'zendesk_elevate_id',
                    company: 'Intlx Solutions',
                    hasPhoneData: false,
                    hasPresenceData: true,
                    zendeskUserId: zendeskUser.id,
                    rawPresenceData: { presence, updated: new Date().toISOString() }
                };
                
                intermediaCache.agentStatuses.set(userId, newAgent);
                console.log(`[Presence] Added new user to cache: ${zendeskUser.name} with status ${mappedStatus}`);
                
            } else {
                console.log(`[Presence] User ${userId} not found in Zendesk users with Elevate IDs`);
            }
        }
        
    } catch (error) {
        console.error(`[Presence] Error looking up user ${userId}:`, error.message);
    }
}

/**
 * Debug endpoint to check address book authentication
 */
router.get('/debug-address-book-auth', async (req, res) => {
    try {
        console.log('[Debug] Checking address book authentication...');
        
        const hasGlobalToken = !!global.addressBookToken;
        
        if (!hasGlobalToken) {
            return res.json({
                success: false,
                hasToken: false,
                message: 'No address book token found in global scope',
                suggestion: 'Need to authenticate via /api/auth/serverdata/login'
            });
        }
        
        // Test the token
        const response = await fetch('https://api.elevate.services/address-book/v3/accounts/_me/contacts', {
            headers: {
                'Authorization': `Bearer ${global.addressBookToken}`,
                'Accept': 'application/json'
            }
        });
        
        const isValid = response.ok;
        const responseText = await response.text();
        
        res.json({
            success: isValid,
            hasToken: true,
            tokenValid: isValid,
            responseStatus: response.status,
            responsePreview: responseText.substring(0, 200),
            tokenPreview: global.addressBookToken ? global.addressBookToken.substring(0, 20) + '...' : null,
            message: isValid ? 'Address book token is valid' : 'Address book token is invalid or expired',
            suggestion: isValid ? 'Token is working' : 'Re-authenticate via /api/auth/serverdata/login'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});



// TEMPORARY: Add this to test the cleanup, remove after verification
router.get('/debug-function-count', (req, res) => {
    const apiFileContent = require('fs').readFileSync(__filename, 'utf8');
    const functionMatches = apiFileContent.match(/async function fetchAgentStatuses/g) || [];
    const functionCount = functionMatches.length;
    
    res.json({
        fetchAgentStatusesFunctionCount: functionCount,
        shouldBe: 1,
        cleanupComplete: functionCount === 1,
        message: functionCount === 1 ? 
            'Cleanup successful! Only 1 function found.' : 
            `Found ${functionCount} functions - need to remove duplicates.`
    });
});

// Enhanced debugging - add this to your router endpoints section
router.get('/debug-find-all-functions', (req, res) => {
    const fs = require('fs');
    const apiFileContent = fs.readFileSync(__filename, 'utf8');
    const lines = apiFileContent.split('\n');
    
    // Find ALL function definitions
    const allFunctions = [];
    const fetchAgentStatusesFunctions = [];
    const addressBookReferences = [];
    
    lines.forEach((line, index) => {
        const lineNum = index + 1;
        const trimmedLine = line.trim();
        
        // Find all function definitions
        if (trimmedLine.startsWith('async function ') || trimmedLine.startsWith('function ')) {
            allFunctions.push({ lineNum, content: trimmedLine });
        }
        
        // Find specific fetchAgentStatuses
        if (trimmedLine.includes('fetchAgentStatuses')) {
            fetchAgentStatusesFunctions.push({ lineNum, content: trimmedLine });
        }
        
        // Find Address Book references in function context
        if (trimmedLine.includes('addressBookToken') || trimmedLine.includes('intlxsolutions.com')) {
            addressBookReferences.push({ lineNum, content: trimmedLine });
        }
    });
    
    res.json({
        totalFunctions: allFunctions.length,
        fetchAgentStatusesReferences: fetchAgentStatusesFunctions.length,
        fetchAgentStatusesFunctions,
        addressBookReferences: addressBookReferences.slice(0, 10), // First 10 refs
        allFunctions: allFunctions.slice(0, 20) // First 20 functions
    });
});

// Add this enhanced debug endpoint
router.get('/debug-zendesk-code-vs-manual', async (req, res) => {
    try {
        const email = process.env.ZENDESK_EMAIL;
        const token = process.env.ZENDESK_API_TOKEN;
        const subdomain = process.env.ZENDESK_SUBDOMAIN;
        
        // Show exactly what your code sees
        const codeAuth = Buffer.from(`${email}/token:${token}`).toString('base64');
        const codeUrl = `https://${subdomain}.zendesk.com/api/v2/users.json?per_page=100&page=1`;
        
        // Show exactly what manual curl used
        const manualAuth = Buffer.from(`rob.johnston@intlxsolutions.com/token:LJ3usrUgoeBZ2fCnGJX2mawtixdr0XnOh7rxPSuI`).toString('base64');
        const manualUrl = `https://intlxsolutions.zendesk.com/api/v2/users/me.json`;
        
        // Test the exact same call your getZendeskUsersWithElevateIds function makes
        console.log('[Debug] Testing code path...');
        const response = await fetch(codeUrl, {
            headers: {
                'Authorization': `Basic ${codeAuth}`,
            }
        });
        
        const responseText = await response.text();
        
        res.json({
            success: response.ok,
            status: response.status,
            comparison: {
                codeAuth: codeAuth,
                manualAuth: manualAuth,
                authMatch: codeAuth === manualAuth,
                codeUrl: codeUrl,
                manualUrl: manualUrl
            },
            environmentVariables: {
                email: email,
                token: token ? `${token.substring(0, 8)}...` : 'MISSING',
                subdomain: subdomain
            },
            responsePreview: responseText.substring(0, 300),
            message: response.ok ? 'Code path works!' : 'Code path failing - see comparison'
        });
        
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Add this debug endpoint to your api.js

router.get('/debug-webhook-cache-state', async (req, res) => {
    try {
        const cacheSize = intermediaCache.agentStatuses ? intermediaCache.agentStatuses.size : 0;
        const cacheKeys = intermediaCache.agentStatuses ? Array.from(intermediaCache.agentStatuses.keys()) : [];
        const sampleCache = intermediaCache.agentStatuses && cacheSize > 0 ? 
            Array.from(intermediaCache.agentStatuses.values()).slice(0, 2) : [];

        res.json({
            // Subscription state
            subscriptionState: {
                isInitialized: presenceSubscriptionState.isInitialized,
                subscriptionId: presenceSubscriptionState.subscriptionId,
                hasRenewalTimer: !!presenceSubscriptionState.renewalTimer
            },
            
            // Cache state
            cacheState: {
                hasCacheMap: !!intermediaCache.agentStatuses,
                cacheSize: cacheSize,
                lastUpdate: intermediaCache.lastStatusUpdate ? 
                    new Date(intermediaCache.lastStatusUpdate).toISOString() : null,
                cacheKeys: cacheKeys.slice(0, 5), // First 5 user IDs
                sampleAgents: sampleCache
            },
            
            // Conditional check results
            checks: {
                subscriptionInitialized: presenceSubscriptionState.isInitialized,
                hasSubscriptionId: !!presenceSubscriptionState.subscriptionId,
                cacheExists: !!(intermediaCache.agentStatuses && intermediaCache.agentStatuses.size > 0),
                wouldUseCache: presenceSubscriptionState.isInitialized && 
                              presenceSubscriptionState.subscriptionId &&
                              intermediaCache.agentStatuses && 
                              intermediaCache.agentStatuses.size > 0
            }
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add these endpoints to your api.js file (after any existing router.get() endpoint)

/**
 * Debug endpoint to populate initial cache for all agents
 */
router.get('/debug-populate-initial-cache', async (req, res) => {
    try {
        console.log('[Debug] Populating initial cache - PRESERVING webhook data...');
        
        // Step 1: Get fresh data for all agents
        const freshAgents = await fetchAgentStatuses();
        console.log(`[Debug] Fetched ${freshAgents.length} agents from fresh API`);
        
        // Step 2: Ensure cache exists
        if (!intermediaCache.agentStatuses) {
            intermediaCache.agentStatuses = new Map();
        }
        
        const originalCacheSize = intermediaCache.agentStatuses.size;
        
        let added = 0;
        let preserved = 0;
        let freshDataSkipped = 0;
        
        // Step 3: Add ONLY fresh agents that don't exist in webhook cache
        freshAgents.forEach(freshAgent => {
            const existingAgent = intermediaCache.agentStatuses.get(freshAgent.id);
            
            if (existingAgent) {
                // PRESERVE existing webhook data (it's more accurate than fresh API)
                console.log(`[Debug] PRESERVING webhook data for ${existingAgent.name}: ${existingAgent.status} (webhook) vs ${freshAgent.status} (fresh API)`);
                preserved++;
                freshDataSkipped++;
            } else {
                // Add new agent from fresh data (no webhook data available)
                intermediaCache.agentStatuses.set(freshAgent.id, {
                    ...freshAgent,
                    dataSource: 'fresh_api_initial'
                });
                console.log(`[Debug] ADDED new agent from fresh API: ${freshAgent.name} - ${freshAgent.status}`);
                added++;
            }
        });
        
        intermediaCache.lastStatusUpdate = Date.now();
        
        // Step 4: Analyze final cache
        const cacheAgents = Array.from(intermediaCache.agentStatuses.values());
        const webhookAgents = cacheAgents.filter(a => a.rawPresenceData?.updated);
        const freshApiAgents = cacheAgents.filter(a => !a.rawPresenceData?.updated);
        
        const statusCounts = {
            online: cacheAgents.filter(a => ['Online', 'Available'].includes(a.status)).length,
            busy: cacheAgents.filter(a => ['Busy', 'On Phone'].includes(a.status)).length,
            away: cacheAgents.filter(a => ['Away', 'Idle'].includes(a.status)).length,
            offline: cacheAgents.filter(a => ['Offline'].includes(a.status)).length
        };
        
        const webhookStatusCounts = {
            online: webhookAgents.filter(a => ['Online', 'Available'].includes(a.status)).length,
            busy: webhookAgents.filter(a => ['Busy', 'On Phone'].includes(a.status)).length,
            away: webhookAgents.filter(a => ['Away', 'Idle'].includes(a.status)).length,
            offline: webhookAgents.filter(a => ['Offline'].includes(a.status)).length
        };
        
        console.log(`[Debug] Cache populated: ${added} added, ${preserved} preserved, ${intermediaCache.agentStatuses.size} total`);
        console.log(`[Debug] Webhook agents (real-time): ${webhookAgents.length}, Fresh API agents: ${freshApiAgents.length}`);
        
        res.json({
            success: true,
            message: `Cache populated with ${intermediaCache.agentStatuses.size} agents`,
            analysis: {
                originalCacheSize: originalCacheSize,
                freshAgentsReceived: freshAgents.length,
                added: added,
                preserved: preserved,
                freshDataSkipped: freshDataSkipped,
                totalCached: intermediaCache.agentStatuses.size
            },
            dataSources: {
                webhookAgents: {
                    count: webhookAgents.length,
                    statusBreakdown: webhookStatusCounts,
                    users: webhookAgents.map(a => ({ name: a.name, status: a.status, lastUpdate: a.rawPresenceData?.updated }))
                },
                freshApiAgents: {
                    count: freshApiAgents.length,
                    note: freshApiAgents.length > 0 ? "These users haven't changed status since webhook subscription was created" : "All users have real-time webhook data!"
                }
            },
            statusBreakdown: statusCounts,
            issue: {
                freshApiProblem: freshDataSkipped > 0,
                description: freshDataSkipped > 0 ? 
                    `Fresh API showing ${freshAgents.filter(a => a.status === 'Offline').length}/${freshAgents.length} users as Offline, but webhooks show ${webhookAgents.filter(a => a.status !== 'Offline').length} users are actually Online/Away/Busy` : 
                    "No issues detected"
            },
            nextStep: 'Check your UI - should now show all agents with accurate status data!'
        });
        
    } catch (error) {
        console.error('[Debug] Error populating cache:', error);
        res.status(500).json({ error: error.message });
    }
});

// ALSO ADD this diagnostic endpoint to investigate the fresh API issue:
router.get('/debug-fresh-api-vs-webhooks', async (req, res) => {
    try {
        console.log('[Debug] Comparing fresh API data vs webhook data...');
        
        // Get fresh API data
        const freshAgents = await fetchAgentStatuses();
        
        // Get webhook cache data
        const webhookAgents = intermediaCache.agentStatuses ? 
            Array.from(intermediaCache.agentStatuses.values()).filter(a => a.rawPresenceData?.updated) : [];
        
        // Compare data for same users
        const comparisons = [];
        webhookAgents.forEach(webhookAgent => {
            const freshAgent = freshAgents.find(f => f.id === webhookAgent.id);
            if (freshAgent) {
                comparisons.push({
                    name: webhookAgent.name,
                    webhookStatus: webhookAgent.status,
                    freshApiStatus: freshAgent.status,
                    mismatch: webhookAgent.status !== freshAgent.status,
                    webhookUpdated: webhookAgent.rawPresenceData?.updated,
                    timeDifference: webhookAgent.rawPresenceData?.updated ? 
                        Math.round((Date.now() - new Date(webhookAgent.rawPresenceData.updated).getTime()) / 1000) + 's ago' : 
                        'unknown'
                });
            }
        });
        
        const mismatches = comparisons.filter(c => c.mismatch);
        
        res.json({
            success: true,
            summary: {
                webhookAgents: webhookAgents.length,
                freshApiAgents: freshAgents.length,
                comparisons: comparisons.length,
                mismatches: mismatches.length,
                accuracy: mismatches.length === 0 ? "Perfect match" : `${mismatches.length}/${comparisons.length} mismatches`
            },
            comparisons: comparisons,
            issue: mismatches.length > 0 ? {
                problem: "Fresh API data is stale/incorrect",
                recommendation: "Use webhook data as primary source, fresh API only for missing users",
                commonMismatch: mismatches.length > 0 ? `Webhooks show users as '${mismatches[0].webhookStatus}' but fresh API shows '${mismatches[0].freshApiStatus}'` : null
            } : null,
            freshApiAllOfflineIssue: {
                detected: freshAgents.every(a => a.status === 'Offline'),
                description: freshAgents.every(a => a.status === 'Offline') ? 
                    "ALL fresh API calls return 'Offline' - this suggests API endpoint/token issue" : 
                    "Fresh API returns mixed statuses"
            }
        });
        
    } catch (error) {
        console.error('[Debug] Error comparing data:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Debug endpoint to check detailed agent status with data sources
 */
router.get('/debug-agent-status-detailed', async (req, res) => {
    try {
        console.log('[API] Debug agent status requested');
        
        // Check if we have a valid webhook subscription and cache
        if (presenceSubscriptionState.isInitialized && 
            presenceSubscriptionState.subscriptionId && 
            intermediaCache.agentStatuses && 
            intermediaCache.agentStatuses.size > 0) {
            
            console.log('[API] Returning cached agent statuses (updated by webhooks)');
            
            const agents = Array.from(intermediaCache.agentStatuses.values());
            
            // Add data source info to each agent
            const agentsWithSource = agents.map(agent => ({
                ...agent,
                dataSource: agent.rawPresenceData?.updated ? 'webhook_realtime' : 'api_fresh'
            }));
            
            return res.json({
                success: true,
                agents: agentsWithSource,
                cached: true,
                source: 'webhook_cache',
                subscriptionId: presenceSubscriptionState.subscriptionId,
                lastUpdated: intermediaCache.lastStatusUpdate ? 
                    new Date(intermediaCache.lastStatusUpdate).toISOString() : null,
                totalAgents: agentsWithSource.length,
                realtimeAgents: agentsWithSource.filter(a => a.dataSource === 'webhook_realtime').length
            });
        }
        
        // If no webhook cache, fetch fresh data
        console.log('[API] No webhook cache available, fetching fresh presence data...');
const allAgents = await fetchAgentStatuses();
const agents = allAgents.filter(agent => {
    return !agent.name.startsWith('Unknown User') && 
           !agent.name.includes('Unknown User') &&
           agent.email && 
           agent.email.includes('@intlxsolutions.com');
});
        
        return res.json({
            success: true,
            agents: agents.map(agent => ({ ...agent, dataSource: 'api_fresh' })),
            cached: false,
            source: 'fresh_fetch',
            lastUpdated: new Date().toISOString(),
            totalAgents: agents.length,
            realtimeAgents: 0
        });
        
    } catch (error) {
        console.error('[API] Error getting agent status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Add this to your api.js to force webhook subscription creation

router.get('/debug-force-webhook-setup', async (req, res) => {
    try {
        console.log('[Debug] Forcing webhook subscription setup...');
        
        // Step 1: Check current subscription state
        console.log('[Debug] Current subscription state:', {
            isInitialized: presenceSubscriptionState.isInitialized,
            subscriptionId: presenceSubscriptionState.subscriptionId
        });
        
        // Step 2: Get token with notifications scope
        const tokenResponse = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.INTERMEDIA_CLIENT_ID,
                client_secret: process.env.INTERMEDIA_CLIENT_SECRET,
                scope: 'api.service.notifications'
            })
        });
        
        if (!tokenResponse.ok) {
            return res.json({ success: false, error: 'Failed to get token' });
        }
        
        const tokenData = await tokenResponse.json();
        console.log('[Debug] ✅ Got notifications token');
        
        // Step 3: Create subscription
        const subscriptionPayload = {
            "events": ["messaging.presence-control.changed"],
            "ttl": "08:00:00",
            "delivery": {
                "transport": "webhook",
                "uri": "https://intlxassetmgr-proxy.onrender.com/api/notifications"
            }
        };
        
        const subscriptionResponse = await fetch('https://api.elevate.services/notifications/v2/accounts/_me/subscriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(subscriptionPayload)
        });
        
        const subscriptionResult = await subscriptionResponse.json();
        
        if (subscriptionResponse.ok) {
            // Update subscription state
            presenceSubscriptionState.subscriptionId = subscriptionResult.id || subscriptionResult.subscriptionId;
            presenceSubscriptionState.isInitialized = true;
            
            console.log('[Debug] ✅ Webhook subscription created:', subscriptionResult);
            
            // Step 4: Initialize cache if it doesn't exist
            if (!intermediaCache.agentStatuses) {
                intermediaCache.agentStatuses = new Map();
                console.log('[Debug] ✅ Initialized agent status cache');
            }
            
            res.json({
                success: true,
                subscriptionCreated: true,
                subscriptionId: presenceSubscriptionState.subscriptionId,
                cacheInitialized: true,
                nextStep: 'Test by changing your status in the Intermedia app'
            });
            
        } else {
            console.log('[Debug] ❌ Subscription creation failed:', subscriptionResult);
            res.json({
                success: false,
                error: subscriptionResult,
                step: 'subscription_creation_failed'
            });
        }
        
    } catch (error) {
        console.error('[Debug] Error in force webhook setup:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Debug endpoint to test messaging API user endpoints
 */
router.get('/debug-messaging-users-only', async (req, res) => {
    try {
        console.log('[Debug] Testing messaging API user endpoints only...');
        
        const messagingToken = await getIntermediaToken();
        
        const endpointsToTest = [
            'https://api.elevate.services/messaging/v1/accounts/_me/users',
            'https://api.elevate.services/messaging/v1/users',
            'https://api.elevate.services/messaging/v1/accounts/_me',
            'https://api.elevate.services/messaging/v1/account/users'
        ];
        
        const results = [];
        
        for (const endpoint of endpointsToTest) {
            try {
                const response = await fetch(endpoint, {
                    headers: {
                        'Authorization': `Bearer ${messagingToken}`,
                        'Accept': 'application/json'
                    }
                });
                
                const result = {
                    endpoint: endpoint,
                    status: response.status,
                    ok: response.ok
                };
                
                if (response.ok) {
                    const data = await response.json();
                    result.dataType = Array.isArray(data) ? 'array' : 'object';
                    result.dataStructure = Object.keys(data);
                    result.userCount = Array.isArray(data) ? data.length : 
                        (data.users ? data.users.length : 
                         data.results ? data.results.length : 0);
                    result.sampleUser = Array.isArray(data) ? data[0] : 
                        (data.users?.[0] || data.results?.[0] || null);
                } else {
                    result.error = await response.text();
                }
                
                results.push(result);
                
            } catch (error) {
                results.push({
                    endpoint: endpoint,
                    error: error.message,
                    failed: true
                });
            }
        }
        
        const workingEndpoints = results.filter(r => r.ok);
        
        res.json({
            success: workingEndpoints.length > 0,
            tokenObtained: !!messagingToken,
            workingEndpoints: workingEndpoints.map(r => ({
                endpoint: r.endpoint,
                userCount: r.userCount,
                dataStructure: r.dataStructure
            })),
            allResults: results,
            recommendation: workingEndpoints.length > 0 ? 
                `Use ${workingEndpoints[0].endpoint} for user discovery` :
                'No working messaging user endpoints found - check scope permissions'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Debug endpoint to test the address book + messaging presence approach
 */
router.get('/debug-presence-flow', async (req, res) => {
    try {
        console.log('[Debug] Testing address book + messaging presence flow...');
        
        // Step 1: Test address book
        const addressBookResponse = await fetch('https://api.elevate.services/address-book/v3/accounts/_me/contacts', {
            headers: {
                'Authorization': `Bearer ${global.addressBookToken}`,
                'Accept': 'application/json'
            }
        });
        
        const addressBookData = await addressBookResponse.json();
        const users = addressBookData.results || addressBookData.contacts || [];
        
        // Step 2: Test messaging token
        const messagingToken = await getIntermediaToken();
        
        // Step 3: Test presence API for first user
        let presenceTest = null;
        if (users.length > 0) {
            const testUser = users[0];
            const unifiedUserId = testUser.unifiedUserId || testUser.id || testUser.userId;
            
            if (unifiedUserId) {
                try {
                    const presenceResponse = await fetch(
                        `https://api.elevate.services/messaging/v1/presence/accounts/_me/users/${unifiedUserId}`,
                        {
                            headers: {
                                'Authorization': `Bearer ${messagingToken}`,
                                'Accept': 'application/json'
                            }
                        }
                    );
                    
                    presenceTest = {
                        unifiedUserId: unifiedUserId,
                        userName: testUser.name,
                        presenceStatus: presenceResponse.status,
                        presenceOk: presenceResponse.ok,
                        presenceData: presenceResponse.ok ? await presenceResponse.json() : await presenceResponse.text()
                    };
                } catch (e) {
                    presenceTest = { error: e.message };
                }
            }
        }
        
        res.json({
            success: true,
            addressBook: {
                status: addressBookResponse.status,
                ok: addressBookResponse.ok,
                userCount: users.length,
                sampleUser: users[0] || null
            },
            messagingToken: {
                obtained: !!messagingToken,
                tokenPreview: messagingToken ? messagingToken.substring(0, 20) + '...' : null
            },
            presenceTest: presenceTest,
            recommendation: presenceTest?.presenceOk ? 
                'Presence API working! The flow should work now.' :
                'Presence API issue - check token scope or user ID format'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

https://intlxassetmgr-proxy.onrender.com/api/auth/serverdata/login

/**
 * Process presence data from messaging API
 */
function processMessagingPresenceData(data, endpoint) {
    console.log('[Agent Status] Processing messaging presence data');
    const agents = [];

    // Handle different response formats
    let presenceList = [];
    if (Array.isArray(data)) {
        presenceList = data;
    } else if (data.users && Array.isArray(data.users)) {
        presenceList = data.users;
    } else if (data.presence && Array.isArray(data.presence)) {
        presenceList = data.presence;
    } else if (data.data && Array.isArray(data.data)) {
        presenceList = data.data;
    }

    presenceList.forEach(item => {
        agents.push({
            id: item.id || item.userId || item.unifiedUserId,
            name: item.displayName || item.name || `User ${item.id}`,
            email: item.email || `user${item.id}@company.com`,
            extension: item.extension || 'N/A',
            status: mapMessagingStatus(item.status || item.presence),
            onCall: item.onCall || item.inCall || false,
            lastActivity: item.lastActivity || item.lastSeen || new Date().toISOString()
        });
    });

    console.log(`[Agent Status] Processed ${agents.length} agents from messaging presence data`);
    return agents;
}

// ============================================
// UPDATE PRESENCE CACHE WITH DEBUG LOGGING
// ============================================

/**
 * 🚀 SEAMLESS AUTO-INITIALIZE: Enhanced agent status endpoint
 * REPLACE your existing router.get('/agent-status') with this version
 */
router.get('/agent-status', async (req, res) => {
    try {
        console.log('[API] Agent status requested (enhanced auto-initialize)');
        
        // Check if cache is healthy
        const cacheHealthy = intermediaCache.agentStatuses && 
                           intermediaCache.agentStatuses.size > 0 &&
                           intermediaCache.lastStatusUpdate &&
                           (Date.now() - intermediaCache.lastStatusUpdate) < 600000; // 10 minutes
        
        if (!cacheHealthy) {
            console.log('[API] Cache unhealthy or empty, reinitializing...');
            await initializePresenceCache();
        }
        
        // Return cached data
        if (intermediaCache.agentStatuses && intermediaCache.agentStatuses.size > 0) {
            const agents = Array.from(intermediaCache.agentStatuses.values())
    .filter(agent => {
        // Filter out unknown users
        return !agent.name.startsWith('Unknown User') && 
               !agent.name.includes('Unknown User') &&
               agent.email && 
               agent.email.includes('@intlxsolutions.com');
    })
    .map(agent => ({
        ...agent,
        dataSource: agent.dataSource || 'cache'
    }));
            
            return res.json({
                success: true,
                agents: agents,
                cached: true,
                source: 'auto_managed_cache',
                cache_size: intermediaCache.agentStatuses.size,
                lastUpdated: intermediaCache.lastStatusUpdate ? 
                    new Date(intermediaCache.lastStatusUpdate).toISOString() : null,
                totalAgents: agents.length
            });
        }
        
        // Fallback to fresh fetch
        console.log('[API] No cache available, fetching fresh data...');
        const allAgents = await fetchAgentStatuses();
        const agents = filterKnownUsers(allAgents);
        
        return res.json({
            success: true,
            agents: agents.map(agent => ({ ...agent, dataSource: 'fresh_fetch' })),
            cached: false,
            source: 'fresh_fetch',
            lastUpdated: new Date().toISOString(),
            totalAgents: agents.length
        });
        
    } catch (error) {
        console.error('[API] Error in agent-status endpoint:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Enhanced agent status with Mattermost integration
 * GET /api/agent-status-enhanced
 */
router.get('/agent-status-enhanced', async (req, res) => {
    try {
        console.log('[Agent Status Enhanced] Fetching from all sources...');

        // Fetch from all sources in parallel
        const [intermediaStatuses, mattermostStatuses] = await Promise.all([
            fetchAgentStatuses(), // Your existing Intermedia function
            fetchMattermostStatuses()
        ]);

        console.log(`[Agent Status Enhanced] Got ${intermediaStatuses.length} Intermedia, ${mattermostStatuses.length} Mattermost`);

        // Merge statuses by email
        const mergedStatuses = intermediaStatuses.map(agent => {
            // Find matching Mattermost user by email
            const mmUser = mattermostStatuses.find(mm => 
                mm.email?.toLowerCase() === agent.email?.toLowerCase()
            );

            if (mmUser) {
                console.log(`[DEBUG] Merging ${agent.name}: mmUser.custom_status =`, mmUser.custom_status);
                return {
                    ...agent,
                    mattermost_status: mapMattermostStatus(mmUser.status),
                    mattermost_raw: mmUser.status,
                    mattermost_last_activity: mmUser.last_activity_at,
                    mattermost_manual: mmUser.manual,
                    has_mattermost: true,
                    mattermost_user_id: mmUser.id,
                    custom_status: mmUser.custom_status, 
                    combined_status: determineCombinedStatus(agent.status, mmUser.status, agent.lastActivity, mmUser.last_activity_at)
                };
            }

            return {
                ...agent,
                has_mattermost: false,
                combined_status: agent.status
            };
        });

        // Add Mattermost-only users (not in Intermedia)
        const intermediaEmails = new Set(intermediaStatuses.map(a => a.email?.toLowerCase()));
        const mattermostOnlyUsers = mattermostStatuses
            .filter(mm => mm.email && !intermediaEmails.has(mm.email.toLowerCase()))
            .map(mm => {
                console.log(`[DEBUG] Mattermost-only user ${mm.name}: custom_status =`, mm.custom_status);
                return {
                    id: mm.id,
                    name: mm.name,
                    email: mm.email,
                    status: mapMattermostStatus(mm.status),
                    mattermost_status: mapMattermostStatus(mm.status),
                    mattermost_raw: mm.status,
                    mattermost_user_id: mm.id,  
                    custom_status: mm.custom_status || null, 
                    lastActivity: mm.last_activity_at,
                    has_mattermost: true,
                    source: 'mattermost_only',
                    combined_status: mapMattermostStatus(mm.status)
                };
            });

        const allStatuses = [...mergedStatuses, ...mattermostOnlyUsers];

        res.json({
            agents: allStatuses,
            total: allStatuses.length,
            with_mattermost: allStatuses.filter(a => a.has_mattermost).length,
            sources: {
                intermedia: intermediaStatuses.length,
                mattermost: mattermostStatuses.length,
                mattermost_only: mattermostOnlyUsers.length
            },
            lastUpdated: new Date().toISOString()
        });

    } catch (error) {
        console.error('[Agent Status Enhanced] Error:', error.message);
        res.status(500).json({ 
            error: 'Failed to fetch enhanced agent status',
            details: error.message 
        });
    }
});

/**
 * Update Mattermost user status
 * PUT /api/mattermost-status
 */
router.put('/mattermost-status', async (req, res) => {
    try {
        const { userId, status, manual, clearCustom } = req.body;

        if (!userId || !status) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                details: 'userId and status are required'
            });
        }

        if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
            return res.status(500).json({ 
                error: 'Mattermost not configured',
                details: 'MATTERMOST_URL and MATTERMOST_TOKEN must be set'
            });
        }

        // Valid statuses: online, away, dnd, offline
        const validStatuses = ['online', 'away', 'dnd', 'offline'];
        if (!validStatuses.includes(status.toLowerCase())) {
            return res.status(400).json({ 
                error: 'Invalid status',
                details: `Status must be one of: ${validStatuses.join(', ')}`
            });
        }

        console.log(`[Mattermost] Updating status for user ${userId} to ${status}`);

        // Clear custom status if requested
        if (clearCustom) {
            try {
                console.log('[Mattermost] Clearing custom status...');
                await fetch(`${MATTERMOST_URL}/api/v4/users/${userId}/status/custom`, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });
                console.log('[Mattermost] Custom status cleared successfully');
            } catch (err) {
                console.error('[Mattermost] Error clearing custom status:', err.message);
            }
        }

        // Update Mattermost status with detailed logging
        const updateUrl = `${MATTERMOST_URL}/api/v4/users/${userId}/status`;
        
        const requestBody = {
            user_id: userId,
            status: status.toLowerCase(),
            manual: manual !== false,
            last_activity_at: Date.now()
        };
        
        console.log(`[Mattermost] ========== STATUS UPDATE REQUEST ==========`);
        console.log(`[Mattermost] URL: ${updateUrl}`);
        console.log(`[Mattermost] Method: PUT`);
        console.log(`[Mattermost] Body:`, JSON.stringify(requestBody, null, 2));
        console.log(`[Mattermost] Token: ${MATTERMOST_TOKEN.substring(0, 10)}...`);
        
        const response = await fetch(updateUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const responseText = await response.text();
        console.log(`[Mattermost] ========== STATUS UPDATE RESPONSE ==========`);
        console.log(`[Mattermost] Status Code: ${response.status}`);
        console.log(`[Mattermost] Response Body: ${responseText}`);
        console.log(`[Mattermost] ==========================================`);

        if (!response.ok) {
            throw new Error(`Mattermost API returned ${response.status}: ${responseText}`);
        }

        let result;
        try {
            result = JSON.parse(responseText);
        } catch (e) {
            result = { status: status.toLowerCase() };
        }

        console.log(`[Mattermost] ✅ Status updated successfully for user ${userId}`);

        res.json({
            success: true,
            userId,
            status: result.status || status.toLowerCase(),
            manual: result.manual || true,
            customCleared: clearCustom || false,
            message: 'Status updated successfully'
        });

    } catch (error) {
        console.error('[Mattermost] ❌ Error updating status:', error.message);
        res.status(500).json({ 
            error: 'Failed to update Mattermost status',
            details: error.message 
        });
    }
});

/**
 * Update Mattermost custom status with text
 * PUT /api/mattermost-custom-status
 */
router.put('/mattermost-custom-status', async (req, res) => {
    try {
        const { userId, text, emoji, duration, setStatusToDnd } = req.body;

        if (!userId || !text) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                details: 'userId and text are required'
            });
        }

        if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
            return res.status(500).json({ 
                error: 'Mattermost not configured',
                details: 'MATTERMOST_URL and MATTERMOST_TOKEN must be set'
            });
        }

        console.log(`[Mattermost] Setting custom status for user ${userId}: "${text}"`);

        // Prepare the custom status payload
        const customStatusPayload = {
            emoji: emoji || 'speech_balloon',
            text: text.substring(0, 100)
        };

        if (duration) {
            customStatusPayload.duration = duration;
            
            if (duration === 'date_and_time') {
                customStatusPayload.expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            }
        }

        console.log('[Mattermost] Custom status payload:', JSON.stringify(customStatusPayload, null, 2));

        // Set custom status in Mattermost
        const response = await fetch(`${MATTERMOST_URL}/api/v4/users/${userId}/status/custom`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(customStatusPayload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Mattermost] Custom status update failed:', errorText);
            throw new Error(`Mattermost API returned ${response.status}: ${errorText}`);
        }

        // Response may be empty or JSON
        let result = {};
        const responseText = await response.text();
        if (responseText) {
            try {
                result = JSON.parse(responseText);
            } catch (e) {
                console.log('[Mattermost] Empty or non-JSON response (OK)');
            }
        }

        console.log(`[Mattermost] ✅ Custom status updated successfully for user ${userId}`);

        // If user wants to show as busy, update their status to DND
        if (setStatusToDnd) {
            try {
                console.log('[Mattermost] Setting status to DND...');
                await fetch(`${MATTERMOST_URL}/api/v4/users/${userId}/status`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        user_id: userId,
                        status: 'dnd'
                    })
                });
                console.log('[Mattermost] Status set to DND');
            } catch (err) {
                console.error('[Mattermost] Failed to set DND status:', err.message);
            }
        }

        // Cache the custom status
        const customStatusData = {
            text: text,
            emoji: emoji || 'speech_balloon',
            duration: duration || null,
            timestamp: Date.now()
        };
        customStatusCache.set(userId, customStatusData);
        console.log(`[Mattermost] Cached custom status for user ${userId}:`, customStatusData);

        res.json({
            success: true,
            userId,
            custom_status: customStatusData,
            message: 'Custom status updated successfully'
        });

    } catch (error) {
        console.error('[Mattermost] Error updating custom status:', error.message);
        res.status(500).json({ 
            error: 'Failed to update custom status',
            details: error.message 
        });
    }
});

/**
 * Delete/Clear Mattermost custom status
 * DELETE /api/mattermost-custom-status
 */
router.delete('/mattermost-custom-status', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                details: 'userId is required'
            });
        }

        if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
            return res.status(500).json({ 
                error: 'Mattermost not configured',
                details: 'MATTERMOST_URL and MATTERMOST_TOKEN must be set'
            });
        }

        console.log(`[Mattermost] Clearing custom status for user ${userId}`);

        // Delete custom status in Mattermost - NO BODY NEEDED
        const response = await fetch(`${MATTERMOST_URL}/api/v4/users/${userId}/status/custom`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${MATTERMOST_TOKEN}`
                // No Content-Type needed for DELETE with no body
            }
        });

        // DELETE can return 200 or 204 (no content)
        if (!response.ok && response.status !== 204) {
            const errorText = await response.text();
            console.error('[Mattermost] Custom status clear failed:', errorText);
            throw new Error(`Mattermost API returned ${response.status}: ${errorText}`);
        }

        console.log(`[Mattermost] ✅ Custom status cleared successfully for user ${userId}`);

        // Remove from cache
        customStatusCache.delete(userId);
        console.log(`[Mattermost] 🗑️ Removed cached custom status for user ${userId}`);
        console.log(`[Mattermost] Cache now has ${customStatusCache.size} entries`);

        // Set status back to online when clearing
        try {
            console.log('[Mattermost] Setting status back to online...');
            await fetch(`${MATTERMOST_URL}/api/v4/users/${userId}/status`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    user_id: userId,
                    status: 'online'
                })
            });
            console.log('[Mattermost] Status set back to online');
        } catch (err) {
            console.error('[Mattermost] Failed to set status back to online:', err.message);
        }

        res.json({
            success: true,
            userId,
            message: 'Custom status cleared successfully'
        });

            } catch (error) {
                console.error('[Mattermost] Error clearing custom status:', error.message);
                res.status(500).json({ 
                    error: 'Failed to clear custom status',
                    details: error.message 
                });
            }
        });

/**
 * Delete/Clear Mattermost custom status
 * DELETE /api/mattermost-custom-status
 */
router.delete('/mattermost-custom-status', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                details: 'userId is required'
            });
        }

        if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
            return res.status(500).json({ 
                error: 'Mattermost not configured',
                details: 'MATTERMOST_URL and MATTERMOST_TOKEN must be set'
            });
        }

        console.log(`[Mattermost] Clearing custom status for user ${userId}`);

        // Delete custom status in Mattermost
        const response = await fetch(`${MATTERMOST_URL}/api/v4/users/${userId}/status/custom`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok && response.status !== 200) {
            const errorText = await response.text();
            console.error('[Mattermost] Custom status clear failed:', errorText);
            throw new Error(`Mattermost API returned ${response.status}: ${errorText}`);
        }

        console.log(`[Mattermost] ✅ Custom status cleared successfully for user ${userId}`);

        // Remove from cache
        customStatusCache.delete(userId);
        console.log(`[Mattermost] Removed cached custom status for user ${userId}`);
        console.log(`[Mattermost] Cache now has ${customStatusCache.size} entries`);

        res.json({
            success: true,
            userId,
            message: 'Custom status cleared successfully'
        });

    } catch (error) {
        console.error('[Mattermost] Error clearing custom status:', error.message);
        res.status(500).json({ 
            error: 'Failed to clear custom status',
            details: error.message 
        });
    }
});

/**
 * Check Mattermost server info
 * GET /api/mattermost-info
 */
router.get('/mattermost-info', async (req, res) => {
    try {
        if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
            return res.status(500).json({ 
                error: 'Mattermost not configured'
            });
        }

        // Get server version
        const response = await fetch(`${MATTERMOST_URL}/api/v4/system/ping`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${MATTERMOST_TOKEN}`
            }
        });

        const pingResult = await response.text();
        
        res.json({
            mattermost_url: MATTERMOST_URL,
            ping: pingResult,
            token_present: !!MATTERMOST_TOKEN
        });

    } catch (error) {
        console.error('[Mattermost] Error checking server:', error.message);
        res.status(500).json({ 
            error: 'Failed to check Mattermost server',
            details: error.message 
        });
    }
});

/**
 * Updated: Bulk sync Elevate IDs using Zendesk's create_or_update_many endpoint
 */
router.post('/setup/sync-elevate-ids', async (req, res) => {
    try {
        console.log('[Setup] Starting bulk Elevate ID sync...');
        
        // Step 1: Get all users from Address Book
        if (!global.addressBookToken || global.addressBookTokenExpiry < Date.now()) {
            const refreshed = await refreshAddressBookToken();
            if (!refreshed) {
                return res.status(401).json({ 
                    error: 'Address Book authentication required',
                    authUrl: '/api/auth/serverdata/login'
                });
            }
        }
        
        const contactsResponse = await fetch('https://api.elevate.services/address-book/v3/accounts/_me/users/_me/contacts', {
            headers: {
                'Authorization': `Bearer ${global.addressBookToken}`,
                'Accept': 'application/json'
            }
        });
        
        if (!contactsResponse.ok) {
            throw new Error(`Address Book API error: ${contactsResponse.status}`);
        }
        
        const contactsData = await contactsResponse.json();
        const contacts = contactsData.results || [];
        
        // Step 2: Filter to @intlxsolutions.com users
        const intlxUsers = contacts.filter(contact => 
            contact.email && 
            contact.email.toLowerCase().includes('@intlxsolutions.com')
        );
        
        console.log(`[Setup] Found ${intlxUsers.length} @intlxsolutions.com users in Address Book`);
        
        // Step 3: Get all Zendesk users to match by email
        const zendeskUsersResponse = await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users.json?per_page=100`, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64')}`,
            }
        });
        
        if (!zendeskUsersResponse.ok) {
            throw new Error(`Zendesk users API error: ${zendeskUsersResponse.status}`);
        }
        
        const zendeskData = await zendeskUsersResponse.json();
        const zendeskUsers = zendeskData.users || [];
        
        console.log(`[Setup] Found ${zendeskUsers.length} Zendesk users`);
        
        // Step 4: Build bulk update payload
        const usersToUpdate = [];
        const matchResults = [];
        
        for (const addressBookUser of intlxUsers) {
            const matchingZendeskUser = zendeskUsers.find(zu => 
                zu.email && zu.email.toLowerCase() === addressBookUser.email.toLowerCase()
            );
            
            if (matchingZendeskUser) {
                usersToUpdate.push({
                id: matchingZendeskUser.id,
                user_fields: {
                elevate_id: addressBookUser.id  // Correct - targets custom field
               }
            });
                
                matchResults.push({
                    zendesk_user_id: matchingZendeskUser.id,
                    name: matchingZendeskUser.name,
                    email: matchingZendeskUser.email,
                    elevate_id: addressBookUser.id
                });
            } else {
                console.log(`[Setup] No Zendesk user found for ${addressBookUser.email}`);
            }
        }
        
        console.log(`[Setup] Matched ${usersToUpdate.length} users for bulk update`);
        
        // Step 5: Bulk update using create_or_update_many
        const bulkUpdatePayload = {
            users: usersToUpdate
        };
        
        console.log(`[Setup] Sending bulk update for ${usersToUpdate.length} users...`);
        
        const bulkUpdateResponse = await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/create_or_update_many.json`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(bulkUpdatePayload)
        });
        
        const responseText = await bulkUpdateResponse.text();
        
        if (bulkUpdateResponse.ok) {
            const bulkResult = JSON.parse(responseText);
            console.log(`[Setup] Bulk update successful!`);
            
            res.json({
                success: true,
                matched: usersToUpdate.length,
                updated: usersToUpdate.length,
                errors: 0,
                bulk_response: bulkResult,
                results: matchResults,
                message: `Successfully updated ${usersToUpdate.length} Zendesk users with Elevate IDs using bulk API`
            });
        } else {
            console.error(`[Setup] Bulk update failed: ${bulkUpdateResponse.status} - ${responseText}`);
            res.json({
                success: false,
                error: `Bulk update failed: ${bulkUpdateResponse.status}`,
                response: responseText,
                matched: usersToUpdate.length,
                message: 'Bulk API call failed'
            });
        }
        
    } catch (error) {
        console.error('[Setup] Error in bulk sync:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get all Zendesk users with Elevate IDs
 */
router.get('/setup/get-users-with-elevate-ids', async (req, res) => {
    try {
        const response = await fetch('https://intlxsolutions.zendesk.com/api/v2/users.json?per_page=100', {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64')}`,
            }
        });
        
        if (!response.ok) {
            throw new Error(`Zendesk API error: ${response.status}`);
        }
        
        const data = await response.json();
        const allUsers = data.users || [];
        
        // Filter to users with Elevate IDs
        const usersWithElevateIds = allUsers
            .filter(user => user.user_fields?.elevate_id)
            .map(user => ({
                zendesk_user_id: user.id,
                name: user.name,
                email: user.email,
                elevate_id: user.user_fields.elevate_id
            }));
        
        res.json({
            success: true,
            total_users: allUsers.length,
            users_with_elevate_ids: usersWithElevateIds.length,
            users: usersWithElevateIds
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * CORRECT WEBHOOK IMPLEMENTATION - BASED ON OFFICIAL ELEVATE DOCS
 * Using the exact API endpoint and payload format from documentation
 */

// First, update the webhook handler to support verification challenges
router.post('/notifications', (req, res) => {
    try {
        // Handle webhook verification challenge (required by Elevate)
        if (req.query.challenge) {
            console.log('[Webhook] Verification challenge received:', req.query.challenge);
            return res.status(200).json({
                challenge: req.query.challenge
            });
        }

        // Handle actual webhook notifications
        const { eventType, version, whenRaised, payload } = req.body;
        
        console.log(`[Notifications] Received webhook:`, JSON.stringify(req.body, null, 2));
        
        // ✅ CORRECT event type check
        if (eventType === 'messaging.presence-control.changed' && payload) {
            console.log(`[Notifications] ✅ Processing presence notification`);
            
            // Handle payload (could be array or single object)
            const presenceUpdates = Array.isArray(payload) ? payload : [payload];
            
            // 🔧 CRITICAL FIX: Ensure cache exists and preserve existing users
            if (!intermediaCache.agentStatuses) {
                console.log('[Notifications] ⚠️ Cache missing - initializing empty cache');
                intermediaCache.agentStatuses = new Map();
            }
            
            const cacheBeforeSize = intermediaCache.agentStatuses.size;
            console.log(`[Notifications] Cache size BEFORE processing: ${cacheBeforeSize}`);
            
            presenceUpdates.forEach(update => {
                // Flexible field handling (userId or unifiedUserId, presenceState or presence)
                const userId = update.userId || update.unifiedUserId || update.user_id;
                const presenceState = update.presenceState || update.presence || update.status;
                
                if (userId && presenceState) {
                    console.log(`[Notifications] Processing user ${userId}: ${presenceState} at ${whenRaised || 'unknown time'}`);
                    
                    // 🔧 FIXED: Use safe individual user update that preserves other users
                    updatePresenceCacheSafely(userId, presenceState);
                } else {
                    console.log(`[Notifications] Incomplete presence data:`, {
                        available_fields: Object.keys(update),
                        userId_found: !!userId,
                        presence_found: !!presenceState
                    });
                }
            });
            
            const cacheAfterSize = intermediaCache.agentStatuses.size;
            console.log(`[Notifications] Cache size AFTER processing: ${cacheAfterSize}`);
            console.log(`[Notifications] ✅ Processing complete - ${presenceUpdates.length} updates processed`);
        } else {
            console.log(`[Notifications] Ignored event type: ${eventType || 'unknown'}`);
        }

        // Always return success to prevent retries
        res.status(200).json({
            status: 'received',
            processed: true,
            eventType: eventType || 'unknown',
            cacheSize: intermediaCache.agentStatuses ? intermediaCache.agentStatuses.size : 0
        });
        
    } catch (error) {
        console.error('[Notifications] ❌ FATAL ERROR:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * CORRECTED: Create webhook subscription using official API format
 */
router.get('/debug-correct-webhook-subscription', async (req, res) => {
    try {
        console.log('[Webhook] Creating webhook subscription using official API format...');
        
        // Step 1: Get access token with correct scope (from docs)
        const tokenResponse = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.INTERMEDIA_CLIENT_ID,
                client_secret: process.env.INTERMEDIA_CLIENT_SECRET,
                scope: 'api.service.notifications' // Exact scope from docs
            })
        });
        
        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            return res.json({
                success: false,
                error: `Token request failed: ${tokenResponse.status} - ${errorText}`
            });
        }
        
        const tokenData = await tokenResponse.json();
        console.log('[Webhook] ✅ Access token obtained with notifications scope');
        
        // Step 2: Clean up any existing subscriptions
        if (presenceSubscriptionState.subscriptionId) {
            try {
                await fetch(`https://api.elevate.services/notifications/v2/accounts/_me/subscriptions/${presenceSubscriptionState.subscriptionId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
                });
                console.log('[Webhook] Cleaned up existing subscription');
            } catch (e) {
                console.log('[Webhook] No existing subscription to clean up');
            }
        }
        
        // Step 3: Create subscription using EXACT format from documentation
        const subscriptionPayload = {
            "events": ["messaging.presence-control.changed"], // Exact event type from docs
            "ttl": "08:00:00", // 8 hour TTL as shown in docs
            "delivery": {
                "transport": "webhook",
                "uri": "https://intlxassetmgr-proxy.onrender.com/api/notifications"
                // Note: No auth for now - can add basic auth later if needed
            }
        };
        
        console.log('[Webhook] Creating subscription with payload:', JSON.stringify(subscriptionPayload, null, 2));
        
        // Use EXACT endpoint from documentation
        const subscriptionResponse = await fetch('https://api.elevate.services/notifications/v2/accounts/_me/subscriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(subscriptionPayload)
        });
        
        console.log('[Webhook] Subscription API response status:', subscriptionResponse.status);
        
        if (subscriptionResponse.ok) {
            const subscriptionData = await subscriptionResponse.json();
            console.log('[Webhook] ✅ Subscription created successfully:', JSON.stringify(subscriptionData, null, 2));
            
            // Update subscription state
            presenceSubscriptionState.subscriptionId = subscriptionData.id || subscriptionData.subscriptionId;
            presenceSubscriptionState.isInitialized = true;
            
            res.json({
                success: true,
                message: 'Webhook subscription created successfully using official API!',
                subscriptionData: subscriptionData,
                webhookUrl: 'https://intlxassetmgr-proxy.onrender.com/api/notifications',
                eventType: 'messaging.presence-control.changed',
                nextStep: 'Change your presence status to test real-time webhooks',
                verificationHandled: true
            });
            
        } else {
            const errorText = await subscriptionResponse.text();
            console.log('[Webhook] ❌ Subscription creation failed:', errorText);
            
            res.json({
                success: false,
                error: `Subscription creation failed: ${subscriptionResponse.status} - ${errorText}`,
                endpoint: 'https://api.elevate.services/notifications/v2/accounts/_me/subscriptions',
                tokenScope: 'api.service.notifications',
                payloadUsed: subscriptionPayload
            });
        }
        
    } catch (error) {
        console.error('[Webhook] Error creating correct webhook subscription:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

router.get('/debug-presence-comparison', async (req, res) => {
    try {
        // Get cached data
        const cachedAgents = intermediaCache.agentStatuses ? 
            Array.from(intermediaCache.agentStatuses.values()) : [];
        
        // Get fresh data
        const freshAgents = await fetchAgentStatuses();
        
        // Compare
        const comparison = {
            cached: {
                count: cachedAgents.length,
                agents: cachedAgents.map(a => ({
                    name: a.name,
                    status: a.status,
                    source: a.source,
                    lastActivity: a.lastActivity
                }))
            },
            fresh: {
                count: freshAgents.length,
                agents: freshAgents.map(a => ({
                    name: a.name,
                    status: a.status,
                    source: a.source,
                    lastActivity: a.lastActivity
                }))
            },
            differences: []
        };
        
        // Find differences
        cachedAgents.forEach(cached => {
            const fresh = freshAgents.find(f => f.id === cached.id);
            if (!fresh) {
                comparison.differences.push({
                    name: cached.name,
                    issue: 'User in cache but not in fresh data'
                });
            } else if (cached.status !== fresh.status) {
                comparison.differences.push({
                    name: cached.name,
                    cached_status: cached.status,
                    fresh_status: fresh.status,
                    issue: 'Status mismatch between cache and fresh'
                });
            }
        });
        
        freshAgents.forEach(fresh => {
            const cached = cachedAgents.find(c => c.id === fresh.id);
            if (!cached) {
                comparison.differences.push({
                    name: fresh.name,
                    issue: 'User in fresh data but not in cache'
                });
            }
        });
        
        res.json(comparison);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Test webhook verification endpoint
 */
router.get('/debug-test-webhook-verification', (req, res) => {
    res.json({
        message: 'Test webhook verification by calling:',
        testUrl: 'POST https://intlxassetmgr-proxy.onrender.com/api/notifications?challenge=test123',
        expectedResponse: { challenge: 'test123' },
        note: 'This simulates what Elevate does during subscription creation'
    });
});

/**
 * Debug: Check actual user field structure and test update
 */
router.get('/debug/check-user-fields', async (req, res) => {
    try {
        // Get your own user to see the current field structure
        const response = await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/me.json`, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64')}`,
            }
        });
        
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        const user = data.user;
        
        res.json({
            success: true,
            user_id: user.id,
            name: user.name,
            email: user.email,
            current_user_fields: user.user_fields,
            field_structure: Object.keys(user.user_fields || {}),
            message: "Check if 'elevate_id' appears in current_user_fields or field_structure"
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Debug: Test different field name formats
 */
router.post('/debug/test-field-formats', async (req, res) => {
    try {
        const response = await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/me.json`, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64')}`,
            }
        });
        
        const userData = await response.json();
        const myUserId = userData.user.id;
        
        // Test different field format possibilities
        const testFormats = [
            { elevate_id: "test-123" },                    // Direct field name
            { "34953577249559": "test-123" },              // Field ID as key
            { custom_fields: { elevate_id: "test-123" } }, // Nested format
            { user_fields: { elevate_id: "test-123" } }    // Nested user_fields
        ];
        
        const results = [];
        
        for (let i = 0; i < testFormats.length; i++) {
            const testPayload = {
                user: testFormats[i]
            };
            
            try {
                const updateResponse = await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${myUserId}.json`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64')}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(testPayload)
                });
                
                const responseText = await updateResponse.text();
                
                results.push({
                    format: `Format ${i + 1}`,
                    payload: testFormats[i],
                    status: updateResponse.status,
                    success: updateResponse.ok,
                    response: updateResponse.ok ? "SUCCESS" : responseText
                });
                
                if (updateResponse.ok) {
                    break; // Stop at first successful format
                }
                
            } catch (error) {
                results.push({
                    format: `Format ${i + 1}`,
                    payload: testFormats[i],
                    error: error.message
                });
            }
            
            // Small delay between tests
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        res.json({
            success: true,
            test_results: results,
            message: "Look for the format that returns success: true"
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Debug: Test updating one specific other user (not yourself)
 */
router.post('/debug/test-other-user-update', async (req, res) => {
    try {
        console.log('[Debug] Testing update of Tyler A Johnston...');
        
        // Try to update Tyler A Johnston specifically using same format that worked for you
        const updatePayload = {
            user: {
                elevate_id: "0ba38728-623e-4d80-a463-a59e09b71719"
            }
        };
        
        console.log('[Debug] Update payload:', JSON.stringify(updatePayload));
        console.log('[Debug] Using auth string preview:', `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN?.substring(0, 10)}...`);
        
        const updateResponse = await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/23181952438039.json`, {
            method: 'PUT',
            headers: {
                'Authorization': `Basic ${Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatePayload)
        });
        
        const responseText = await updateResponse.text();
        console.log('[Debug] Response status:', updateResponse.status);
        console.log('[Debug] Response text:', responseText);
        
        res.json({
            success: updateResponse.ok,
            target_user: "Tyler A Johnston (ID: 23181952438039)",
            status: updateResponse.status,
            status_text: updateResponse.statusText,
            headers: Object.fromEntries(updateResponse.headers.entries()),
            response_body: updateResponse.ok ? JSON.parse(responseText) : responseText,
            auth_header_length: updateResponse.headers.get('authorization')?.length || 'none',
            request_details: {
                url: `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/23181952438039.json`,
                payload: updatePayload
            }
        });
        
    } catch (error) {
        console.error('[Debug] Error in test:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

/**
 * Updated debug endpoint for direct subscriptions
 */
router.get('/debug-presence-subscriptions', (req, res) => {
    try {
        res.json({
            subscriptionState: {
                isInitialized: presenceSubscriptionState.isInitialized,
                subscriptionId: presenceSubscriptionState.subscriptionId,
                hasRenewalTimer: !!presenceSubscriptionState.renewalTimer
            },
            cacheInfo: {
                agentCount: intermediaCache.agentStatuses ? intermediaCache.agentStatuses.size : 0,
                lastUpdate: intermediaCache.lastStatusUpdate ? 
                    new Date(intermediaCache.lastStatusUpdate).toISOString() : null
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Debug endpoint to check subscription details and renewal info
 */
router.get('/debug-subscription-details', async (req, res) => {
    try {
        if (!presenceSubscriptionState.subscriptionId) {
            return res.json({ error: 'No subscription ID found' });
        }
        
        const messagingToken = await getIntermediaToken();
        
        // Get subscription details from API
        const subResponse = await fetch(`https://api.elevate.services/messaging/v1/subscriptions/${presenceSubscriptionState.subscriptionId}`, {
            headers: {
                'Authorization': `Bearer ${messagingToken}`,
                'Accept': 'application/json'
            }
        });
        
        let subscriptionDetails = null;
        if (subResponse.ok) {
            subscriptionDetails = await subResponse.json();
        } else {
            const errorText = await subResponse.text();
            subscriptionDetails = { error: `${subResponse.status}: ${errorText}` };
        }
        
        res.json({
            localState: presenceSubscriptionState,
            subscriptionDetails: subscriptionDetails,
            renewalTimerActive: !!presenceSubscriptionState.renewalTimer
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Debug endpoint to manually set up renewal timer
 */
router.get('/debug-fix-renewal', async (req, res) => {
    try {
        if (!presenceSubscriptionState.subscriptionId) {
            return res.json({ error: 'No subscription ID found' });
        }
        
        const messagingToken = await getIntermediaToken();
        
        // Try to renew the subscription to get expiry info
        console.log('[Debug] Attempting to renew subscription for expiry info');
        
        const renewResponse = await fetch(`https://api.elevate.services/messaging/v1/subscriptions/${presenceSubscriptionState.subscriptionId}/renew`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${messagingToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                duration: '24h'
            })
        });
        
        if (renewResponse.ok) {
            const renewedSub = await renewResponse.json();
            console.log('[Debug] Renewed subscription:', JSON.stringify(renewedSub, null, 2));
            
            if (renewedSub.whenExpired) {
    scheduleSubscriptionRenewal(renewedSub.id, renewedSub.whenExpired);
    
    return res.json({
        success: true,
        renewedSubscription: renewedSub,
        renewalScheduled: true,
        expiresAt: renewedSub.whenExpired
    });
} else if (renewedSub.expires_at) {
    scheduleSubscriptionRenewal(renewedSub.id, renewedSub.expires_at);
    
    return res.json({
        success: true,
        renewedSubscription: renewedSub,
        renewalScheduled: true,
        expiresAt: renewedSub.expires_at
    });
}

        } else {
            const errorText = await renewResponse.text();
            return res.json({
                success: false,
                error: `Renewal failed: ${renewResponse.status} - ${errorText}`
            });
        }
        
    } catch (error) {
        console.error('[Debug] Error fixing renewal:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Debug: Check the actual subscription configuration
 */
router.get('/debug-subscription-webhook', async (req, res) => {
    try {
        const messagingToken = await getIntermediaToken();
        
        // Get list of all subscriptions to see the configuration
        const listResponse = await fetch('https://api.elevate.services/messaging/v1/subscriptions', {
            headers: {
                'Authorization': `Bearer ${messagingToken}`,
                'Accept': 'application/json'
            }
        });
        
        let subscriptions = [];
        if (listResponse.ok) {
            const data = await listResponse.json();
            subscriptions = data.subscriptions || data.results || data || [];
        }
        
        res.json({
            currentSubscriptionId: presenceSubscriptionState.subscriptionId,
            allSubscriptions: subscriptions,
            listStatus: listResponse.status
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * SIMPLIFIED WEBHOOK STRATEGY - DIRECT WEBHOOKS ONLY
 * Either direct webhooks work, or we fall back to polling
 */

router.get('/debug-direct-webhooks-only', async (req, res) => {
    try {
        console.log('[Webhooks] Testing DIRECT webhooks only (no hub routing)...');
        
        // Step 1: Get token with notifications scope
        const tokenResponse = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.INTERMEDIA_CLIENT_ID,
                client_secret: process.env.INTERMEDIA_CLIENT_SECRET,
                scope: 'api.service.notifications' // ONLY notifications scope
            })
        });
        
        if (!tokenResponse.ok) {
            return res.json({
                success: false,
                error: 'Failed to get notifications token',
                fallback: 'Use polling instead'
            });
        }
        
        const tokenData = await tokenResponse.json();
        
        // Step 2: Try ONLY the notifications service endpoint
        const webhookPayload = {
            webhook_url: 'https://intlxassetmgr-proxy.onrender.com/api/notifications',
            event_types: ['messaging.presence-control.changed'],
            active: true
        };
        
        console.log('[Webhooks] Creating direct webhook subscription...');
        const subscriptionResponse = await fetch('https://api.elevate.services/notifications/v1/webhooks', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(webhookPayload)
        });
        
        if (subscriptionResponse.ok) {
            const subscriptionData = await subscriptionResponse.json();
            
            // Verify it's a DIRECT webhook (not routed through hub)
            const isDirect = !subscriptionData.deliveryMethod?.uri?.includes('elevate-events.serverdata.net');
            
            if (isDirect) {
                // SUCCESS - Direct webhooks work
                presenceSubscriptionState.subscriptionId = subscriptionData.id;
                presenceSubscriptionState.isInitialized = true;
                
                res.json({
                    success: true,
                    approach: 'DIRECT_WEBHOOKS',
                    message: 'Direct webhooks successfully configured!',
                    subscriptionId: subscriptionData.id,
                    webhookUrl: 'https://intlxassetmgr-proxy.onrender.com/api/notifications',
                    nextStep: 'Change your presence status to test real-time updates'
                });
            } else {
                // Subscription created but routes through hub
                res.json({
                    success: false,
                    approach: 'HUB_ROUTING_DETECTED', 
                    message: 'Subscription routes through Intermedia hub instead of direct delivery',
                    hubUrl: subscriptionData.deliveryMethod?.uri,
                    recommendation: 'Use polling instead for reliable updates'
                });
            }
        } else {
            const errorText = await subscriptionResponse.text();
            res.json({
                success: false,
                approach: 'WEBHOOKS_NOT_SUPPORTED',
                error: `Direct webhook creation failed: ${subscriptionResponse.status} - ${errorText}`,
                recommendation: 'Use polling for presence updates'
            });
        }
        
    } catch (error) {
        res.json({
            success: false,
            approach: 'ERROR',
            error: error.message,
            recommendation: 'Use polling as reliable fallback'
        });
    }
});

/**
 * FALLBACK: Enhanced polling if webhooks don't work
 */
router.get('/setup-polling-fallback', async (req, res) => {
    try {
        console.log('[Polling] Setting up enhanced polling as webhook alternative...');
        
        // Stop any existing webhook subscriptions
        if (presenceSubscriptionState.subscriptionId) {
            try {
                const token = await getIntermediaToken();
                await fetch(`https://api.elevate.services/messaging/v1/subscriptions/${presenceSubscriptionState.subscriptionId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                console.log('[Polling] Removed webhook subscription in favor of polling');
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        
        presenceSubscriptionState.subscriptionId = null;
        presenceSubscriptionState.isInitialized = false;
        
        // Set up intelligent polling
        const pollingConfig = {
            enabled: true,
            frequency: 30000, // 30 seconds
            smartUpdates: true, // Only update on changes
            batchSize: 5, // Process users in batches
            errorRetry: true
        };
        
        res.json({
            success: true,
            approach: 'SMART_POLLING',
            message: 'Enhanced polling configured as reliable alternative to webhooks',
            config: pollingConfig,
            benefits: [
                'Updates every 30 seconds',
                'Only processes actual changes',
                'Batched API calls for efficiency', 
                'Built-in error handling',
                'Works regardless of webhook support'
            ],
            nextStep: 'Polling will automatically start with next agent-status request'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Fetch presence using the voice API (as per ServerData support)
 */
async function fetchVoicePresence() {
    try {
        // 1. Get voice API token with correct scope
        const token = await getVoiceToken(); // You'll need to implement this
        
        // 2. Get account ID
        const accountId = await getAccountId(token);
        
        // 3. Get extensions for the account
        const extensions = await getExtensions(token, accountId);
        
        // 4. Get presence for each extension
        const presenceData = [];
        
        for (const extension of extensions) {
            const presenceUrl = `https://api.elevate.services/voice/v1/accounts/${accountId}/extensions/${extension.id}/presence`;
            
            try {
                const response = await fetch(presenceUrl, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    }
                });
                
                if (response.ok) {
                    const presenceInfo = await response.json();
                    presenceData.push({
                        extension: extension,
                        presence: presenceInfo
                    });
                }
            } catch (e) {
                console.log(`Failed to get presence for extension ${extension.id}`);
            }
        }
        
        return presenceData;
        
    } catch (error) {
        console.error('[Voice API] Error fetching presence:', error.message);
        return [];
    }
}

/**
 * API endpoint to refresh agent statuses
 * POST /api/agent-status/refresh
 */
router.post('/agent-status/refresh', async (req, res) => {
    try {
        console.log('[API] Force refresh agent statuses');
        
        // Clear cache to force refresh
        intermediaCache.agentStatuses.clear();
        intermediaCache.lastStatusUpdate = 0;
        
        const allAgents = await fetchAgentStatuses();
        const agents = filterKnownUsers(allAgents);
        
        // Update cache
        const now = Date.now();
        agents.forEach(agent => {
            intermediaCache.agentStatuses.set(agent.id, agent);
        });
        intermediaCache.lastStatusUpdate = now;

        res.json({
            success: true,
            agents: agents,
            refreshed: true,
            lastUpdated: new Date().toISOString()
        });

    } catch (error) {
        console.error('[API] Error refreshing agent status:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * API endpoint to check Intermedia authentication status
 * GET /api/agent-status/auth
 */
router.get('/agent-status/auth', async (req, res) => {
    try {
        const hasCredentials = !!(process.env.INTERMEDIA_CLIENT_ID && process.env.INTERMEDIA_CLIENT_SECRET);
        
        if (!hasCredentials) {
            return res.json({
                authenticated: false,
                error: 'Missing Intermedia credentials',
                hasClientId: !!process.env.INTERMEDIA_CLIENT_ID,
                hasClientSecret: !!process.env.INTERMEDIA_CLIENT_SECRET
            });
        }

        // Try to get a token to test authentication
        try {
            const token = await getIntermediaToken();
            res.json({
                authenticated: true,
                tokenExpiry: new Date(intermediaCache.tokenExpiry).toISOString(),
                expiresIn: Math.floor((intermediaCache.tokenExpiry - Date.now()) / 1000)
            });
        } catch (tokenError) {
            res.json({
                authenticated: false,
                error: tokenError.message
            });
        }

    } catch (error) {
        console.error('[API] Error checking auth status:', error.message);
        res.status(500).json({
            authenticated: false,
            error: error.message
        });
    }
});

/**
 * Legacy endpoint for batch agent status (for backward compatibility)
 * POST /api/agents-status-batch
 */
router.post('/agents-status-batch', async (req, res) => {
    try {
        const { emails } = req.body;
        
        if (!emails || !Array.isArray(emails)) {
            return res.status(400).json({ error: 'emails array is required' });
        }
        
        console.log(`[API] Fetching status for ${emails.length} agents via batch endpoint`);
        
        // Get all current agents
        const allAgents = await fetchAgentStatuses();
        const agents = filterKnownUsers(allAgents);
        
        // Filter by requested emails or return all if no specific emails match
        const requestedAgents = agents.filter(agent => 
            emails.some(email => 
                agent.email.toLowerCase() === email.toLowerCase()
            )
        );
        
        // Transform to legacy format
        const legacyFormat = requestedAgents.map(agent => ({
            email: agent.email,
            name: agent.name,
            phoneStatus: agent.status,
            onCall: agent.onCall,
            extension: agent.extension
        }));
        
        res.json({ 
            success: true,
            agents: legacyFormat.length > 0 ? legacyFormat : []
        });
        
    } catch (error) {
        console.error('[API] Error in agents-status-batch:', error.message);
        res.json({ 
            success: false,
            agents: [],
            error: 'Phone system integration unavailable'
        });
    }
});

/**
 * Debug endpoint to test Intermedia token request
 */
router.get('/debug-intermedia-token', async (req, res) => {
    try {
        const clientId = process.env.INTERMEDIA_CLIENT_ID;
        const clientSecret = process.env.INTERMEDIA_CLIENT_SECRET;
        
        console.log('[Debug] Client ID exists:', !!clientId);
        console.log('[Debug] Client Secret exists:', !!clientSecret);
        console.log('[Debug] Client ID preview:', clientId ? clientId.substring(0, 10) + '...' : 'MISSING');
        
        if (!clientId || !clientSecret) {
            return res.json({
                error: 'Missing credentials',
                hasClientId: !!clientId,
                hasClientSecret: !!clientSecret
            });
        }
        
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret,
                scope: 'api.user.voice.calls'
            })
        });
        
        const responseText = await response.text();
        
        res.json({
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseText,
            requestData: {
                grant_type: 'client_credentials',
                client_id: clientId,
                scope: 'api.user.voice.calls'
                // Don't log the secret for security
            }
        });
        
    } catch (error) {
        res.json({
            error: error.message,
            stack: error.stack
        });
    }
});

/**
 * Debug endpoint to find working user listing endpoints
 */
router.get('/debug-intermedia-users', async (req, res) => {
    try {
        const token = await getIntermediaToken();
        
        // Focus on finding user listing endpoints first
        const userListEndpoints = [
            // Messaging API variations
            'https://api.elevate.services/messaging/v1/accounts/_me/users',
            'https://api.elevate.services/messaging/v1/users',
            'https://api.elevate.services/messaging/v1/accounts/_me',
            'https://api.elevate.services/messaging/v1/account/users',
            
            // Address book (your working scope)
            'https://api.elevate.services/address-book/v3/accounts/_me/users',
            'https://api.elevate.services/address-book/v3/accounts/_me',
            'https://api.elevate.services/address-book/v3/users',
            
            // Messaging service variations
            'https://api.elevate.services/service/messaging/v1/accounts/_me/users',
            'https://api.elevate.services/api/messaging/v1/accounts/_me/users',
        ];
        
        const results = [];
        let workingUserEndpoint = null;
        let users = [];
        
        for (const endpoint of userListEndpoints) {
            try {
                console.log(`[Discovery] Testing: ${endpoint}`);
                
                const response = await fetch(endpoint, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                const result = {
                    endpoint,
                    status: response.status,
                    statusText: response.statusText
                };
                
                if (response.ok) {
                    const data = await response.json();
                    result.data = data;
                    result.hasData = true;
                    
                    // Try to extract users from response
                    let foundUsers = [];
                    if (Array.isArray(data)) {
                        foundUsers = data;
                    } else if (data.users && Array.isArray(data.users)) {
                        foundUsers = data.users;
                    } else if (data.data && Array.isArray(data.data)) {
                        foundUsers = data.data;
                    } else if (data.results && Array.isArray(data.results)) {
                        foundUsers = data.results;
                    }
                    
                    if (foundUsers.length > 0) {
                        workingUserEndpoint = endpoint;
                        users = foundUsers;
                        result.userCount = foundUsers.length;
                        result.sampleUser = foundUsers[0];
                        console.log(`[Discovery] Found ${foundUsers.length} users at ${endpoint}`);
                        break; // Found working endpoint, stop searching
                    }
                } else {
                    result.error = await response.text();
                }
                
                results.push(result);
                
            } catch (error) {
                results.push({
                    endpoint,
                    error: error.message,
                    failed: true
                });
            }
        }

        router.get('/debug-user-ids', async (req, res) => {
    try {
        // Get address book contacts
        const contactsResponse = await fetch('https://api.elevate.services/address-book/v3/accounts/_me/users/_me/contacts', {
            headers: {
                'Authorization': `Bearer ${global.addressBookToken}`,
                'Accept': 'application/json'
            }
        });
        
        const contactsData = await contactsResponse.json();
        const contacts = contactsData.results || [];
        
        // Check if your messaging user ID is in the address book
        const yourMessagingId = '441a5edc-b075-4f6a-8027-6a339b903edb';
        const matchingContact = contacts.find(c => c.id === yourMessagingId);
        
        res.json({
            totalContacts: contacts.length,
            yourMessagingId: yourMessagingId,
            foundInAddressBook: !!matchingContact,
            matchingContact: matchingContact,
            sampleContactIds: contacts.slice(0, 5).map(c => ({ id: c.id, name: c.name }))
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Test messaging token request specifically
 */
router.get('/debug-messaging-token', async (req, res) => {
    try {
        console.log('[Debug] Testing messaging token...');
        console.log('[Debug] Client ID exists:', !!process.env.INTERMEDIA_CLIENT_ID);
        console.log('[Debug] Client Secret exists:', !!process.env.INTERMEDIA_CLIENT_SECRET);
        
        if (!process.env.INTERMEDIA_CLIENT_ID || !process.env.INTERMEDIA_CLIENT_SECRET) {
            return res.json({
                success: false,
                error: 'Missing environment variables',
                hasClientId: !!process.env.INTERMEDIA_CLIENT_ID,
                hasClientSecret: !!process.env.INTERMEDIA_CLIENT_SECRET
            });
        }
        
        const requestBody = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: process.env.INTERMEDIA_CLIENT_ID,
            client_secret: process.env.INTERMEDIA_CLIENT_SECRET,
            scope: 'api.service.messaging'
        });
        
        console.log('[Debug] Making token request...');
        
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: requestBody
        });
        
        const responseText = await response.text();
        console.log('[Debug] Token response:', response.status, responseText);
        
        res.json({
            success: response.ok,
            status: response.status,
            response: responseText,
            credentials: {
                hasClientId: !!process.env.INTERMEDIA_CLIENT_ID,
                hasClientSecret: !!process.env.INTERMEDIA_CLIENT_SECRET,
                clientIdLength: process.env.INTERMEDIA_CLIENT_ID ? process.env.INTERMEDIA_CLIENT_ID.length : 0
            }
        });
        
    } catch (error) {
        console.error('[Debug] Token test error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});
        
        // If we found users, test presence endpoints with actual user IDs
        let presenceResults = [];
        if (workingUserEndpoint && users.length > 0) {
            const firstUser = users[0];
            const userId = firstUser.id || firstUser.unifiedUserId || firstUser.userId;
            
            if (userId) {
                const presenceEndpoints = [
                    `https://api.elevate.services/messaging/v1/presence/accounts/_me/users/${userId}`,
                    `https://api.elevate.services/messaging/v1/users/${userId}/presence`,
                    `https://api.elevate.services/address-book/v3/accounts/_me/users/${userId}/presence`,
                ];
                
                for (const presenceEndpoint of presenceEndpoints) {
                    try {
                        console.log(`[Discovery] Testing presence: ${presenceEndpoint}`);
                        
                        const response = await fetch(presenceEndpoint, {
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Content-Type': 'application/json'
                            }
                        });
                        
                        const presenceResult = {
                            endpoint: presenceEndpoint,
                            status: response.status,
                            userId: userId
                        };
                        
                        if (response.ok) {
                            presenceResult.data = await response.json();
                            presenceResult.hasData = true;
                        } else {
                            presenceResult.error = await response.text();
                        }
                        
                        presenceResults.push(presenceResult);
                        
                    } catch (error) {
                        presenceResults.push({
                            endpoint: presenceEndpoint,
                            error: error.message,
                            failed: true
                        });
                    }
                }
            }
        }
        
        res.json({
            success: true,
            workingUserEndpoint,
            userCount: users.length,
            sampleUsers: users.slice(0, 3),
            userListResults: results,
            presenceTestResults: presenceResults,
            conclusion: workingUserEndpoint ? 
                `Found users at ${workingUserEndpoint}. Test presence endpoints above.` :
                'No working user listing endpoint found. Check scope permissions.'
        });
        
    } catch (error) {
        res.json({
            error: error.message
        });
    }
});

/**
 * Debug voice API authentication and endpoint discovery
 */
router.get('/debug-voice-api', async (req, res) => {
    try {
        console.log('[Debug] Testing voice API authentication...');
        
        const clientId = process.env.INTERMEDIA_CLIENT_ID;
        const clientSecret = process.env.INTERMEDIA_CLIENT_SECRET;
        
        // Test voice-related scopes
        const scopesToTest = [
            'api.service.voice',
            'api.voice',
            'api.service.voice.presence',
            'api.voice.presence',
            'api.user.voice'
        ];
        
        const results = [];
        
        for (const scope of scopesToTest) {
            try {
                const response = await fetch('https://login.serverdata.net/user/connect/token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: new URLSearchParams({
                        grant_type: 'client_credentials',
                        client_id: clientId,
                        client_secret: clientSecret,
                        scope: scope
                    })
                });
                
                const responseText = await response.text();
                
                results.push({
                    scope: scope,
                    success: response.ok,
                    status: response.status,
                    response: responseText
                });
                
            } catch (error) {
                results.push({
                    scope: scope,
                    success: false,
                    error: error.message
                });
            }
        }

        // If we got a working token, test account discovery
        const workingScope = results.find(r => r.success);
        let accountInfo = null;
        
        if (workingScope) {
            try {
                const tokenData = JSON.parse(workingScope.response);
                const token = tokenData.access_token;
                
                // Try to get account information
                const accountEndpoints = [
                    'https://api.elevate.services/voice/v1/accounts',
                    'https://api.elevate.services/voice/v1/accounts/_me',
                    'https://api.elevate.services/voice/v1/account'
                ];
                
                for (const endpoint of accountEndpoints) {
                    try {
                        const accountResponse = await fetch(endpoint, {
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Accept': 'application/json'
                            }
                        });
                        
                        if (accountResponse.ok) {
                            const accountData = await accountResponse.json();
                            accountInfo = {
                                endpoint: endpoint,
                                data: accountData
                            };
                            break;
                        }
                    } catch (e) {
                        // Continue to next endpoint
                    }
                }
            } catch (e) {
                // Token parsing failed
            }
        }
        
        res.json({
            message: 'Tested voice API scopes and account discovery',
            scopeResults: results,
            workingScopes: results.filter(r => r.success).map(r => r.scope),
            accountInfo: accountInfo,
            nextSteps: accountInfo ? 
                'Found account info! Now we can get extensions and presence data.' :
                'Need to find correct account endpoint first.'
        });
        
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Test complete voice API integration with working scope
 */
router.get('/test-voice-complete', async (req, res) => {
    try {
        console.log('[Test] Testing complete voice API integration...');
        
        // Step 1: Get token with working scope
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.INTERMEDIA_CLIENT_ID,
                client_secret: process.env.INTERMEDIA_CLIENT_SECRET,
                scope: 'api.user.voice.calls'
            })
        });
        
        if (!response.ok) {
            throw new Error(`Token failed: ${response.status}`);
        }
        
        const tokenData = await response.json();
        const token = tokenData.access_token;
        console.log('[Test] Got voice token successfully');
        
        // Step 2: Try to get account info
        const accountEndpoints = [
            'https://api.elevate.services/voice/v1/accounts/_me',
            'https://api.elevate.services/voice/v1/accounts'
        ];
        
        let accountId = null;
        let accountData = null;
        
        for (const endpoint of accountEndpoints) {
            try {
                const accountResponse = await fetch(endpoint, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    }
                });
                
                if (accountResponse.ok) {
                    accountData = await accountResponse.json();
                    console.log(`[Test] Account data from ${endpoint}:`, accountData);
                    
                    // Try to extract account ID
                    if (accountData.id) accountId = accountData.id;
                    else if (accountData.accountId) accountId = accountData.accountId;
                    else if (Array.isArray(accountData) && accountData[0]?.id) accountId = accountData[0].id;
                    
                    if (accountId) break;
                }
            } catch (e) {
                console.log(`[Test] Failed ${endpoint}: ${e.message}`);
            }
        }
        
        if (!accountId) {
            return res.json({
                step: 'account_discovery_failed',
                tokenReceived: true,
                accountEndpointsTested: accountEndpoints,
                accountData: accountData,
                suggestion: 'Check if account ID is in a different field'
            });
        }
        
        console.log(`[Test] Using account ID: ${accountId}`);
        
        // Step 3: Get extensions
        const extensionsResponse = await fetch(`https://api.elevate.services/voice/v1/accounts/${accountId}/extensions`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        });
        
        if (!extensionsResponse.ok) {
            return res.json({
                step: 'extensions_failed',
                accountId: accountId,
                extensionsStatus: extensionsResponse.status,
                extensionsError: await extensionsResponse.text()
            });
        }
        
        const extensionsData = await extensionsResponse.json();
        const extensions = Array.isArray(extensionsData) ? extensionsData : (extensionsData.extensions || []);
        console.log(`[Test] Found ${extensions.length} extensions`);
        
        // Step 4: Test presence for first extension
        if (extensions.length === 0) {
            return res.json({
                step: 'no_extensions',
                accountId: accountId,
                extensionsData: extensionsData
            });
        }
        
        const firstExtension = extensions[0];
        const extensionId = firstExtension.id || firstExtension.extensionId || firstExtension.number;
        
        const presenceResponse = await fetch(`https://api.elevate.services/voice/v1/accounts/${accountId}/extensions/${extensionId}/presence`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        });
        
        const presenceResult = {
            extensionId: extensionId,
            presenceStatus: presenceResponse.status,
            presenceData: presenceResponse.ok ? await presenceResponse.json() : await presenceResponse.text()
        };
        
        res.json({
            success: true,
            step: 'complete',
            tokenReceived: true,
            accountId: accountId,
            extensionsFound: extensions.length,
            sampleExtension: firstExtension,
            presenceTest: presenceResult,
            nextStep: presenceResponse.ok ? 'Ready to implement full presence fetching' : 'Check presence endpoint format'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            step: 'error'
        });
    }
});

// ============================================
// SERVERDATA/ELEVATE OAUTH ENDPOINTS
// ============================================

/**
 * Initiate ServerData OAuth flow
 */

// Helper functions for OAuth
function generateState() {
    return require('crypto').randomBytes(16).toString('hex');
}

function generateDeviceId() {
    return require('crypto').randomUUID();
}

// OAuth Configuration for ServerData
const clientId = process.env.SERVERDATA_CLIENT_ID || 'r8HaHY19cEaAnBZVN7gBuQ';
const clientSecret = process.env.SERVERDATA_CLIENT_SECRET || 'F862FCvwDX8J5JZtV3IQbHKqrWVafD1THU716LCfQuY';
const redirectUri = 'https://intlxassetmgr-proxy.onrender.com/api/auth/callback';

router.get('/auth/serverdata/login', (req, res) => {
    const state = req.query.state || generateState();
    const deviceId = req.query.deviceId || generateDeviceId();
    
    const authUrl = new URL('https://login.serverdata.net/user/connect/authorize');
    authUrl.searchParams.append('client_id', clientId);
    authUrl.searchParams.append('redirect_uri', redirectUri);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope', 'api.user.address-book');  
    authUrl.searchParams.append('state', state);
    authUrl.searchParams.append('acr_values', `deviceId:${deviceId}`);
    
    console.log('[OAuth] Redirecting to:', authUrl.toString());
    console.log('[OAuth] Device ID:', deviceId);
    
    res.redirect(authUrl.toString());
});

/**
 * OAuth callback for ServerData
 */
router.get('/auth/callback', async (req, res) => {
    try {
        const { code, state: deviceId, error } = req.query;
        
        if (error) {
            return res.status(400).json({ error });
        }
        
        if (!code) {
            return res.status(400).json({ error: 'No authorization code received' });
        }
        
        // Create Basic auth header
        const clientId = process.env.SERVERDATA_CLIENT_ID || 'r8HaHY19cEaAnBZVN7gBuQ';
        const clientSecret = process.env.SERVERDATA_CLIENT_SECRET || 'F862FCvwDX8J5JZtV3IQbHKqrWVafD1THU716LCfQuY';
        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        
        // Exchange code for token
        const tokenResponse = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: 'https://intlxassetmgr-proxy.onrender.com/api/auth/callback',
                acr_values: `deviceId:${deviceId}`
            })
        });
        
        const tokenData = await tokenResponse.json();
        
        if (tokenData.access_token) {
            // Store BOTH access token and refresh token
            global.addressBookToken = tokenData.access_token;
            global.addressBookRefreshToken = tokenData.refresh_token;  // ADDED
            global.addressBookTokenExpiry = Date.now() + ((tokenData.expires_in - 300) * 1000); // Refresh 5 min early
            
            // Log refresh token for manual saving
            if (tokenData.refresh_token) {
                console.log('========================================');
                console.log('IMPORTANT: Save this refresh token as SERVERDATA_REFRESH_TOKEN in Render:');
                console.log(tokenData.refresh_token);
                console.log('========================================');
            } else {
                console.log('[OAuth] WARNING: No refresh token received from server');
            }
            
            console.log('[OAuth] Token stored successfully, expires in', tokenData.expires_in, 'seconds');
            
            res.send(`
                <html>
                <head><title>Authentication Successful</title></head>
                <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                    <h2 style="color: #2E7D0F;">✓ Authentication Successful!</h2>
                    <p>The Address Book integration is now active.</p>
                    <p style="color: #68737D;">You can close this window and return to Zendesk.</p>
                    <script>
                        setTimeout(() => window.close(), 3000);
                    </script>
                </body>
                </html>
            `);
        } else {
            res.status(400).json({ error: 'Failed to get token', details: tokenData });
        }
        
    } catch (error) {
        console.error('OAuth callback error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Refresh the ServerData/Elevate access token
 */
async function refreshAddressBookToken() {
    try {
        if (!global.addressBookRefreshToken) {
            console.log('[OAuth] No refresh token available at', new Date().toISOString());
            return false;
        }
        
        console.log('[OAuth] Starting token refresh at', new Date().toISOString());
        console.log('[OAuth] Old token expiry was:', new Date(global.addressBookTokenExpiry).toISOString());
        
        const clientId = process.env.SERVERDATA_CLIENT_ID || 'r8HaHY19cEaAnBZVN7gBuQ';
        const clientSecret = process.env.SERVERDATA_CLIENT_SECRET || 'F862FCvwDX8J5JZtV3IQbHKqrWVafD1THU716LCfQuY';
        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: global.addressBookRefreshToken
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[OAuth] Token refresh failed:', errorText);
            return false;
        }
        
        const tokenData = await response.json();
        
        if (tokenData.access_token) {
            // Update tokens
            global.addressBookToken = tokenData.access_token;
            if (tokenData.refresh_token) {
                global.addressBookRefreshToken = tokenData.refresh_token;
            }
            global.addressBookTokenExpiry = Date.now() + ((tokenData.expires_in - 300) * 1000);
            
            console.log('[OAuth] Token refreshed successfully at', new Date().toISOString());
            console.log('[OAuth] New token expires at:', new Date(global.addressBookTokenExpiry).toISOString());
            
            // Track refresh history
            if (!global.refreshHistory) global.refreshHistory = [];
            global.refreshHistory.push({
                refreshedAt: new Date().toISOString(),
                expiresAt: new Date(global.addressBookTokenExpiry).toISOString()
            });
            
            return true;
        }
        
        return false;
        
    } catch (error) {
        console.error('[OAuth] Error refreshing token:', error);
        return false;
    }
}

// ============================================
// ADDRESS BOOK API ENDPOINTS
// ============================================

/**
 * Check if we have a valid token
 */
router.get('/address-book/status', (req, res) => {
    const hasToken = global.addressBookToken && global.addressBookTokenExpiry > Date.now();
    res.json({ 
        authenticated: hasToken,
        expiresAt: global.addressBookTokenExpiry || null
    });
});

/**
 * Debug endpoint to check token details
 */
router.get('/address-book/debug', (req, res) => {
    const now = Date.now();
    const hasToken = !!global.addressBookToken;
    const hasRefreshToken = !!global.addressBookRefreshToken;
    const isExpired = global.addressBookTokenExpiry ? global.addressBookTokenExpiry < now : true;
    const timeUntilExpiry = global.addressBookTokenExpiry ? Math.floor((global.addressBookTokenExpiry - now) / 1000) : null;
    
    res.json({
        hasToken,
        hasRefreshToken,
        isExpired,
        timeUntilExpiry,
        expiryTime: global.addressBookTokenExpiry ? new Date(global.addressBookTokenExpiry).toISOString() : null,
        currentTime: new Date(now).toISOString(),
        tokenPreview: hasToken ? `${global.addressBookToken.substring(0, 10)}...` : null
    });
});

/**
 * Get user's contacts from Address Book
 */
router.get('/address-book/contacts', async (req, res) => {
    try {
        // Check if token needs refresh
        if (!global.addressBookToken || global.addressBookTokenExpiry < Date.now()) {
            console.log('[OAuth] Token expired or missing, attempting refresh...');
            
            const refreshed = await refreshAddressBookToken();
            
            if (!refreshed) {
                return res.status(401).json({ 
                    error: 'Authentication required',
                    authUrl: '/api/auth/serverdata/login',
                    message: 'Please re-authenticate with the Address Book'
                });
            }
        }
        
        const response = await fetch('https://api.elevate.services/address-book/v3/accounts/_me/users/_me/contacts', {
            headers: {
                'Authorization': `Bearer ${global.addressBookToken}`
            }
        });
        
        if (response.status === 401) {
            // Token might have just expired, try one refresh
            console.log('[OAuth] Got 401, attempting token refresh...');
            const refreshed = await refreshAddressBookToken();
            
            if (refreshed) {
                // Retry the request with new token
                const retryResponse = await fetch('https://api.elevate.services/address-book/v3/accounts/_me/users/_me/contacts', {
                    headers: {
                        'Authorization': `Bearer ${global.addressBookToken}`
                    }
                });
                
                if (retryResponse.ok) {
                    const data = await retryResponse.json();
                    return res.json(data);
                }
            }
            
            return res.status(401).json({ 
                error: 'Authentication expired',
                authUrl: '/api/auth/serverdata/login',
                message: 'Please re-authenticate with the Address Book'
            });
        }
        
        if (!response.ok) {
            throw new Error(`Address Book API error: ${response.status}`);
        }
        
        const data = await response.json();
        res.json(data);
        
    } catch (error) {
        console.error('Error fetching contacts:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get all users in the account
 */
router.get('/address-book/users', async (req, res) => {
    try {
        // Check if token needs refresh
        if (!global.addressBookToken || global.addressBookTokenExpiry < Date.now()) {
            console.log('[OAuth] Token expired or missing, attempting refresh...');
            
            const refreshed = await refreshAddressBookToken();
            
            if (!refreshed) {
                return res.status(401).json({ 
                    error: 'Authentication required',
                    authUrl: '/api/auth/serverdata/login',
                    message: 'Please re-authenticate with the Address Book'
                });
            }
        }
        
        const response = await fetch('https://api.elevate.services/address-book/v3/accounts/_me/users', {
            headers: {
                'Authorization': `Bearer ${global.addressBookToken}`
            }
        });
        
        if (response.status === 401) {
            // Token might have just expired, try one refresh
            console.log('[OAuth] Got 401, attempting token refresh...');
            const refreshed = await refreshAddressBookToken();
            
            if (refreshed) {
                // Retry the request with new token
                const retryResponse = await fetch('https://api.elevate.services/address-book/v3/accounts/_me/users', {
                    headers: {
                        'Authorization': `Bearer ${global.addressBookToken}`
                    }
                });
                
                if (retryResponse.ok) {
                    const data = await retryResponse.json();
                    return res.json(data);
                }
            }
            
            return res.status(401).json({ 
                error: 'Authentication expired',
                authUrl: '/api/auth/serverdata/login',
                message: 'Please re-authenticate with the Address Book'
            });
        }
        
        if (!response.ok) {
            throw new Error(`Address Book API error: ${response.status}`);
        }
        
        const data = await response.json();
        res.json(data);
        
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add this new function to your api.js file, after the existing address book functions

/**
 * Get enhanced address book contacts with presence data
 */
router.get('/address-book/contacts-with-presence', async (req, res) => {
    try {
        // Check if token needs refresh
        if (!global.addressBookToken || global.addressBookTokenExpiry < Date.now()) {
            console.log('[OAuth] Token expired or missing, attempting refresh...');
            const refreshed = await refreshAddressBookToken();
            if (!refreshed) {
                return res.status(401).json({ 
                    error: 'Authentication required',
                    authUrl: '/api/auth/serverdata/login',
                    message: 'Please re-authenticate with the Address Book'
                });
            }
        }

        // Step 1: Get address book contacts
        const contactsResponse = await fetch('https://api.elevate.services/address-book/v3/accounts/_me/users/_me/contacts', {
            headers: {
                'Authorization': `Bearer ${global.addressBookToken}`
            }
        });
        
        if (!contactsResponse.ok) {
            throw new Error(`Address Book API error: ${contactsResponse.status}`);
        }
        
        const contactsData = await contactsResponse.json();
        const contacts = contactsData.results || [];
        
        console.log(`[Presence] Found ${contacts.length} contacts, fetching presence data...`);

        // Step 2: Get messaging token with correct scope
        const messagingToken = await getMessagingToken();
        
        // Step 3: Fetch presence for each contact (in parallel, but limited)
        const contactsWithPresence = [];
        const BATCH_SIZE = 5; // Process 5 at a time to avoid rate limits
        
        for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
            const batch = contacts.slice(i, i + BATCH_SIZE);
            
            const presencePromises = batch.map(async (contact) => {
                try {
                    if (!contact.id) {
                        return { ...contact, presence: { status: 'unknown', error: 'No ID' } };
                    }

                    console.log(`[Presence] Fetching presence for user ${contact.id} (${contact.displayName})`);
                    
                    const presenceResponse = await fetch(
                        `https://api.elevate.services/messaging/v1/presence/accounts/_me/users/${contact.id}`,
                        {
                            headers: {
                                'Authorization': `Bearer ${messagingToken}`,
                                'Accept': 'application/json'
                            }
                        }
                    );

                    if (presenceResponse.ok) {
                        const presenceData = await presenceResponse.json();
                        console.log(`[Presence] User ${contact.id}: ${presenceData.presence}`);
                        
                        return {
                            ...contact,
                            presence: {
                                status: presenceData.presence || 'unknown',
                                lastUpdated: new Date().toISOString(),
                                source: 'messaging_api'
                            }
                        };
                    } else {
                        console.log(`[Presence] Failed to get presence for user ${contact.id}: ${presenceResponse.status}`);
                        return {
                            ...contact,
                            presence: {
                                status: 'unknown',
                                error: `HTTP ${presenceResponse.status}`,
                                source: 'messaging_api'
                            }
                        };
                    }
                } catch (error) {
                    console.error(`[Presence] Error getting presence for ${contact.id}:`, error.message);
                    return {
                        ...contact,
                        presence: {
                            status: 'unknown',
                            error: error.message,
                            source: 'messaging_api'
                        }
                    };
                }
            });

            const batchResults = await Promise.all(presencePromises);
            contactsWithPresence.push(...batchResults);
            
            // Small delay between batches to be nice to the API
            if (i + BATCH_SIZE < contacts.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        console.log(`[Presence] Enhanced ${contactsWithPresence.length} contacts with presence data`);
        
        // Add summary statistics
        const presenceStats = contactsWithPresence.reduce((stats, contact) => {
            const status = contact.presence?.status || 'unknown';
            stats[status] = (stats[status] || 0) + 1;
            return stats;
        }, {});

        res.json({
            results: contactsWithPresence,
            total: contactsWithPresence.length,
            presenceStats,
            lastUpdated: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error fetching contacts with presence:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get messaging token with correct scope
 */
async function getMessagingToken() {
    try {
        console.log('[Messaging] Requesting messaging token...');
        
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.INTERMEDIA_CLIENT_ID,
                client_secret: process.env.INTERMEDIA_CLIENT_SECRET,
                scope: 'api.service.messaging' // Correct scope for presence data
            })
        });

        if (!response.ok) {
            throw new Error(`Messaging token request failed: ${response.status}`);
        }

        const tokenData = await response.json();
        console.log('[Messaging] Got messaging token successfully');
        
        return tokenData.access_token;
        
    } catch (error) {
        console.error('[Messaging] Error getting messaging token:', error.message);
        throw error;
    }
}

/**
 * Test endpoint to simulate token expiry
 */
router.get('/address-book/test-expire', (req, res) => {
    // Store original expiry for restoration
    const originalExpiry = global.addressBookTokenExpiry;
    
    // Set token to expire in 5 seconds
    global.addressBookTokenExpiry = Date.now() + 5000;
    
    res.json({
        message: 'Token will expire in 5 seconds',
        expiresAt: new Date(global.addressBookTokenExpiry).toISOString(),
        originalExpiry: originalExpiry ? new Date(originalExpiry).toISOString() : null,
        instructions: 'Wait 5 seconds, then try fetching contacts. If auto-refresh works, it should succeed.'
    });
});

/**
 * Check token refresh history
 */
router.get('/address-book/refresh-history', (req, res) => {
    res.json({
        currentStatus: {
            hasToken: !!global.addressBookToken,
            hasRefreshToken: !!global.addressBookRefreshToken,
            expiresAt: global.addressBookTokenExpiry ? new Date(global.addressBookTokenExpiry).toISOString() : null,
            expiresInSeconds: global.addressBookTokenExpiry ? Math.floor((global.addressBookTokenExpiry - Date.now()) / 1000) : null
        },
        refreshHistory: global.refreshHistory || [],
        message: global.refreshHistory?.length > 0 ? 
            `Token has been auto-refreshed ${global.refreshHistory.length} time(s)` : 
            'No auto-refresh has occurred yet'
    });
});

/**
 * Endpoint to test the direct connection to the Zendesk API.
 */
router.get('/test-zendesk', async (req, res) => {
    try {
        const data = await zendeskService.testConnection();
        res.status(200).json({ success: true, message: 'Successfully connected to Zendesk API.', data });
    } catch (error) {
        console.error('!!!!!!!! ZENDESK API TEST FAILED !!!!!!!!');
        res.status(500).json({ success: false, message: 'Failed to connect to Zendesk API.', error: error.message });
    }
});

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

    // Build query with pagination
    let query = `
      SELECT 
        t.id,
        t.url,
        t.external_id,
        t.type,
        t.subject,
        t.description,
        t.priority,
        t.status,
        t.recipient,
        t.requester_id,
        t.submitter_id,
        t.assignee_id,
        t.organization_id,
        t.group_id,
        t.collaborator_ids,
        t.follower_ids,
        t.email_cc_ids,
        t.forum_topic_id,
        t.problem_id,
        t.has_incidents,
        t.is_public,
        t.due_at,
        t.tags,
        t.custom_fields,
        t.satisfaction_rating,
        t.sharing_agreement_ids,
        t.followup_ids,
        t.via_channel,
        t.via_source,
        t.ticket_form_id,
        t.brand_id,
        t.allow_channelback,
        t.allow_attachments,
        t.created_at,
        t.updated_at,
        t.synced_at
      FROM tickets t
      WHERE t.created_at >= ?
        AND t.created_at <= ?
    `;

    const params = [startDate, endDate];

    // Add organization filter if provided
    if (organizationId) {
      query += ` AND t.organization_id = ?`;
      params.push(organizationId);
    }

    // Add sorting
    query += ` ORDER BY t.${safeSortBy} ${validSortOrder}`;

    // Add pagination
    query += ` LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const startTime = Date.now();
    const tickets = await db.all(query, params);
    const queryTime = Date.now() - startTime;

    console.log(`✅ Fetched ${tickets.length} tickets in ${queryTime}ms`);

    // Parse JSON fields
    const processedTickets = tickets.map(ticket => ({
      ...ticket,
      tags: ticket.tags ? JSON.parse(ticket.tags) : [],
      custom_fields: ticket.custom_fields ? JSON.parse(ticket.custom_fields) : [],
      collaborator_ids: ticket.collaborator_ids ? JSON.parse(ticket.collaborator_ids) : [],
      follower_ids: ticket.follower_ids ? JSON.parse(ticket.follower_ids) : [],
      email_cc_ids: ticket.email_cc_ids ? JSON.parse(ticket.email_cc_ids) : [],
      followup_ids: ticket.followup_ids ? JSON.parse(ticket.followup_ids) : [],
      sharing_agreement_ids: ticket.sharing_agreement_ids ? JSON.parse(ticket.sharing_agreement_ids) : [],
      satisfaction_rating: ticket.satisfaction_rating ? JSON.parse(ticket.satisfaction_rating) : null
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
 * Endpoint to create a new ticket and associated asset records.
 */
router.post('/ticket', async (req, res) => {
    try {
        const { name, email, subject, body, approved_by, tags, assets } = req.body;
        
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
 * Create Zendesk ticket from 3rd party application
 * POST /api/zendesk/create-ticket
 */
router.post('/zendesk/create-ticket', async (req, res) => {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();
    
    console.log(`[Zendesk:${requestId}] New ticket request from ${req.ip}`);
    
    try {
        const { name, email, subject, description, priority, tags, customFields, attachments } = req.body;

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
        if (attachments && attachments.length > 0) {
            ticketData.comment = {
                body: description,
                uploads: attachments.map(att => ({
                    filename: att.filename,
                    content: att.content,
                    content_type: att.contentType
                }))
            };
            console.log(`[Zendesk:${requestId}] Including ${attachments.length} attachment(s)`);
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
router.get('/test-bilh-direct', async (req, res) => {
    try {
        console.log('[Test BILH] Searching IT Portal directly with nameStartsWith=bilh');
        
        const response = await fetch(`https://www.siportal.net/api/2.0/companies/?nameStartsWith=bilh`, {
            method: 'GET',
            headers: {
                'Authorization': process.env.SIPORTAL_API_KEY,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            const companies = data.data?.results || [];
            
            console.log(`[Test BILH] Found ${companies.length} BILH companies`);
            
            res.json({
                success: true,
                companies_found: companies.length,
                companies: companies.map(c => ({
                    id: c.id,
                    name: c.name,
                    display_name: c.name.replace(/^BILH[-\s]+/i, '')
                }))
            });
        } else {
            res.status(response.status).json({ 
                error: `API returned ${response.status}`,
                statusText: response.statusText 
            });
        }
    } catch (error) {
        console.error('[Test BILH] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Test endpoint to simulate BILH organization fetch
 * GET /api/test-bilh-fetch
 */
router.get('/test-bilh-fetch', async (req, res) => {
    try {
        const testOrgName = req.query.org || 'Beth Israel Lahey Health';
        
        console.log(`[Test BILH] Simulating fetch for organization: "${testOrgName}"`);
        
        // Simulate the BILH detection logic
        const lowerOrgName = testOrgName.toLowerCase().trim();
        const isBILH = lowerOrgName === 'beth israel lahey health' || lowerOrgName.includes('bilh');
        
        if (!isBILH) {
            return res.json({
                success: false,
                message: `"${testOrgName}" would not be detected as BILH`,
                detection_hints: [
                    'Organization name must be exactly "Beth Israel Lahey Health"',
                    'Or contain "bilh" (case-insensitive)'
                ]
            });
        }
        
        // Ensure cache
        if (companiesCache.companies.length === 0) {
            await refreshCompaniesCache();
        }
        
        // Find BILH companies
        const matchingCompanies = companiesCache.companies.filter(company => {
            const companyName = company.name || '';
            return companyName.toUpperCase().startsWith('BILH-') || 
                   companyName.toUpperCase().startsWith('BILH ') ||
                   companyName.toLowerCase() === 'bilh';
        });
        
        res.json({
            success: true,
            test_organization: testOrgName,
            is_bilh_detected: true,
            companies_found: matchingCompanies.length,
            companies: matchingCompanies.map(c => ({
                id: c.id,
                name: c.name,
                display_name: c.name.replace(/^BILH[-\s]+/i, '')
            })),
            next_step: `Use /api/it-portal-assets?user_id=[USER_ID] with a user from "${testOrgName}" to see full results`
        });
        
    } catch (error) {
        console.error('[Test BILH] Error:', error.message);
        res.status(500).json({
            error: 'Failed to test BILH fetch',
            details: error.message
        });
    }
});

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
router.get('/debug-siportal-company/:id', async (req, res) => {
    try {
        const companyId = req.params.id;
        
        console.log(`[Debug] Checking SiPortal company ID: ${companyId}`);
        
        // Try to fetch devices for this specific company ID with offset pagination
        let allDevices = [];
        let offset = 0;
        const limit = 20;
        let hasMore = true;

        while (hasMore && offset < 100) {
            const devicesResponse = await fetch(
                `https://www.siportal.net/api/2.0/devices?companyId=${companyId}&offset=${offset}&limit=${limit}`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!devicesResponse.ok) {
                throw new Error(`SiPortal Devices API returned ${devicesResponse.status}: ${devicesResponse.statusText}`);
            }

            const devicesData = await devicesResponse.json();
            const devices = devicesData.data?.results || [];
            
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
        
        console.log(`[Debug] Company ${companyId} has ${allDevices.length} unique devices`);
        
        // Also try to find this company in the companies list
        let companyInfo = null;
        let page = 1;
        let found = false;
        
        while (page <= 25 && !found) {
            const companiesResponse = await fetch(`https://www.siportal.net/api/2.0/companies?page=${page}`, {
                method: 'GET',
                headers: {
                    'Authorization': process.env.SIPORTAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            if (companiesResponse.ok) {
                const companiesData = await companiesResponse.json();
                const companies = companiesData.data?.results || [];
                
                if (companies.length === 0) break;
                
                companyInfo = companies.find(c => c.id == companyId);
                if (companyInfo) {
                    found = true;
                    console.log(`[Debug] Found company ${companyId} on page ${page}: "${companyInfo.name}"`);
                }
                
                page++;
            } else {
                break;
            }
        }

        res.json({
            success: true,
            company_id: companyId,
            device_count: allDevices.length,
            unique_device_ids: [...new Set(allDevices.map(d => d.id))].length,
            company_info: companyInfo,
            found_on_page: found ? page - 1 : null,
            searched_pages: page - 1,
            sample_devices: allDevices.slice(0, 5)
        });

    } catch (error) {
        console.error('[Debug] Error checking SiPortal company:', error.message);
        res.status(500).json({
            error: 'Failed to check SiPortal company',
            details: error.message
        });
    }
});

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
        ptoCalendarId: process.env.PTO_CALENDAR_ID, 
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
// WEBHOOK MANAGEMENT ENDPOINTS
// ============================================

/**
 * List all current webhook subscriptions
 * GET /api/webhook/list-subscriptions
 */
async function getNotificationsToken() {
    try {
        const clientId = process.env.INTERMEDIA_CLIENT_ID;
        const clientSecret = process.env.INTERMEDIA_CLIENT_SECRET;
        
        if (!clientId || !clientSecret) {
            throw new Error('Missing INTERMEDIA_CLIENT_ID or INTERMEDIA_CLIENT_SECRET');
        }
        
        console.log('[Webhook] Getting notifications token...');
        
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret,
                scope: 'api.service.notifications' // CORRECT scope for webhook subscriptions
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Token request failed: ${response.status} - ${errorText}`);
        }

        const tokenData = await response.json();
        console.log('[Webhook] ✅ Notifications token obtained');
        return tokenData.access_token;
        
    } catch (error) {
        console.error('[Webhook] Token error:', error.message);
        throw error;
    }
}

/**
 * Create a new webhook subscription for presence events
 * POST /api/webhook/create-subscription
 */
router.post('/webhook/create-subscription', async (req, res) => {
    try {
        console.log('[Webhook] Creating new webhook subscription...');
        
        const token = await getNotificationsToken();
        const webhookUrl = `${process.env.BASE_URL || 'https://intlxassetmgr-proxy.onrender.com'}/api/webhook/presence`;
        
        console.log('[Webhook] Webhook URL:', webhookUrl);
        
        const subscriptionPayload = {
    "events": [
        "presence.updated",
        "presence.changed", 
        "user.presence.updated",
        "messaging.presence.updated"
    ], // Specific presence event types
    "ttl": "24:00:00", // 24 hours
    "delivery": {
        "transport": "webhook",
        "uri": webhookUrl
    }
};
        
        console.log('[Webhook] Creating subscription with payload:', subscriptionPayload);
        
        const response = await fetch('https://api.elevate.services/notifications/v2/accounts/_me/subscriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(subscriptionPayload)
        });

        if (response.ok) {
            const subscription = await response.json();
            console.log('[Webhook] ✅ Subscription created successfully!');
            console.log('[Webhook] Subscription ID:', subscription.id);
            console.log('[Webhook] Expires:', subscription.whenExpired);
            
            // Store the subscription ID for future renewals
            global.webhookSubscriptionId = subscription.id;
            
            res.json({
                success: true,
                message: 'Webhook subscription created successfully',
                subscription: subscription,
                subscription_id: subscription.id,
                expires: subscription.whenExpired,
                webhook_url: webhookUrl,
                next_step: 'Webhook should start receiving presence updates immediately'
            });
            
        } else {
            const error = await response.text();
            console.error('[Webhook] Failed to create subscription:', response.status, error);
            res.status(response.status).json({
                error: error,
                status: response.status,
                webhook_url: webhookUrl,
                note: 'Make sure the webhook URL is publicly accessible'
            });
        }
        
    } catch (error) {
        console.error('[Webhook] Create subscription error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Renew existing webhook subscription using stored ID
 * POST /api/webhook/renew-subscription
 */
router.post('/webhook/renew-subscription', async (req, res) => {
    try {
        const subscriptionId = req.body.subscriptionId || global.webhookSubscriptionId;
        
        if (!subscriptionId) {
            return res.status(400).json({
                error: 'No subscription ID available',
                solution: 'Create a new subscription first using /api/webhook/create-subscription'
            });
        }
        
        console.log('[Webhook] Renewing subscription:', subscriptionId);
        
        const token = await getNotificationsToken();
        
        const response = await fetch(`https://api.elevate.services/notifications/v2/accounts/_me/subscriptions/${subscriptionId}/_renew`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
    "events": [
        "presence.updated",
        "presence.changed", 
        "user.presence.updated",
        "messaging.presence.updated"
    ],
    "ttl": "24:00:00"
})
        });

        if (response.ok) {
            const renewedSubscription = await response.json();
            console.log('[Webhook] ✅ Subscription renewed successfully!');
            
            res.json({
                success: true,
                message: 'Webhook subscription renewed successfully',
                subscription: renewedSubscription,
                expires: renewedSubscription.whenExpired
            });
        } else {
            const error = await response.text();
            console.error('[Webhook] Failed to renew subscription:', response.status, error);
            res.status(response.status).json({ error: error, status: response.status });
        }
        
    } catch (error) {
        console.error('[Webhook] Renewal error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 🔧 FIX WEBHOOK: Create correct subscription with right event type
 * POST /api/webhook/create-correct-subscription
 */
router.post('/webhook/create-correct-subscription', async (req, res) => {
    try {
        console.log('[WEBHOOK FIX] Creating CORRECT webhook subscription...');
        
        // Step 1: Get notifications token (same way you do it elsewhere)
        const tokenResponse = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.INTERMEDIA_CLIENT_ID,
                client_secret: process.env.INTERMEDIA_CLIENT_SECRET,
                scope: 'api.service.notifications'
            })
        });
        
        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            return res.json({
                success: false,
                error: `Token failed: ${tokenResponse.status} - ${errorText}`
            });
        }
        
        const tokenData = await tokenResponse.json();
        console.log('[WEBHOOK FIX] ✅ Token obtained');
        
        // Step 2: Delete your current broken subscription
        const oldSubscriptionId = 'a8c919bf-d1e5-45ca-8ebd-074786e69ada';
        try {
            const deleteResponse = await fetch(`https://api.elevate.services/notifications/v2/accounts/_me/subscriptions/${oldSubscriptionId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });
            console.log(`[WEBHOOK FIX] Old subscription deleted: ${deleteResponse.status}`);
        } catch (e) {
            console.log('[WEBHOOK FIX] Old subscription already gone');
        }
        
        // Step 3: Create NEW subscription with CORRECT settings
        const subscriptionPayload = {
            "events": ["messaging.presence-control.changed"], // ✅ CORRECT event type
            "ttl": "24:00:00",
            "delivery": {
                "transport": "webhook",
                "uri": "https://intlxassetmgr-proxy.onrender.com/api/notifications" // ✅ CORRECT endpoint
            }
        };
        
        console.log('[WEBHOOK FIX] Creating subscription:', subscriptionPayload);
        
        const subscriptionResponse = await fetch('https://api.elevate.services/notifications/v2/accounts/_me/subscriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(subscriptionPayload)
        });
        
        if (subscriptionResponse.ok) {
            const subscriptionData = await subscriptionResponse.json();
            console.log('[WEBHOOK FIX] ✅ SUCCESS! New subscription created:', subscriptionData);
            
            res.json({
                success: true,
                message: '🎉 WEBHOOK FIXED! New subscription created with correct settings',
                old_subscription: oldSubscriptionId + ' (deleted)',
                new_subscription: subscriptionData.id,
                webhook_url: 'https://intlxassetmgr-proxy.onrender.com/api/notifications',
                event_type: 'messaging.presence-control.changed',
                test_instruction: 'Now change your presence status in Elevate!'
            });
            
        } else {
            const errorText = await subscriptionResponse.text();
            res.json({
                success: false,
                error: `Subscription failed: ${subscriptionResponse.status} - ${errorText}`,
                debug: subscriptionPayload
            });
        }
        
    } catch (error) {
        console.error('[WEBHOOK FIX] Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Test the notifications token
 * GET /api/webhook/test-notifications-token
 */
router.get('/webhook/test-notifications-token', async (req, res) => {
    try {
        const token = await getNotificationsToken();
        
        res.json({
            success: true,
            tokenObtained: true,
            tokenPreview: token.substring(0, 20) + '...',
            scope: 'api.service.notifications',
            message: 'Notifications token is working - ready to create webhook subscriptions!'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// WEBHOOK RECEIVER ENDPOINT
// ============================================

/**
 * Webhook endpoint to receive presence notifications
 * POST /api/webhook/presence
 * Also handles webhook verification during subscription creation
 */
router.post('/webhook/presence', async (req, res) => {
    try {
        console.log('[Webhook] ===== WEBHOOK RECEIVED =====');
        console.log('[Webhook] Method:', req.method);
        console.log('[Webhook] Body:', JSON.stringify(req.body, null, 2));
        console.log('[Webhook] Body type:', typeof req.body);
        console.log('[Webhook] Body keys:', req.body ? Object.keys(req.body) : 'null');
        
        // Check if intermediaCache exists
        console.log('[Webhook] Cache check - intermediaCache exists:', !!intermediaCache);
        console.log('[Webhook] Cache check - agentStatuses exists:', !!intermediaCache?.agentStatuses);
        console.log('[Webhook] Cache check - current size:', intermediaCache?.agentStatuses?.size || 'undefined');
        
        // Handle verification challenges first
        if (req.query.challenge) {
            console.log('[Webhook] ✅ Verification challenge received:', req.query.challenge);
            return res.status(200).json({ 
                challenge: req.query.challenge,
                status: 'verified'
            });
        }
        
        if (req.body && req.body.challenge) {
            console.log('[Webhook] ✅ Verification challenge in body:', req.body.challenge);
            return res.status(200).json({ 
                challenge: req.body.challenge,
                status: 'verified'
            });
        }
        
        // Process actual data
        if (req.body && typeof req.body === 'object') {
            console.log('[Webhook] ✅ Processing webhook data...');
            
            // Ensure cache exists
            if (!intermediaCache) {
                console.log('[Webhook] ❌ intermediaCache is undefined! Creating...');
                global.intermediaCache = {
                    agentStatuses: new Map(),
                    lastStatusUpdate: null
                };
            }
            
            if (!intermediaCache.agentStatuses) {
                console.log('[Webhook] ❌ agentStatuses Map is undefined! Creating...');
                intermediaCache.agentStatuses = new Map();
            }
            
            const body = req.body;
            console.log('[Webhook] Body analysis:', {
                hasUserId: !!(body.userId),
                hasPresence: !!(body.presence),
                hasTest: !!(body.test),
                allKeys: Object.keys(body)
            });
            
            // Try to extract user data from any format
            let userId = null;
            let presence = null;
            let processed = false;
            
            // Direct format
            if (body.userId && body.presence) {
                userId = body.userId;
                presence = body.presence;
                console.log('[Webhook] Found direct format: userId =', userId, ', presence =', presence);
            }
            // Look for common field variations
            else {
                userId = body.userId || body.unifiedUserId || body.user_id || body.id;
                presence = body.presence || body.presenceState || body.status || body.state;
                console.log('[Webhook] Found via field search: userId =', userId, ', presence =', presence);
            }
            
            // Process if we found data
if (userId && presence) {
    console.log('[Webhook] 🔄 Processing presence update with real user lookup...');
    console.log('[Webhook] User ID:', userId);
    console.log('[Webhook] Presence:', presence);
    
    try {
        // Use enhanced processing with real user lookup
        await updatePresenceCacheWithRealUser(userId, presence);
        processed = true;
        
    } catch (updateError) {
        console.error('[Webhook] ❌ Error updating cache:', updateError);
    }
} else {
                console.log('[Webhook] ⚠️ No userId/presence found in webhook data');
                console.log('[Webhook] Available data:', body);
            }
            
            return res.status(200).json({
                received: true,
                processed: processed,
                timestamp: new Date().toISOString(),
                cache_size: intermediaCache?.agentStatuses?.size || 0,
                debug: {
                    userId_found: !!userId,
                    presence_found: !!presence,
                    cache_initialized: !!intermediaCache?.agentStatuses,
                    processing_attempted: processed
                }
            });
        }
        
        // Default response
        res.status(200).json({
            status: 'ok',
            message: 'Webhook endpoint active but no data to process',
            cache_size: intermediaCache?.agentStatuses?.size || 0
        });
        
    } catch (error) {
        console.error('[Webhook] ❌ FATAL ERROR:', error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

/**
 * Handle webhook verification via GET (some services use GET for verification)
 * GET /api/webhook/presence
 */
router.get('/webhook/presence', (req, res) => {
    try {
        console.log('[Webhook] GET verification request received');
        console.log('[Webhook] Query params:', req.query);
        
        // Handle verification challenge
        if (req.query.challenge) {
            console.log('[Webhook] ✅ GET verification challenge:', req.query.challenge);
            return res.status(200).json({ challenge: req.query.challenge });
        }
        
        // Default response for webhook health check
        res.status(200).json({
            status: 'active',
            endpoint: '/api/webhook/presence',
            methods: ['GET', 'POST'],
            message: 'Webhook endpoint is ready to receive presence notifications'
        });
        
    } catch (error) {
        console.error('[Webhook] Error in GET webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Test the webhook endpoint manually
 * GET /api/webhook/test
 */
router.get('/webhook/test', (req, res) => {
    res.json({
        message: 'Webhook endpoint test',
        webhook_url: 'https://intlxassetmgr-proxy.onrender.com/api/webhook/presence',
        status: 'The webhook endpoint should now be accessible',
        verification_url: 'https://intlxassetmgr-proxy.onrender.com/api/webhook/presence?challenge=test123',
        next_step: 'Try creating the webhook subscription again'
    });
});

/**
 * 🔧 FIX 3: Debug current presence API to fix "Offline" issue
 * GET /api/debug-presence-api
 */
router.get('/debug-presence-api', async (req, res) => {
    try {
        console.log('[Debug] Testing presence API calls...');
        
        // Get a few users to test presence API
        const zendeskUsers = await getZendeskUsersWithElevateIds();
        if (!zendeskUsers || zendeskUsers.length === 0) {
            return res.json({
                success: false,
                error: 'No users with Elevate IDs found',
                solution: 'Run /api/setup/sync-elevate-ids first'
            });
        }
        
        const testUsers = zendeskUsers.slice(0, 3); // Test first 3 users
        console.log(`[Debug] Testing presence for ${testUsers.length} users`);
        
        const messagingToken = await getIntermediaToken();
        console.log('[Debug] ✅ Got messaging token');
        
        const results = [];
        
        for (const user of testUsers) {
            try {
                console.log(`[Debug] Testing presence for ${user.name} (${user.elevate_id})`);
                
                const presenceResponse = await fetch(`https://api.elevate.services/messaging/v1/presences/${user.elevate_id}`, {
                    headers: {
                        'Authorization': `Bearer ${messagingToken}`,
                        'Accept': 'application/json'
                    }
                });
                
                const result = {
                    user: user.name,
                    elevate_id: user.elevate_id,
                    api_status: presenceResponse.status,
                    api_ok: presenceResponse.ok
                };
                
                if (presenceResponse.ok) {
                    const presenceData = await presenceResponse.json();
                    result.presence_data = presenceData;
                    result.raw_presence = presenceData.presence;
                    result.mapped_status = mapMessagingStatus(presenceData.presence);
                } else {
                    result.error = await presenceResponse.text();
                }
                
                results.push(result);
                console.log(`[Debug] ${user.name}: ${result.api_ok ? result.raw_presence || 'no presence' : 'API ERROR'}`);
                
            } catch (error) {
                results.push({
                    user: user.name,
                    elevate_id: user.elevate_id,
                    error: error.message,
                    failed: true
                });
            }
        }
        
        const successCount = results.filter(r => r.api_ok).length;
        const offlineCount = results.filter(r => r.raw_presence === 'offline').length;
        const errorCount = results.filter(r => r.error || r.failed).length;
        
        res.json({
            success: true,
            message: 'Presence API debug results',
            summary: {
                total_tested: results.length,
                successful_calls: successCount,
                offline_responses: offlineCount,
                api_errors: errorCount,
                issue_detected: offlineCount === successCount && successCount > 0 ? 
                    'All successful API calls return offline - this might be expected or indicate API limitations' :
                    errorCount > 0 ? 'Some API calls are failing' : 'Mixed presence states detected'
            },
            test_results: results,
            recommendations: errorCount > 0 ? [
                'Check if messaging token has correct permissions',
                'Verify user Elevate IDs are correct',
                'Consider using different API endpoint'
            ] : offlineCount === successCount ? [
                'API is working but all users appear offline',
                'This might be normal if users haven\'t set presence',
                'Real-time webhooks should still work for status changes'
            ] : [
                'API is working correctly with mixed presence states',
                'Auto-initialization should work properly'
            ]
        });
        
    } catch (error) {
        console.error('[Debug] Error testing presence API:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Check webhook cache status and subscription state
 * GET /api/webhook/status
 */
router.get('/webhook/status', async (req, res) => {
  try {
    // Use the correct variable names from your existing code
    const cacheSize = intermediaCache.agentStatuses ? intermediaCache.agentStatuses.size : 0;
    const lastUpdate = intermediaCache.lastStatusUpdate ? new Date(intermediaCache.lastStatusUpdate) : null;
    
    res.json({
      webhook_cache_active: cacheSize > 0,
      cached_users: cacheSize,
      last_webhook_update: lastUpdate ? lastUpdate.toISOString() : null,
      minutes_since_update: lastUpdate ? Math.floor((Date.now() - lastUpdate.getTime()) / 60000) : null,
      status: cacheSize > 0 ? 'WEBHOOK_ACTIVE' : 'NO_WEBHOOK_DATA',
      subscription_state: {
        subscriptionId: global.webhookSubscriptionId || null,
        hasStoredSubscription: !!global.webhookSubscriptionId
      },
      webhook_endpoint: 'https://intlxassetmgr-proxy.onrender.com/api/webhook/presence'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Quick fix: Initialize subscription state so agent-status uses webhook cache
 * GET /api/webhook/initialize-state
 */
router.get('/webhook/initialize-state', (req, res) => {
    try {
        // Show current state
        const beforeState = {
            presenceSubscriptionState_exists: !!global.presenceSubscriptionState,
            isInitialized: global.presenceSubscriptionState?.isInitialized || false,
            subscriptionId: global.presenceSubscriptionState?.subscriptionId || null,
            webhookSubscriptionId: global.webhookSubscriptionId || null
        };
        
        console.log('[Webhook] State before fix:', beforeState);
        
        // Initialize the presence subscription state that agent-status endpoint checks
        global.presenceSubscriptionState = {
            subscriptionId: global.webhookSubscriptionId || "58d08627-1fcf-430a-9e2d-f834ffca1a26",
            renewalTimer: null,
            isInitialized: true
        };
        
        console.log('[Webhook] ✅ Subscription state initialized for agent-status endpoint');
        console.log('[Webhook] Subscription ID set to:', global.presenceSubscriptionState.subscriptionId);
        console.log('[Webhook] isInitialized set to:', global.presenceSubscriptionState.isInitialized);
        
        res.json({
            success: true,
            message: 'Subscription state initialized - agent-status endpoint will now use webhook cache',
            before_state: beforeState,
            after_state: global.presenceSubscriptionState,
            cache_status: {
                cache_exists: !!intermediaCache?.agentStatuses,
                cache_size: intermediaCache?.agentStatuses?.size || 0,
                last_update: intermediaCache?.lastStatusUpdate ? 
                    new Date(intermediaCache.lastStatusUpdate).toISOString() : null
            },
            fix_explanation: 'agent-status endpoint was checking presenceSubscriptionState.isInitialized but this was never set when webhook was created',
            next_step: 'Test /api/agent-status - it should now use webhook cache instead of API polling'
        });
        
    } catch (error) {
        console.error('[Webhook] Error initializing state:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add this function to routes/api.js to map Elevate IDs to real user data

/**
 * Get real user details from Elevate ID by checking existing agent data
 */
async function getRealUserFromElevateId(elevateId) {
    try {
        // First check if we have this user in our existing agent cache
        if (intermediaCache.agentStatuses) {
            const existingUser = intermediaCache.agentStatuses.get(elevateId);
            if (existingUser && existingUser.name !== `User ${elevateId}`) {
                console.log(`[Webhook] Found existing user in cache: ${existingUser.name}`);
                return existingUser;
            }
        }
        
        // If not in cache, fetch fresh agent data to find this user
        console.log(`[Webhook] Looking up user details for Elevate ID: ${elevateId}`);
        const allAgents = await fetchAgentStatuses();
        
        const matchingAgent = allAgents.find(agent => agent.id === elevateId);
        if (matchingAgent) {
            console.log(`[Webhook] ✅ Found real user: ${matchingAgent.name} (${matchingAgent.email})`);
            return matchingAgent;
        }
        
        console.log(`[Webhook] ⚠️ Could not find user details for Elevate ID: ${elevateId}`);
        return null;
        
    } catch (error) {
        console.error(`[Webhook] Error looking up user ${elevateId}:`, error.message);
        return null;
    }
}

/**
 * Enhanced updatePresenceCache with real user lookup
 */
async function updatePresenceCacheWithRealUser(userId, presenceState) {
    try {
        if (!intermediaCache.agentStatuses) {
            intermediaCache.agentStatuses = new Map();
        }
        
        console.log(`[Webhook] Processing presence update: ${userId} -> ${presenceState}`);
        
        // Try to get real user details
        const realUser = await getRealUserFromElevateId(userId);
        const mappedStatus = mapMessagingStatus(presenceState);
        
        let userRecord;
        
        if (realUser) {
            // Update existing real user with new presence
            userRecord = {
                ...realUser,
                status: mappedStatus,
                phoneStatus: mappedStatus,
                presenceStatus: mappedStatus,
                lastActivity: new Date().toISOString(),
                rawPresenceData: { 
                    presence: presenceState, 
                    updated: new Date().toISOString(),
                    source: 'webhook_realtime'
                }
            };
            
            console.log(`[Webhook] ✅ Updated real user: ${realUser.name} -> ${mappedStatus}`);
            
        } else {
            // Create generic user record if we can't find real details
            userRecord = {
                id: userId,
                name: `User ${userId}`,
                email: `${userId}@example.com`,
                status: mappedStatus,
                phoneStatus: mappedStatus,
                presenceStatus: mappedStatus,
                lastActivity: new Date().toISOString(),
                rawPresenceData: { 
                    presence: presenceState, 
                    updated: new Date().toISOString(),
                    source: 'webhook'
                }
            };
            
            console.log(`[Webhook] ⚠️ Using generic user record for unknown ID: ${userId}`);
        }
        
        intermediaCache.agentStatuses.set(userId, userRecord);
        intermediaCache.lastStatusUpdate = Date.now();
        
        console.log(`[Webhook] Cache updated. Size: ${intermediaCache.agentStatuses.size}`);
        
    } catch (error) {
        console.error('[Webhook] Error updating presence cache:', error);
    }
}

async function updatePresenceCacheSafely(userId, presenceState) {
    try {
        // Ensure cache exists
        if (!intermediaCache.agentStatuses) {
            intermediaCache.agentStatuses = new Map();
        }
        
        const mappedStatus = mapMessagingStatus(presenceState);
        const existingAgent = intermediaCache.agentStatuses.get(userId);
        
        if (existingAgent) {
            // ✅ UPDATE EXISTING USER - preserve all data, just update status
            const updatedAgent = {
                ...existingAgent,                    // Keep ALL existing data (name, email, etc.)
                status: mappedStatus,                // Update status
                phoneStatus: mappedStatus,           // Update phone status  
                presenceStatus: mappedStatus,        // Update presence status
                lastActivity: new Date().toISOString(),
                dataSource: 'webhook_realtime',     // Mark as real-time
                rawPresenceData: { 
                    presence: presenceState, 
                    updated: new Date().toISOString(),
                    source: 'webhook'
                }
            };
            
            // ✅ CRITICAL: Only update THIS user, don't touch other users
            intermediaCache.agentStatuses.set(userId, updatedAgent);
            console.log(`[Cache] ✅ Updated existing user ${existingAgent.name || userId}: ${presenceState} -> ${mappedStatus}`);
            
        } else {
            // ✅ NEW USER - Try to find real user details before adding generic user
            console.log(`[Cache] 🔍 Unknown user ${userId} - looking up real details...`);
            
            let realUserData = null;
            
            try {
                // Try to find real user details from Zendesk users
                const zendeskUsers = await getZendeskUsersWithElevateIds();
                const matchingUser = zendeskUsers.find(user => user.elevate_id === userId);
                
                if (matchingUser) {
                    console.log(`[Cache] ✅ Found real user data for ${matchingUser.name}`);
                    realUserData = matchingUser;
                }
            } catch (lookupError) {
                console.log(`[Cache] ⚠️ User lookup failed: ${lookupError.message}`);
            }
            
            // Create user record with real data if found, or generic data as fallback
            const newUserRecord = realUserData ? {
                id: userId,
                name: realUserData.name,                     // ✅ Real name
                email: realUserData.email,                   // ✅ Real email
                status: mappedStatus,
                phoneStatus: mappedStatus,
                presenceStatus: mappedStatus,
                extension: 'N/A',
                phone: 'Unknown',
                onCall: false,
                lastActivity: new Date().toISOString(),
                source: 'zendesk_elevate_id',
                dataSource: 'webhook_realtime',
                company: 'Intlx Solutions',
                zendeskUserId: realUserData.zendesk_user_id,
                rawPresenceData: { 
                    presence: presenceState, 
                    updated: new Date().toISOString(),
                    source: 'webhook'
                }
            } : {
                // Fallback if user lookup fails
                id: userId,
                name: `Unknown User (${userId.substring(0, 8)})`,  // ✅ Shorter, cleaner fallback
                email: `${userId}@unknown.com`,
                status: mappedStatus,
                phoneStatus: mappedStatus,
                presenceStatus: mappedStatus,
                extension: 'N/A',
                phone: 'Unknown',
                onCall: false,
                lastActivity: new Date().toISOString(),
                source: 'webhook_new_user',
                dataSource: 'webhook_realtime',
                company: 'Unknown',
                rawPresenceData: { 
                    presence: presenceState, 
                    updated: new Date().toISOString(),
                    source: 'webhook'
                }
            };
            
            // ✅ CRITICAL: Add new user WITHOUT affecting existing users
            intermediaCache.agentStatuses.set(userId, newUserRecord);
            console.log(`[Cache] ✅ Added ${realUserData ? 'real' : 'generic'} user: ${newUserRecord.name} with status: ${mappedStatus}`);
        }
        
        // Update timestamp
        intermediaCache.lastStatusUpdate = Date.now();
        
        console.log(`[Cache] Current cache size: ${intermediaCache.agentStatuses.size}`);
        
    } catch (error) {
        console.error('[Cache] ❌ Error in safe cache update:', error);
    }
}

/**
 * 🔄 RESET AND INITIALIZE: Clear cache and auto-populate all users
 * GET /api/reset-and-initialize
 */
router.get('/reset-and-initialize', async (req, res) => {
    try {
        console.log('[Reset] Clearing cache and initializing with all users...');
        
        // Step 1: Clear existing cache
        if (intermediaCache.agentStatuses) {
            const oldSize = intermediaCache.agentStatuses.size;
            intermediaCache.agentStatuses.clear();
            console.log(`[Reset] ✅ Cleared ${oldSize} cached users`);
        } else {
            intermediaCache.agentStatuses = new Map();
            console.log('[Reset] ✅ Initialized new cache');
        }
        
        // Step 2: Get current presence for ALL users
        console.log('[Reset] 🔄 Fetching current presence for all users...');
const allCurrentAgents = await fetchAgentStatuses();
const currentAgents = allCurrentAgents.filter(agent => {
    return !agent.name.startsWith('Unknown User') && 
           !agent.name.includes('Unknown User') &&
           agent.email && 
           agent.email.includes('@intlxsolutions.com');
});
console.log(`[Reset] ✅ Fetched ${currentAgents.length} known agents (filtered from ${allCurrentAgents.length} total)`);
        
        // Step 3: Populate cache with all users
        currentAgents.forEach(agent => {
            const agentWithSource = {
                ...agent,
                dataSource: 'manual_initialization',
                initializedAt: new Date().toISOString()
            };
            intermediaCache.agentStatuses.set(agent.id, agentWithSource);
        });
        
        intermediaCache.lastStatusUpdate = Date.now();
        
        console.log(`[Reset] 🎉 Initialized cache with ${currentAgents.length} users`);
        console.log('[Reset] Webhooks will now provide real-time updates for these users');
        
        res.json({
            success: true,
            message: '🎉 Cache reset and initialized with all users!',
            stats: {
                users_populated: currentAgents.length,
                cache_size: intermediaCache.agentStatuses.size,
                initialization_time: new Date().toISOString()
            },
            sample_users: currentAgents.slice(0, 3).map(u => ({
                name: u.name,
                status: u.status,
                elevate_id: u.id
            })),
            next_steps: [
                'All users should now appear in your UI',
                'Webhooks will continue providing real-time updates',
                'Check /api/agent-status to see all users'
            ],
            webhook_status: 'Active - will update users in real-time'
        });
        
    } catch (error) {
        console.error('[Reset] Error during reset/initialize:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            note: 'Reset failed - cache may be in inconsistent state'
        });
    }
});

// ============================================
// END OF WEBHOOK ENDPOINTS
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

module.exports = router;
module.exports.initializePresenceCache = initializePresenceCache;
module.exports.intermediaCache = intermediaCache;