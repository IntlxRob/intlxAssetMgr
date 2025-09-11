// routes/api.js
// This file defines all the API endpoints and calls the appropriate service functions.

const express = require('express');
const router = express.Router();
const zendeskService = require('../services/zendesk');
const googleSheetsService = require('../services/googleSheets');
const { google } = require('googleapis');
const calendar = google.calendar('v3');

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

const AGENT_STATUS_CACHE_DURATION = 30000; // 30 seconds
const TOKEN_REFRESH_BUFFER = 300000; // 5 minutes before expiry

/**
 * Get or refresh Intermedia access token
 */
async function getIntermediaToken() {
    // Check if we have a valid token
    if (intermediaCache.token && Date.now() < intermediaCache.tokenExpiry - TOKEN_REFRESH_BUFFER) {
        console.log('[Intermedia] Using cached token');
        return intermediaCache.token;
    }

    console.log('[Intermedia] Requesting new access token');
    
    try {
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.INTERMEDIA_CLIENT_ID,
                client_secret: process.env.INTERMEDIA_CLIENT_SECRET,
                scope: 'api.service.messaging' // Using calling scope for voice/presence data
            })
        });

        if (!response.ok) {
            throw new Error(`Token request failed: ${response.status} ${response.statusText}`);
        }

        const tokenData = await response.json();
        
        if (!tokenData.access_token) {
            throw new Error('No access token in response');
        }

        // Cache the token
        intermediaCache.token = tokenData.access_token;
        intermediaCache.tokenExpiry = Date.now() + (tokenData.expires_in * 1000);
        
        console.log('[Intermedia] Token obtained successfully, expires in', tokenData.expires_in, 'seconds');
        return intermediaCache.token;
        
    } catch (error) {
        console.error('[Intermedia] Token request failed:', error.message);
        throw error;
    }
}

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
    try {
        console.log('[Presence] Requesting messaging token with presence scope...');
        
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.INTERMEDIA_CLIENT_ID,
                client_secret: process.env.INTERMEDIA_CLIENT_SECRET,
                scope: 'api.service.messaging api.service.messaging.presences' // Enhanced scope for presence
            })
        });

        if (!response.ok) {
            throw new Error(`Presence token request failed: ${response.status}`);
        }

        const tokenData = await response.json();
        console.log('[Presence] Got messaging token with presence scope successfully');
        
        return tokenData.access_token;
        
    } catch (error) {
        console.error('[Presence] Error getting messaging token:', error.message);
        throw error;
    }
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
                    status: normalizePresenceStatus(presence.presence || presence.status),
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
 * Normalize presence status to standard values
 */
function normalizePresenceStatus(status) {
    if (!status) return 'unknown';
    
    const normalized = status.toLowerCase().trim();
    
    // Map API values to standard statuses
    switch (normalized) {
        case 'available':
        case 'online':
        case 'active':
        case 'ready':
            return 'available';
            
        case 'busy':
        case 'dnd':
        case 'do not disturb':
        case 'occupied':
        case 'in_meeting':
        case 'meeting':
            return 'busy';
            
        case 'away':
        case 'idle':
        case 'absent':
        case 'temporarily_away':
            return 'away';
            
        case 'offline':
        case 'invisible':
        case 'disconnected':
            return 'offline';
            
        default:
            return 'unknown';
    }
}

/**
 * Updated API endpoint with enhanced presence integration
 */
