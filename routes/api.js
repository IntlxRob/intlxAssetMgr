// routes/api.js
// This file defines all the API endpoints and calls the appropriate service functions.

const express = require('express');
const router = express.Router();
const zendeskService = require('../services/zendesk');
const googleSheetsService = require('../services/googleSheets');

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
 * Special company name mappings for known mismatches
 */
const COMPANY_NAME_MAPPINGS = {
    'arbella service company inc., and its affiliates': 'Arbella Insurance Group',
    'arbella service company': 'Arbella Insurance Group',
    'arbella service company inc': 'Arbella Insurance Group',
    'keep me home, llc': 'Keep Me Home',
    'keep me home,llc': 'Keep Me Home',
    'intlx solutions, llc': 'intlx Solutions, LLC',
    'intlx solutions': 'intlx Solutions, LLC',
    // Add more mappings as needed
};

/**
 * Refresh the companies cache - FIXED VERSION
 */
async function refreshCompaniesCache() {
    if (companiesCache.isUpdating) {
        console.log('[Cache] Already updating companies cache, skipping...');
        return;
    }

    try {
        companiesCache.isUpdating = true;
        console.log('[Cache] Starting comprehensive companies cache refresh...');
        
        let allCompanies = [];
        let page = 1;
        let consecutiveEmptyPages = 0;
        const MAX_PAGES = 200; // Increased from whatever it was before
        const PER_PAGE = 100; // Get more per page
        
        while (page <= MAX_PAGES) {
            try {
                const url = `https://www.siportal.net/api/2.0/companies?page=${page}&per_page=${PER_PAGE}`;
                console.log(`[Cache] Fetching page ${page}: ${url}`);
                
                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                });

                if (!response.ok) {
                    console.log(`[Cache] API error on page ${page}: ${response.status} ${response.statusText}`);
                    break;
                }

                const data = await response.json();
                console.log(`[Cache] Page ${page} response structure:`, {
                    hasData: !!data.data,
                    hasResults: !!(data.data?.results),
                    resultCount: data.data?.results?.length || 0,
                    hasMeta: !!data.meta,
                    hasPagination: !!data.pagination
                });
                
                // Try different response structures
                const companies = data.data?.results || data.results || data.data || data || [];
                
                if (!Array.isArray(companies)) {
                    console.log(`[Cache] Page ${page}: Response is not an array, breaking`);
                    break;
                }
                
                if (companies.length === 0) {
                    consecutiveEmptyPages++;
                    console.log(`[Cache] Page ${page}: Empty page (${consecutiveEmptyPages} consecutive)`);
                    
                    if (consecutiveEmptyPages >= 3) {
                        console.log(`[Cache] Three consecutive empty pages, stopping`);
                        break;
                    }
                } else {
                    consecutiveEmptyPages = 0;
                    allCompanies.push(...companies);
                    console.log(`[Cache] Page ${page}: Added ${companies.length} companies (total: ${allCompanies.length})`);
                    
                    // Log every 5 pages for progress
                    if (page % 5 === 0) {
                        console.log(`[Cache] Progress: ${allCompanies.length} companies loaded so far`);
                        // Log some company names to verify we're getting real data
                        const sampleNames = companies.slice(0, 3).map(c => c.name).filter(Boolean);
                        console.log(`[Cache] Sample from page ${page}:`, sampleNames);
                    }
                }
                
                // Check various pagination indicators
                const hasMore = data.meta?.has_more || 
                              data.pagination?.has_more || 
                              data.has_more ||
                              companies.length === PER_PAGE; // If we got a full page, there might be more
                
                if (!hasMore && companies.length < PER_PAGE) {
                    console.log(`[Cache] Page ${page}: Incomplete page (${companies.length}/${PER_PAGE}), likely last page`);
                    break;
                }
                
                page++;
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (pageError) {
                console.error(`[Cache] Error fetching page ${page}:`, pageError.message);
                // Try to continue with next page
                page++;
                consecutiveEmptyPages++;
                
                if (consecutiveEmptyPages >= 3) {
                    console.log('[Cache] Too many consecutive errors, stopping');
                    break;
                }
            }
        }
        
        // Remove duplicates if any
        const uniqueCompanies = [];
        const seenIds = new Set();
        
        for (const company of allCompanies) {
            if (company.id && !seenIds.has(company.id)) {
                seenIds.add(company.id);
                uniqueCompanies.push(company);
            }
        }
        
        companiesCache.companies = uniqueCompanies;
        companiesCache.lastUpdated = new Date();
        
        console.log('[Cache] ========================================');
        console.log(`[Cache] Cache refresh completed:`);
        console.log(`[Cache]   - Pages fetched: ${page - 1}`);
        console.log(`[Cache]   - Total companies: ${uniqueCompanies.length}`);
        console.log(`[Cache]   - Duplicates removed: ${allCompanies.length - uniqueCompanies.length}`);
        console.log('[Cache] ========================================');
        
        // Log all company names if we have less than expected
        if (uniqueCompanies.length < 100) {
            console.log('[Cache] All company names:', uniqueCompanies.map(c => c.name));
        } else {
            // Log first 20 and last 20 for verification
            console.log('[Cache] First 20 companies:', uniqueCompanies.slice(0, 20).map(c => c.name));
            console.log('[Cache] Last 20 companies:', uniqueCompanies.slice(-20).map(c => c.name));
        }
        
        // Check if Arbella is in the cache
        const arbellaCompanies = uniqueCompanies.filter(c => 
            c.name?.toLowerCase().includes('arbella')
        );
        console.log('[Cache] Arbella-related companies found:', arbellaCompanies.map(c => ({ id: c.id, name: c.name })));
        
    } catch (error) {
        console.error('[Cache] Fatal error refreshing companies cache:', error);
    } finally {
        companiesCache.isUpdating = false;
    }
}

