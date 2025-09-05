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
        while (page <= 50) { // Safety limit of 50 pages
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

/**
 * Endpoint to manually refresh companies cache
 */
router.get('/refresh-companies-cache', async (req, res) => {
    await refreshCompaniesCache();
    res.json({
        success: true,
        companies_count: companiesCache.companies.length,
        last_updated: companiesCache.lastUpdated
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
 * FIXED: Now uses offset/limit pagination instead of page parameter for devices
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

        // Step 1: Try known company mappings first (instant lookup)
        console.log(`[API] Searching SiPortal for organization: "${orgName}"`);
        
        const lowerOrgName = orgName.toLowerCase().trim();
        const knownMappings = {
            // Exact mappings
            'keep me home, llc': 3632,
            'keep me home,llc': 3632,
            'intlx solutions, llc': 3492,
            
            // Name variation mappings (Zendesk name -> SiPortal company ID)
            'starling physicians mso, llc': 4133,
            'rockland trust company': null, // Set to null to search by name variations
            
            // Common patterns
            'university of massachusetts': null,
            'mass general brigham': null,
        };

        let matchingCompany = null;
        
        if (knownMappings[lowerOrgName]) {
            console.log(`[API] Using known mapping for "${orgName}" -> Company ID ${knownMappings[lowerOrgName]}`);
            matchingCompany = {
                id: knownMappings[lowerOrgName],
                name: orgName
            };
        } else {
            // Step 2: Check if cache needs refresh (refresh every 6 hours)
            const cacheAge = companiesCache.lastUpdated ? 
                (Date.now() - companiesCache.lastUpdated.getTime()) : 
                Infinity;
            const CACHE_MAX_AGE = 6 * 60 * 60 * 1000; // 6 hours
            
            if (cacheAge > CACHE_MAX_AGE && !companiesCache.isUpdating) {
                console.log('[API] Cache is stale, refreshing in background...');
                // Don't await - refresh in background
                refreshCompaniesCache().catch(err => 
                    console.error('[API] Background cache refresh failed:', err.message)
                );
            }
            
            // Step 3: Search in cache if available
            if (companiesCache.companies.length > 0) {
                console.log(`[API] Searching in cache (${companiesCache.companies.length} companies)`);
                const cacheResult = searchCompaniesInCache(orgName);
                
                if (cacheResult) {
                    matchingCompany = cacheResult.company;
                    console.log(`[API] Cache match found: "${matchingCompany.name}" (ID: ${matchingCompany.id}, Score: ${cacheResult.score}, Method: ${cacheResult.method})`);
                }
            } else {
                // Step 4: Fallback to single page search if no cache
                console.log(`[API] No cache available, performing single page search`);
                
                const companiesResponse = await fetch(`https://www.siportal.net/api/2.0/companies?page=1`, {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                });

                if (companiesResponse.ok) {
                    const companiesData = await companiesResponse.json();
                    const companies = companiesData.data?.results || [];
                    
                    // Look for exact matches only in first page
                    for (const company of companies) {
                        const companyName = company.name?.toLowerCase().trim();
                        if (!companyName) continue;

                        if (companyName === lowerOrgName) {
                            matchingCompany = company;
                            console.log(`[API] Exact match found: "${company.name}" (ID: ${company.id})`);
                            break;
                        }
                    }
                }
                
                // Start cache refresh for next time
                if (!companiesCache.isUpdating) {
                    refreshCompaniesCache().catch(err => 
                        console.error('[API] Cache refresh failed:', err.message)
                    );
                }
            }

            if (!matchingCompany) {
                console.log(`[API] No match found in cache for "${orgName}", trying direct search with offset pagination`);
                
                // Try direct search by company name as fallback
                try {
                    let allDevices = [];
                    let offset = 0;
                    const limit = 20;
                    let hasMore = true;
                    
                    while (hasMore && offset < 200) { // Safety limit
                        const directResponse = await fetch(
                            `https://www.siportal.net/api/2.0/devices?company=${encodeURIComponent(orgName)}&offset=${offset}&limit=${limit}`, 
                            {
                                method: 'GET',
                                headers: {
                                    'Authorization': process.env.SIPORTAL_API_KEY,
                                    'Content-Type': 'application/json'
                                }
                            }
                        );
                        
                        if (directResponse.ok) {
                            const directData = await directResponse.json();
                            const devices = directData.data?.results || [];
                            
                            console.log(`[API] Direct search offset ${offset}: Found ${devices.length} devices`);
                            
                            if (devices.length > 0) {
                                // Extract company info from the first device (only once)
                                if (offset === 0) {
                                    const companyInfo = devices[0].company;
                                    if (companyInfo && companyInfo.id) {
                                        matchingCompany = companyInfo;
                                        console.log(`[API] Direct search found company: "${companyInfo.name}" (ID: ${companyInfo.id})`);
                                    }
                                }
                                
                                // Check for duplicates
                                const existingIds = new Set(allDevices.map(d => d.id));
                                const newDevices = devices.filter(d => !existingIds.has(d.id));
                                
                                if (newDevices.length === 0) {
                                    console.log(`[API] All devices at offset ${offset} are duplicates, stopping`);
                                    hasMore = false;
                                } else {
                                    allDevices.push(...newDevices);
                                    hasMore = devices.length === limit;
                                    offset += limit;
                                }
                            } else {
                                hasMore = false;
                            }
                        } else {
                            console.log(`[API] Direct search failed at offset ${offset}: ${directResponse.status}`);
                            hasMore = false;
                        }
                    }
                    
                    if (allDevices.length > 0 && matchingCompany) {
                        console.log(`[API] Direct search complete: Found ${allDevices.length} unique devices`);
                        
                        // Transform ALL devices
                        const transformedAssets = allDevices.map(device => ({
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
                            preferred_access: device.preferredAccess || device.preferred_access || device.accessMethod || '',
                            access_method: device.accessMethod || device.access_method || device.preferredAccess || '',
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
                            company_name: matchingCompany.name,
                            company_id: matchingCompany.id,
                            
                            // Additional fields
                            location: typeof device.location === 'object' ? (device.location?.name || '') : (device.location || ''),
                            ip_address: device.ipAddress || device.ip_address || '',
                            mac_address: device.macAddress || device.mac_address || '',
                            os: device.operatingSystem || device.os || '',
                            last_seen: device.lastSeen || device.last_seen || ''
                        }));
                        
                        console.log(`[API] Returning ${transformedAssets.length} devices via direct search with offset pagination`);
                        return res.json({
                            assets: transformedAssets,
                            company: {
                                name: matchingCompany.name,
                                id: matchingCompany.id
                            },
                            organization: {
                                name: orgName,
                                id: user.organization_id
                            },
                            search_method: 'direct_search_offset_paginated'
                        });
                    }
                } catch (directError) {
                    console.log(`[API] Direct search failed: ${directError.message}`);
                }
                
                console.log(`[API] No match found for "${orgName}"`);
                return res.json({ 
                    assets: [],
                    message: companiesCache.companies.length > 0 ?
                        `No matching IT Portal company found for "${orgName}". Contact support if this company should be in IT Portal.` :
                        `Searching IT Portal companies... Please refresh in a moment or contact support if "${orgName}" should be in IT Portal.`,
                    search_method: companiesCache.companies.length > 0 ? 'cache_search' : 'fallback_search',
                    companies_searched: companiesCache.companies.length || 20
                });
            }
        }

        console.log(`[API] Match found: "${matchingCompany.name}" (ID: ${matchingCompany.id})`);

        // Step 3: Fetch ALL devices for the matching company using OFFSET pagination
        let allDevices = [];
        let offset = 0;
        const limit = 20;
        let hasMore = true;

        while (hasMore && offset < 500) { // Safety limit of 500 devices
            const devicesResponse = await fetch(
                `https://www.siportal.net/api/2.0/devices?companyId=${matchingCompany.id}&offset=${offset}&limit=${limit}`, 
                {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!devicesResponse.ok) {
                console.log(`[API] Error fetching devices at offset ${offset}: ${devicesResponse.status}`);
                if (offset === 0) {
                    throw new Error(`SiPortal Devices API returned ${devicesResponse.status}: ${devicesResponse.statusText}`);
                }
                break; // Stop pagination on error but keep what we have
            }

            const siPortalData = await devicesResponse.json();
            const devices = siPortalData.data?.results || [];
            
            console.log(`[API] Offset ${offset}: Retrieved ${devices.length} devices for ${matchingCompany.name}`);
            
            if (devices.length > 0) {
                // Check for duplicates before adding
                const existingIds = new Set(allDevices.map(d => d.id));
                const newDevices = devices.filter(d => !existingIds.has(d.id));
                
                if (newDevices.length === 0) {
                    console.log(`[API] All devices at offset ${offset} are duplicates, stopping`);
                    hasMore = false;
                } else {
                    allDevices.push(...newDevices);
                    console.log(`[API] Added ${newDevices.length} new unique devices (${allDevices.length} total)`);
                    
                    // Continue if we got a full page of results
                    hasMore = devices.length === limit;
                    offset += limit;
                    
                    // Small delay to avoid rate limiting
                    if (hasMore) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }
            } else {
                hasMore = false;
            }
        }
        
        console.log(`[API] SiPortal complete: ${allDevices.length} unique devices for ${matchingCompany.name}`);
        
        // Handle empty device list gracefully
        if (allDevices.length === 0) {
            console.log(`[API] No devices found for company ${matchingCompany.name} (ID: ${matchingCompany.id})`);
            return res.json({ 
                assets: [],
                company: {
                    name: matchingCompany.name,
                    id: matchingCompany.id
                },
                organization: {
                    name: orgName,
                    id: user.organization_id
                },
                message: `No devices found in IT Portal for ${matchingCompany.name}`
            });
        }

        // Debug: Log sample device data to see actual API structure
        if (allDevices.length > 0) {
            console.log('[Debug] Sample device data from SiPortal:', JSON.stringify(allDevices[0], null, 2));
            console.log(`[Debug] Total unique device IDs:`, new Set(allDevices.map(d => d.id)).size);
        }

        // Transform SiPortal device data with improved field mapping
        const assets = allDevices.map(device => ({
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
            preferred_access: device.preferredAccess || device.preferred_access || device.accessMethod || '',
            access_method: device.accessMethod || device.access_method || device.preferredAccess || '',
            credentials: device.credentials || device.credential || '',
            
            // Standard Zendesk asset fields for compatibility
            manufacturer: device.type?.name || device.manufacturer || 'Unknown',
            model: device.model || device.type?.name || 'Unknown',
            serial_number: device.serialNumber || device.serial_number || '',
            status: device.status || 'active',
            
            // Metadata fields
            source: 'SiPortal',
            imported_date: new Date().toISOString(),
            notes: Array.isArray(device.notes) ? device.notes.join(', ') : (device.notes || ''),
            assigned_user: device.assignedUser || device.assigned_user || '',
            
            // Company info for debugging
            company_name: matchingCompany.name,
            company_id: matchingCompany.id,
            
            // Additional fields that might be useful
            location: typeof device.location === 'object' ? (device.location?.name || '') : (device.location || ''),
            ip_address: device.ipAddress || device.ip_address || '',
            mac_address: device.macAddress || device.mac_address || '',
            os: device.operatingSystem || device.os || '',
            last_seen: device.lastSeen || device.last_seen || ''
        }));

        console.log(`[API] Returning ${assets.length} SiPortal devices for ${matchingCompany.name}`);
        res.json({ 
            assets,
            company: {
                name: matchingCompany.name,
                id: matchingCompany.id
            },
            organization: {
                name: orgName,
                id: user.organization_id
            },
            total_devices: assets.length
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