router.get('/address-book/contacts-with-presence', async (req, res) => {
    try {
        console.log('[API] Enhanced presence request received');
        
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
                    status: normalizePresenceStatus(presence.presence || presence.status),
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

        res.json({
            results: contactsWithPresence,
            total: contactsWithPresence.length,
            presenceStats,
            lastUpdated: new Date().toISOString(),
            apiEndpointsUsed: {
                addressBook: 'https://api.elevate.services/address-book/v3/accounts/_me/users/_me/contacts',
                presence: 'Multiple messaging API endpoints (see logs)'
            }
        });
        
    } catch (error) {
        console.error('[API] Error in enhanced presence endpoint:', error.message);
        
        if (error.message.includes('authentication required')) {
            res.status(401).json({ 
                error: 'Authentication required',
                authUrl: '/api/auth/serverdata/login',
                message: 'Please re-authenticate with the Address Book'
            });
        } else {
            res.status(500).json({ 
                error: error.message,
                fallback: 'Trying basic contacts without presence...'
            });
        }
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

//
/**
 * Get Intermedia calling token for phone status
 */
async function getCallingToken() {
    try {
        console.log('[Calling API] Requesting calling access token');
        
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.INTERMEDIA_CLIENT_ID,
                client_secret: process.env.INTERMEDIA_CLIENT_SECRET,
                scope: 'api.user.voice.calls' // Different scope for phone status
            })
        });

        if (!response.ok) {
            throw new Error(`Calling token request failed: ${response.status}`);
        }

        const tokenData = await response.json();
        console.log('[Calling API] Token obtained successfully');
        
        return tokenData.access_token;
        
    } catch (error) {
        console.error('[Calling API] Token request failed:', error.message);
        throw error;
    }
}

/**
 * Fetch agent statuses from both Messaging and Calling APIs
 */