/**
 * Advanced company name normalization
 */
function normalizeCompanyName(name) {
    if (!name) return '';
    
    return name
        .toLowerCase()
        .trim()
        // Remove "and its affiliates" and similar phrases
        .replace(/[,.]?\s*(and its affiliates|and affiliates|& affiliates)\.?$/i, '')
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
 * Find matching company with special mappings and fuzzy logic
 */
async function findMatchingCompany(orgName) {
    // Ensure cache is populated
    if (companiesCache.companies.length === 0 && !companiesCache.isUpdating) {
        console.log('[API] Cache empty, refreshing...');
        await refreshCompaniesCache();
    }
    
    // Check special mappings first
    const normalizedOrgName = orgName.toLowerCase().trim();
    const mappedName = COMPANY_NAME_MAPPINGS[normalizedOrgName];
    
    if (mappedName) {
        console.log(`[API] Using special mapping: "${orgName}" -> "${mappedName}"`);
        const exactMatch = companiesCache.companies.find(c => 
            c.name?.toLowerCase() === mappedName.toLowerCase()
        );
        if (exactMatch) {
            return { company: exactMatch, score: 100, method: 'special_mapping' };
        }
    }
    
    // Try normalized matching
    const normalizedSearch = normalizeCompanyName(orgName);
    let bestMatch = null;
    let bestScore = 0;
    let bestMethod = '';
    
    for (const company of companiesCache.companies) {
        if (!company.name) continue;
        
        const normalizedCompany = normalizeCompanyName(company.name);
        
        // Exact match after normalization
        if (normalizedCompany === normalizedSearch) {
            return { company, score: 100, method: 'exact_normalized' };
        }
        
        // Calculate similarity score
        let score = 0;
        let method = '';
        
        // Substring matching
        if (normalizedCompany.includes(normalizedSearch) || normalizedSearch.includes(normalizedCompany)) {
            score = 85;
            method = 'substring';
        }
        
        // Word-based matching
        const searchWords = normalizedSearch.split(/\s+/);
        const companyWords = normalizedCompany.split(/\s+/);
        
        if (searchWords.length > 0 && companyWords.length > 0) {
            const matchingWords = searchWords.filter(word => 
                companyWords.some(cWord => 
                    cWord === word || 
                    (word.length > 2 && cWord.includes(word)) ||
                    (cWord.length > 2 && word.includes(cWord))
                )
            );
            
            const matchRatio = matchingWords.length / Math.max(searchWords.length, companyWords.length);
            if (matchRatio >= 0.7) {
                const wordScore = 70 + (matchRatio - 0.7) * 50;
                if (wordScore > score) {
                    score = wordScore;
                    method = 'word_matching';
                }
            }
        }
        
        if (score > bestScore) {
            bestMatch = company;
            bestScore = score;
            bestMethod = method;
        }
    }
    
    if (bestMatch && bestScore >= 60) {
        return { company: bestMatch, score: bestScore, method: bestMethod };
    }
    
    return null;
}

/**
 * IT Portal Assets endpoint with automatic company matching and caching
 */
router.get('/it-portal-assets', async (req, res) => {
    try {
        const { company_id, user_id } = req.query;
        
        // If direct company_id provided, use it
        if (company_id) {
            console.log(`[API] Using provided company ID: ${company_id}`);
            
            const response = await fetch(`https://www.siportal.net/api/2.0/devices?companyId=${company_id}`, {
                method: 'GET',
                headers: {
                    'Authorization': process.env.SIPORTAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                if (response.status === 404) {
                    return res.json({ 
                        assets: [],
                        message: `No company found with ID ${company_id}`,
                        company_id: company_id,
                        error_type: 'company_not_found'
                    });
                }
                throw new Error(`SiPortal API returned ${response.status}: ${response.statusText}`);
            }

            const siPortalData = await response.json();
            const devices = siPortalData.data?.results || [];
            
            // Transform devices to standard format
            const assets = devices.map(device => ({
                id: device.id,
                asset_tag: device.name || device.hostName || device.id,
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
                manufacturer: device.type?.name || device.manufacturer || 'Unknown',
                model: device.model || device.type?.name || 'Unknown',
                serial_number: device.serialNumber || device.serial_number || '',
                status: device.status || 'active',
                source: 'SiPortal',
                imported_date: new Date().toISOString(),
                notes: Array.isArray(device.notes) ? device.notes.join(', ') : (device.notes || ''),
                assigned_user: device.assignedUser || device.assigned_user || '',
                company_id: company_id,
                location: typeof device.location === 'object' ? (device.location?.name || '') : (device.location || ''),
                ip_address: device.ipAddress || device.ip_address || '',
                mac_address: device.macAddress || device.mac_address || '',
                os: device.operatingSystem || device.os || '',
                last_seen: device.lastSeen || device.last_seen || ''
            }));

            return res.json({ 
                assets,
                company_id: company_id,
                method: 'direct_id',
                total: assets.length
            });
        }
        
        // AUTOMATIC MATCHING: Look up organization and find matching company
        if (user_id) {
            console.log(`[API] Auto-matching IT Portal company for user: ${user_id}`);
            
            const user = await zendeskService.getUserById(user_id);
            if (!user.organization_id) {
                return res.json({ 
                    assets: [],
                    message: 'User has no organization associated',
                    error_type: 'no_organization'
                });
            }

            const organization = await zendeskService.getOrganizationById(user.organization_id);
            const orgName = organization?.name;
            
            if (!orgName) {
                return res.json({ 
                    assets: [],
                    message: 'Organization has no name',
                    error_type: 'no_org_name'
                });
            }
            
            console.log(`[API] Organization name: "${orgName}"`);
            
            // Check if we already have a cached company ID
            let itPortalCompanyId = organization?.organization_fields?.it_portal_company_id;
            let itPortalCompanyName = organization?.organization_fields?.it_portal_company_name;
            
            if (!itPortalCompanyId) {
                console.log(`[API] No cached company ID, searching for: "${orgName}"`);
                
                // Try to find matching company
                const match = await findMatchingCompany(orgName);
                
                if (match) {
                    itPortalCompanyId = match.company.id;
                    itPortalCompanyName = match.company.name;
                    console.log(`[API] Found match: "${match.company.name}" (ID: ${itPortalCompanyId}, Score: ${match.score}, Method: ${match.method})`);
                    
                    // Save the matched ID to the organization for future use
                    try {
                        await zendeskService.updateOrganization(user.organization_id, {
                            organization_fields: {
                                ...organization.organization_fields,
                                it_portal_company_id: itPortalCompanyId.toString(),
                                it_portal_company_name: itPortalCompanyName
                            }
                        });
                        console.log(`[API] Saved company ID ${itPortalCompanyId} to organization`);
                    } catch (saveError) {
                        console.error('[API] Failed to save company ID to organization:', saveError.message);
                        // Continue anyway - we have the ID for this request
                    }
                } else {
                    console.log(`[API] No automatic match found for "${orgName}"`);
                    
                    // Return possible matches for manual selection
                    const searchWords = orgName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                    const possibleMatches = companiesCache.companies
                        .filter(c => {
                            const name = c.name?.toLowerCase() || '';
                            return searchWords.some(word => name.includes(word));
                        })
                        .slice(0, 10)
                        .map(c => ({ id: c.id, name: c.name }));
                    
                    return res.json({
                        assets: [],
                        message: `No automatic match found for "${orgName}". Please select the correct company.`,
                        possible_matches: possibleMatches,
                        error_type: 'no_match_found',
                        organization: {
                            id: user.organization_id,
                            name: orgName
                        }
                    });
                }
            } else {
                console.log(`[API] Using cached company ID: ${itPortalCompanyId}`);
            }
            
            // Now fetch devices with the company ID
            if (itPortalCompanyId) {
                const response = await fetch(`https://www.siportal.net/api/2.0/devices?companyId=${itPortalCompanyId}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                });

                if (!response.ok) {
                    if (response.status === 404) {
                        // Company ID exists but no devices found or company not found
                        return res.json({
                            assets: [],
                            company_id: itPortalCompanyId,
                            company_name: itPortalCompanyName,
                            message: `No devices found for company ID ${itPortalCompanyId}`,
                            organization: {
                                id: user.organization_id,
                                name: orgName
                            }
                        });
                    }
                    throw new Error(`SiPortal API returned ${response.status}: ${response.statusText}`);
                }

                const siPortalData = await response.json();
                const devices = siPortalData.data?.results || [];
                
                console.log(`[API] Found ${devices.length} devices for company "${itPortalCompanyName}" (ID: ${itPortalCompanyId})`);
                
                // Transform devices
                const assets = devices.map(device => ({
                    id: device.id,
                    asset_tag: device.name || device.hostName || device.id,
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
                    manufacturer: device.type?.name || device.manufacturer || 'Unknown',
                    model: device.model || device.type?.name || 'Unknown',
                    serial_number: device.serialNumber || device.serial_number || '',
                    status: device.status || 'active',
                    source: 'SiPortal',
                    imported_date: new Date().toISOString(),
                    notes: Array.isArray(device.notes) ? device.notes.join(', ') : (device.notes || ''),
                    assigned_user: device.assignedUser || device.assigned_user || '',
                    company_id: itPortalCompanyId,
                    company_name: itPortalCompanyName,
                    location: typeof device.location === 'object' ? (device.location?.name || '') : (device.location || ''),
                    ip_address: device.ipAddress || device.ip_address || '',
                    mac_address: device.macAddress || device.mac_address || '',
                    os: device.operatingSystem || device.os || '',
                    last_seen: device.lastSeen || device.last_seen || ''
                }));

                return res.json({
                    assets,
                    company_id: itPortalCompanyId,
                    company_name: itPortalCompanyName,
                    organization: {
                        id: user.organization_id,
                        name: orgName
                    },
                    method: 'auto_matched'
                });
            }
            
            // No company ID found at all
            return res.json({
                assets: [],
                message: `Unable to determine IT Portal company for "${orgName}"`,
                error_type: 'no_company_id',
                organization: {
                    id: user.organization_id,
                    name: orgName
                }
            });
        }
        
        return res.status(400).json({ 
            error: 'Missing required parameters',
            message: 'Either company_id or user_id parameter is required'
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
 * Search for SiPortal companies by name
 */
router.get('/search-siportal-companies', async (req, res) => {
    try {
        const { q } = req.query;
        
        if (!q) {
            return res.status(400).json({ error: 'Search query required' });
        }
        
        // Ensure cache is populated
        if (companiesCache.companies.length === 0) {
            await refreshCompaniesCache();
        }
        
        const searchTerm = q.toLowerCase();
        const matches = companiesCache.companies
            .filter(c => c.name?.toLowerCase().includes(searchTerm))
            .slice(0, 20)
            .map(c => ({ id: c.id, name: c.name }));
        
        res.json({
            companies: matches,
            total: matches.length,
            search_term: q
        });
        
    } catch (error) {
        console.error('[API] Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get all SiPortal companies (for dropdown)
 */
router.get('/siportal-companies', async (req, res) => {
    try {
        // Check if cache needs refresh (refresh every 12 hours)
        const cacheAge = companiesCache.lastUpdated ? 
            (Date.now() - companiesCache.lastUpdated.getTime()) : 
            Infinity;
        const CACHE_MAX_AGE = 12 * 60 * 60 * 1000; // 12 hours
        
        if (cacheAge > CACHE_MAX_AGE && !companiesCache.isUpdating) {
            console.log('[API] Cache is stale, refreshing...');
            await refreshCompaniesCache();
        }
        
        // If still no cache, try to populate it
        if (companiesCache.companies.length === 0 && !companiesCache.isUpdating) {
            await refreshCompaniesCache();
        }
        
        res.json({
            success: true,
            companies: companiesCache.companies,
            total: companiesCache.companies.length,
            last_updated: companiesCache.lastUpdated
        });
        
    } catch (error) {
        console.error('[API] Error fetching SiPortal companies:', error.message);
        res.status(500).json({
            error: 'Failed to fetch companies',
            details: error.message
        });
    }
});

/**
 * Manually refresh companies cache
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
 * Update IT Portal asset (SiPortal device)
 * This endpoint would need to be implemented with SiPortal's update API
 */
router.put('/it-portal-assets/:id', async (req, res) => {
    try {
        const deviceId = req.params.id;
        const updateData = req.body;
        
        console.log(`[API] Updating IT Portal device ${deviceId}:`, updateData);
        
        // Note: This would need to be implemented with actual SiPortal update API
        // For now, returning a mock success response
        
        res.json({
            success: true,
            message: 'IT Portal asset update endpoint - implementation needed',
            device_id: deviceId,
            updated_fields: updateData
        });
        
    } catch (error) {
        console.error('[API] Error updating IT Portal asset:', error.message);
        res.status(500).json({
            error: 'Failed to update IT Portal asset',
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

        // Process webhook event
        // This could trigger cache updates, notifications, etc.
        
        console.log(`[Webhook] Processed ${event} event for company ${company_id}`);
        
        res.json({ 
            success: true, 
            message: 'Webhook processed successfully'
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
 * Import SiPortal devices as Zendesk assets for an organization
 * Uses IT Portal Company ID from organization custom fields
 */
router.post('/import-siportal-devices', async (req, res) => {
    try {
        const { user_id, organization_id, company_id } = req.body;
        
        // Determine the SiPortal company ID to use
        let siPortalCompanyId = company_id;
        let orgId = organization_id;
        let orgName = '';
        
        if (!siPortalCompanyId) {
            // Try to get from organization
            if (!organization_id && user_id) {
                const user = await zendeskService.getUserById(user_id);
                orgId = user.organization_id;
            }
            
            if (!orgId) {
                return res.status(400).json({ 
                    error: 'Missing required parameters',
                    message: 'Either company_id, organization_id, or user_id is required'
                });
            }
            
            const organization = await zendeskService.getOrganizationById(orgId);
            orgName = organization.name;
            siPortalCompanyId = organization?.organization_fields?.it_portal_company_id;
            
            if (!siPortalCompanyId) {
                return res.status(400).json({
                    error: 'No IT Portal Company ID configured',
                    message: `Organization "${orgName}" does not have an IT Portal Company ID configured`,
                    organization_id: orgId
                });
            }
        }

        console.log(`[Import] Starting import for SiPortal company ID: ${siPortalCompanyId}`);

        // Fetch devices from SiPortal
        const response = await fetch(`https://www.siportal.net/api/2.0/devices?companyId=${siPortalCompanyId}`, {
            method: 'GET',
            headers: {
                'Authorization': process.env.SIPORTAL_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`SiPortal API returned ${response.status}: ${response.statusText}`);
        }

        const siPortalData = await response.json();
        const devices = siPortalData.data?.results || [];
        
        console.log(`[Import] Found ${devices.length} devices in SiPortal`);

        if (devices.length === 0) {
            return res.json({
                success: true,
                message: 'No devices found to import',
                imported: 0,
                skipped: 0,
                company_id: siPortalCompanyId
            });
        }

        let imported = 0;
        let skipped = 0;
        const importResults = [];

        // Import each device as a Zendesk asset
        for (const device of devices) {
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
                    notes: `Imported from SiPortal
SiPortal ID: ${device.id}
Company ID: ${siPortalCompanyId}
Device Type: ${device.type?.name || 'Unknown'}
Host Name: ${device.hostName || 'Not specified'}
Domain: ${device.domain || device.realm || 'Not specified'}
Import Date: ${new Date().toISOString()}`,
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
            company_id: siPortalCompanyId,
            organization: orgId ? {
                id: orgId,
                name: orgName
            } : null,
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
 * Preview what devices would be imported from SiPortal
 */
router.get('/preview-siportal-import', async (req, res) => {
    try {
        const { user_id, organization_id, company_id } = req.query;
        
        // Determine the SiPortal company ID to use
        let siPortalCompanyId = company_id;
        let orgId = organization_id;
        let orgName = '';
        
        if (!siPortalCompanyId) {
            // Try to get from organization
            if (!organization_id && user_id) {
                const user = await zendeskService.getUserById(user_id);
                orgId = user.organization_id;
            }
            
            if (!orgId) {
                return res.status(400).json({ 
                    error: 'Missing required parameters',
                    message: 'Either company_id, organization_id, or user_id is required'
                });
            }
            
            const organization = await zendeskService.getOrganizationById(orgId);
            orgName = organization.name;
            siPortalCompanyId = organization?.organization_fields?.it_portal_company_id;
            
            if (!siPortalCompanyId) {
                return res.status(400).json({
                    error: 'No IT Portal Company ID configured',
                    message: `Organization "${orgName}" does not have an IT Portal Company ID configured`,
                    organization_id: orgId
                });
            }
        }

        // Fetch devices from SiPortal
        const response = await fetch(`https://www.siportal.net/api/2.0/devices?companyId=${siPortalCompanyId}`, {
            method: 'GET',
            headers: {
                'Authorization': process.env.SIPORTAL_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`SiPortal API returned ${response.status}: ${response.statusText}`);
        }

        const siPortalData = await response.json();
        const devices = siPortalData.data?.results || [];

        // Get existing assets to check for duplicates
        const existingAssets = user_id ? await zendeskService.getUserAssetsById(user_id) : [];

        // Preview what would be imported
        const preview = devices.map(device => {
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
                assigned_user: device.assignedUser || device.assigned_user || 'Unassigned',
                domain: device.domain || device.realm || '',
                facility: typeof device.facility === 'object' ? (device.facility?.name || '') : (device.facility || ''),
                status: assetExists ? 'exists' : 'new'
            };
        });

        const newDevices = preview.filter(d => d.status === 'new');
        const existingDevices = preview.filter(d => d.status === 'exists');

        res.json({
            success: true,
            company_id: siPortalCompanyId,
            organization: orgId ? {
                id: orgId,
                name: orgName
            } : null,
            total_devices: devices.length,
            new_devices: newDevices.length,
            existing_devices: existingDevices.length,
            preview
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
 * Used by client-side API for customer notes and IT Portal Company ID editing.
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
 * Debug endpoint to check cache status and force refresh
 */
router.get('/debug-cache-status', async (req, res) => {
    const { refresh } = req.query;
    
    if (refresh === 'true') {
        await refreshCompaniesCache();
    }
    
    res.json({
        cache_size: companiesCache.companies.length,
        last_updated: companiesCache.lastUpdated,
        is_updating: companiesCache.isUpdating,
        sample_companies: companiesCache.companies.slice(0, 10).map(c => ({ id: c.id, name: c.name })),
        arbella_companies: companiesCache.companies.filter(c => 
            c.name?.toLowerCase().includes('arbella')
        ).map(c => ({ id: c.id, name: c.name }))
    });
});

// Initialize companies cache on startup
if (process.env.SIPORTAL_API_KEY) {
    // Start cache refresh in background
    refreshCompaniesCache().catch(err => 
        console.error('[Startup] Initial cache refresh failed:', err.message)
    );
}

module.exports = router;