async function fetchAgentStatuses() {
    try {
        console.log('[Agent Status] Fetching from both messaging and calling APIs');

        // Get tokens for both APIs
        const messagingToken = await getIntermediaToken();
        const callingToken = await getCallingToken();

        // Fetch users from address book first
        const userEndpoints = [
            'https://api.elevate.services/address-book/v3/accounts/_me/users',
            'https://api.elevate.services/messaging/v1/accounts/_me/users'
        ];

        let users = [];
        for (const endpoint of userEndpoints) {
            try {
                const response = await fetch(endpoint, {
                    headers: {
                        'Authorization': `Bearer ${messagingToken}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    if (Array.isArray(data)) {
                        users = data;
                    } else if (data.users) {
                        users = data.users;
                    } else if (data.results) {
                        users = data.results;
                    }
                    
                    if (users.length > 0) break;
                }
            } catch (err) {
                console.log(`[Agent Status] ${endpoint} failed:`, err.message);
            }
        }

        if (users.length === 0) {
            console.log('[Agent Status] All messaging endpoints failed, returning empty array');
            return [];
        }

        console.log(`[Agent Status] Found ${users.length} users, fetching presence data`);
        const agents = [];

        // Process each user (limit to avoid rate limits)
        for (const user of users.slice(0, 10)) {
            try {
                const userId = user.id || user.unifiedUserId || user.userId;
                if (!userId) continue;

                // Get messaging presence
                let messagingPresence = null;
                try {
                    const msgResponse = await fetch(
                        `https://api.elevate.services/messaging/v1/presence/accounts/_me/users/${userId}`,
                        {
                            headers: {
                                'Authorization': `Bearer ${messagingToken}`,
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                    if (msgResponse.ok) {
                        messagingPresence = await msgResponse.json();
                    }
                } catch (msgErr) {
                    console.log(`[Agent Status] Messaging presence failed for user ${userId}`);
                }

                // Get calling/phone status
                let phoneStatus = null;
                try {
                    const callResponse = await fetch(
                        `https://api.elevate.services/calling/v1/accounts/_me/users/${userId}/presence`,
                        {
                            headers: {
                                'Authorization': `Bearer ${callingToken}`,
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                    if (callResponse.ok) {
                        phoneStatus = await callResponse.json();
                    }
                } catch (callErr) {
                    console.log(`[Agent Status] Phone status failed for user ${userId}`);
                }

                // Combine the data
                agents.push({
                    id: userId,
                    name: user.displayName || user.name || `User ${userId}`,
                    email: user.email || `user${userId}@company.com`,
                    extension: user.extension || phoneStatus?.extension || 'N/A',
                    // Phone status from calling API
                    phoneStatus: mapPhoneStatus(phoneStatus?.status),
                    onCall: phoneStatus?.onCall || phoneStatus?.inCall || false,
                    // Messaging presence from messaging API
                    presenceStatus: mapMessagingStatus(messagingPresence?.presence),
                    lastActivity: phoneStatus?.lastActivity || messagingPresence?.lastActivity || new Date().toISOString(),
                    rawPhoneData: phoneStatus,
                    rawPresenceData: messagingPresence
                });

            } catch (userError) {
                console.log(`[Agent Status] Error processing user:`, userError.message);
            }
        }

        console.log(`[Agent Status] Successfully processed ${agents.length} agents with combined data`);
        return agents.length > 0 ? agents : getMockAgentStatuses();

    } catch (error) {
        console.error('[Agent Status] Error fetching combined status:', error.message);
        return [];
    }
}

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

/**
 * Map messaging API status to our standard statuses
 */
function mapMessagingStatus(status) {
    if (!status) return 'unknown';
    
    const lowerStatus = status.toLowerCase();
    
    switch (lowerStatus) {
        case 'available':
        case 'online':
        case 'active':
            return 'available';
        case 'busy':
        case 'occupied':
        case 'dnd':
        case 'do not disturb':
            return 'busy';
        case 'away':
        case 'idle':
        case 'absent':
            return 'away';
        case 'offline':
        case 'invisible':
            return 'offline';
        default:
            return 'unknown';
    }
}

/**
 * Map calling API status to phone statuses
 */
function mapPhoneStatus(status) {
    if (!status) return 'unknown';
    
    const lowerStatus = status.toLowerCase();
    
    switch (lowerStatus) {
        case 'available':
        case 'ready':
            return 'available';
        case 'busy':
        case 'on call':
        case 'in call':
            return 'busy';
        case 'away':
        case 'break':
            return 'away';
        case 'offline':
        case 'unavailable':
            return 'offline';
        default:
            return 'unknown';
    }
}

/**
 * API endpoint to get current agent statuses
 * GET /api/agent-status
 */
router.get('/agent-status', async (req, res) => {
    try {
        console.log('[API] Agent status requested');
        
        // Check cache first
        const now = Date.now();
        if (intermediaCache.agentStatuses.size > 0 && 
            now - intermediaCache.lastStatusUpdate < AGENT_STATUS_CACHE_DURATION) {
            console.log('[API] Returning cached agent statuses');
            const cachedStatuses = Array.from(intermediaCache.agentStatuses.values());
            return res.json({
                success: true,
                agents: cachedStatuses,
                cached: true,
                lastUpdated: new Date(intermediaCache.lastStatusUpdate).toISOString()
            });
        }

        // Fetch fresh data
        const agents = await fetchAgentStatuses();
        
        // Update cache
        intermediaCache.agentStatuses.clear();
        agents.forEach(agent => {
            intermediaCache.agentStatuses.set(agent.id, agent);
        });
        intermediaCache.lastStatusUpdate = now;

        console.log(`[API] Returning ${agents.length} agent statuses`);
        
        res.json({
            success: true,
            agents: agents,
            cached: false,
            lastUpdated: new Date().toISOString()
        });

    } catch (error) {
        console.error('[API] Error fetching agent status:', error.message);
        
        // Return mock data on error
        const mockAgents = getMockAgentStatuses();
        res.status(500).json({
        success: false,
        error: error.message,
        agents: [], // Empty array instead of mock data
        lastUpdated: new Date().toISOString()
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
        
        const agents = await fetchAgentStatuses();
        
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
        const agents = await fetchAgentStatuses();
        
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

// ============================================
// VOICE API PRESENCE FUNCTIONS (NEW)
// ============================================

/**
 * Get voice API token with correct scope
 */
async function getVoiceToken() {
    try {
        console.log('[Voice API] Requesting voice API token...');
        
        const response = await fetch('https://login.serverdata.net/user/connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.INTERMEDIA_CLIENT_ID,
                client_secret: process.env.INTERMEDIA_CLIENT_SECRET,
                scope: 'api.user.voice.calls' // Use the working scope from your debug test
            })
        });

        if (!response.ok) {
            throw new Error(`Voice token request failed: ${response.status}`);
        }

        const tokenData = await response.json();
        console.log('[Voice API] Got voice token successfully');
        
        return tokenData.access_token;
        
    } catch (error) {
        console.error('[Voice API] Error getting voice token:', error.message);
        throw error;
    }
}

/**
 * Get account ID for voice API calls
 */
async function getAccountId(token) {
    const accountEndpoints = [
        'https://api.elevate.services/voice/v1/accounts/_me',
        'https://api.elevate.services/voice/v1/accounts',
        'https://api.elevate.services/voice/v1/account'
    ];
    
    for (const endpoint of accountEndpoints) {
        try {
            const response = await fetch(endpoint, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                // Extract account ID from different possible response formats
                if (data.id) return data.id;
                if (data.accountId) return data.accountId;
                if (Array.isArray(data) && data[0]?.id) return data[0].id;
                
                console.log('[Voice API] Account data:', data);
            }
        } catch (error) {
            console.log(`[Voice API] Failed to get account from ${endpoint}`);
        }
    }
    
    throw new Error('Could not determine account ID');
}

/**
 * Get extensions for the account
 */
async function getExtensions(token, accountId) {
    try {
        const response = await fetch(`https://api.elevate.services/voice/v1/accounts/${accountId}/extensions`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            return Array.isArray(data) ? data : (data.extensions || []);
        }
        
        throw new Error(`Extensions API returned ${response.status}`);
        
    } catch (error) {
        console.error('[Voice API] Error fetching extensions:', error.message);
        return [];
    }
}

/**
 * Fetch presence using the voice API (as per ServerData support)
 */
async function fetchVoicePresence() {
    try {
        console.log('[Voice API] Starting voice presence fetch...');
        
        // 1. Get voice API token with correct scope
        const token = await getVoiceToken();
        
        // 2. Get account ID
        const accountId = await getAccountId(token);
        console.log('[Voice API] Using account ID:', accountId);
        
        // 3. Get extensions for the account
        const extensions = await getExtensions(token, accountId);
        console.log('[Voice API] Found', extensions.length, 'extensions');
        
        // 4. Get presence for each extension
        const presenceData = [];
        
        for (const extension of extensions) {
            const extensionId = extension.id || extension.extensionId || extension.number;
            const presenceUrl = `https://api.elevate.services/voice/v1/accounts/${accountId}/extensions/${extensionId}/presence`;
            
            try {
                console.log(`[Voice API] Getting presence for extension ${extensionId}`);
                
                const response = await fetch(presenceUrl, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    }
                });
                
                if (response.ok) {
                    const presenceInfo = await response.json();
                    console.log(`[Voice API] Presence for ${extensionId}:`, presenceInfo);
                    
                    presenceData.push({
                        extension: extension,
                        presence: presenceInfo,
                        status: presenceInfo.status || 'unknown',
                        onCall: presenceInfo.onCall || presenceInfo.inCall || false
                    });
                } else {
                    console.log(`[Voice API] Failed to get presence for extension ${extensionId}: ${response.status}`);
                }
            } catch (e) {
                console.log(`[Voice API] Error getting presence for extension ${extensionId}:`, e.message);
            }
        }
        
        console.log(`[Voice API] Retrieved presence for ${presenceData.length} extensions`);
        return presenceData;
        
    } catch (error) {
        console.error('[Voice API] Error fetching voice presence:', error.message);
        return [];
    }
}

// ============================================
// END OF AGENT STATUS IMPLEMENTATION
// ============================================

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
                const devicesResponse = await fetch(`https://www.siportal.net/api/2.0/devices?companyId=${company.id}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                });

                if (!devicesResponse.ok) {
                    console.log(`[API] Failed to fetch devices for company ${company.id}: ${devicesResponse.status}`);
                    return { company, devices: [] };
                }

                const siPortalData = await devicesResponse.json();
                const devices = siPortalData.data?.results || [];
                
                console.log(`[API] Found ${devices.length} devices for ${company.name}`);
                
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

module.exports = router;