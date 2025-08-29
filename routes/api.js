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
 * Refresh the companies cache
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
        
        while (page <= 50) { // Increased from 25 to 50 pages = 1000 companies max
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
        
    } catch (error) {
        console.error('[Cache] Error refreshing companies cache:', error.message);
    } finally {
        companiesCache.isUpdating = false;
    }
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
 * Used by React app IT Portal Assets section.
 * NOW SUPPORTS ANY ORGANIZATION - dynamically finds matching company in SiPortal
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
            'starling physicians mso, llc': 4133, // Maps to "Starling Physicians MSO, LLC"
            'rockland trust company': null, // Set to null to search by name variations
            
            // Common patterns
            'university of massachusetts': null, // Will try "UMass", "Mass University", etc.
            'mass general brigham': null, // Will try "MGB", "Massachusetts General", etc.
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
                console.log(`[API] No match found in cache for "${orgName}", trying direct search`);
                
                // Try direct search by company name as fallback
                try {
                    const directResponse = await fetch(`https://www.siportal.net/api/2.0/devices?company=${encodeURIComponent(orgName)}`, {
                        method: 'GET',
                        headers: {
                            'Authorization': process.env.SIPORTAL_API_KEY,
                            'Content-Type': 'application/json'
                        }
                    });
                    
                    if (directResponse.ok) {
                        const directData = await directResponse.json();
                        const devices = directData.data?.results || [];
                        
                        if (devices.length > 0) {
                            // Extract company info from the first device
                            const companyInfo = devices[0].company;
                            if (companyInfo && companyInfo.id) {
                                matchingCompany = companyInfo;
                                console.log(`[API] Direct search found: "${companyInfo.name}" (ID: ${companyInfo.id}) with ${devices.length} devices`);
                                
                                // Return the devices directly since we already have them
                                const transformedAssets = devices.map(device => ({
                                    // Basic identification
                                    id: device.id,
                                    asset_tag: device.name || device.hostName || device.id,
                                    
                                    // IT Portal specific fields (matching your actual field names)
                                    device_type: device.type?.name || device.deviceType || 'Unknown',
                                    name: device.name || 'Unnamed Device',
                                    host_name: device.hostName || device.hostname || '',
                                    description: (device.description && 
                                                 device.description !== 'Active' && 
                                                 device.description !== 'Inactive' && 
                                                 device.description !== device.status &&
                                                 device.description.toLowerCase() !== 'active' &&
                                                 device.description.toLowerCase() !== 'inactive') ? 
                                                device.description : 
                                                '',
                                    domain: device.domain || device.realm || '',
                                    realm: device.realm || device.domain || '', // Alternative field name
                                    facility: typeof device.facility === 'object' ? (device.facility?.name || '') : (device.facility || ''),
                                    username: device.username || device.user || '',
                                    preferred_access: device.preferredAccess || device.preferred_access || device.accessMethod || '',
                                    access_method: device.accessMethod || device.access_method || device.preferredAccess || '', // Alternative field name
                                    credentials: device.credentials || device.credential || '',
                                    
                                    // Standard Zendesk asset fields for compatibility
                                    manufacturer: device.type?.name || device.manufacturer || 'Unknown',
                                    model: device.model || device.type?.name || 'Unknown',
                                    serial_number: device.serialNumber || device.serial_number || '',
                                    status: device.status || 
                                           (device.description && (device.description.toLowerCase() === 'active' || device.description.toLowerCase() === 'inactive') ? 
                                            device.description.toLowerCase() : 'active'),
                                    
                                    // Metadata fields
                                    source: 'SiPortal',
                                    imported_date: new Date().toISOString(),
                                    notes: Array.isArray(device.notes) ? device.notes.join(', ') : (device.notes || ''),
                                    assigned_user: device.assignedUser || device.assigned_user || '',
                                    
                                    // Company info for debugging
                                    company_name: companyInfo.name,
                                    company_id: companyInfo.id,
                                    
                                    // Additional fields that might be useful
                                    location: typeof device.location === 'object' ? (device.location?.name || '') : (device.location || ''),
                                    ip_address: device.ipAddress || device.ip_address || '',
                                    mac_address: device.macAddress || device.mac_address || '',
                                    os: device.operatingSystem || device.os || '',
                                    last_seen: device.lastSeen || device.last_seen || ''
                                }));
                                
                                console.log(`[API] Returning ${transformedAssets.length} devices via direct search`);
                                return res.json({
                                    assets: transformedAssets,
                                    company: {
                                        name: companyInfo.name,
                                        id: companyInfo.id
                                    },
                                    organization: {
                                        name: orgName,
                                        id: user.organization_id
                                    },
                                    search_method: 'direct_search'
                                });
                            }
                        }
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

        // Step 3: Fetch devices for the matching company
        const devicesResponse = await fetch(`https://www.siportal.net/api/2.0/devices?companyId=${matchingCompany.id}`, {
            method: 'GET',
            headers: {
                'Authorization': process.env.SIPORTAL_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (!devicesResponse.ok) {
            throw new Error(`SiPortal Devices API returned ${devicesResponse.status}: ${devicesResponse.statusText}`);
        }

        const siPortalData = await devicesResponse.json();
        const devices = siPortalData.data?.results || [];
        console.log(`[API] SiPortal response: ${devices.length} devices for ${matchingCompany.name}`);
        
        // Handle empty device list gracefully
        if (devices.length === 0) {
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
        if (devices.length > 0) {
            console.log('[Debug] Sample device data from SiPortal:', JSON.stringify(devices[0], null, 2));
        }

        // Transform SiPortal device data with improved field mapping
        const assets = devices.map(device => ({
            // Basic identification
            id: device.id,
            asset_tag: device.name || device.hostName || device.id,
            
            // IT Portal specific fields (matching your actual field names)
            device_type: device.type?.name || device.deviceType || 'Unknown',
            name: device.name || 'Unnamed Device',
            host_name: device.hostName || device.hostname || '',
            description: (device.description && 
                         device.description !== 'Active' && 
                         device.description !== 'Inactive' && 
                         device.description !== device.status &&
                         device.description.toLowerCase() !== 'active' &&
                         device.description.toLowerCase() !== 'inactive') ? 
                        device.description : 
                        '',
            domain: device.domain || device.realm || '',
            realm: device.realm || device.domain || '', // Alternative field name
            facility: typeof device.facility === 'object' ? (device.facility?.name || '') : (device.facility || ''),
            username: device.username || device.user || '',
            preferred_access: device.preferredAccess || device.preferred_access || device.accessMethod || '',
            access_method: device.accessMethod || device.access_method || device.preferredAccess || '', // Alternative field name
            credentials: device.credentials || device.credential || '',
            
            // Standard Zendesk asset fields for compatibility
            manufacturer: device.type?.name || device.manufacturer || 'Unknown',
            model: device.model || device.type?.name || 'Unknown',
            serial_number: device.serialNumber || device.serial_number || '',
            status: device.status || 
                   (device.description && (device.description.toLowerCase() === 'active' || device.description.toLowerCase() === 'inactive') ? 
                    device.description.toLowerCase() : 'active'),
            
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
            }
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
 * Endpoint to update an IT Portal (SiPortal) device
 * PUT /api/it-portal-assets/:id
 */
router.put('/it-portal-assets/:id', async (req, res) => {
    try {
        const deviceId = req.params.id;
        const updateData = req.body;
        
        console.log(`[API] Updating SiPortal device ${deviceId} with:`, updateData);
        
        // Map form fields back to SiPortal API format
        const siPortalUpdateData = {};
        
        if (updateData.type !== undefined) {
            siPortalUpdateData.deviceType = updateData.type;
        }
        if (updateData.name !== undefined) {
            siPortalUpdateData.name = updateData.name;
        }
        if (updateData.host_name !== undefined) {
            siPortalUpdateData.hostName = updateData.host_name;
        }
        if (updateData.description !== undefined) {
            siPortalUpdateData.description = updateData.description;
        }
        if (updateData.domain !== undefined) {
            siPortalUpdateData.domain = updateData.domain;
        }
        if (updateData.facility !== undefined) {
            siPortalUpdateData.facility = updateData.facility;
        }
        if (updateData.username !== undefined) {
            siPortalUpdateData.username = updateData.username;
        }
        if (updateData.preferred_access !== undefined) {
            siPortalUpdateData.preferredAccess = updateData.preferred_access;
        }
        
        console.log(`[API] Mapped SiPortal update data:`, siPortalUpdateData);
        
        // Test multiple possible endpoints and methods
        const endpoints = [
            { method: 'PUT', url: `https://www.siportal.net/api/2.0/devices/${deviceId}` },
            { method: 'PATCH', url: `https://www.siportal.net/api/2.0/devices/${deviceId}` },
            { method: 'POST', url: `https://www.siportal.net/api/2.0/devices/${deviceId}/update` },
            { method: 'PUT', url: `https://www.siportal.net/api/2.0/device/${deviceId}` }, // singular
        ];
        
        let lastError = null;
        let response = null;
        
        // Try each endpoint until one works
        for (const endpoint of endpoints) {
            try {
                console.log(`[API] Trying ${endpoint.method} ${endpoint.url}`);
                
                response = await fetch(endpoint.url, {
                    method: endpoint.method,
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify(siPortalUpdateData)
                });
                
                console.log(`[API] Response status: ${response.status} ${response.statusText}`);
                console.log(`[API] Response headers:`, Object.fromEntries(response.headers.entries()));
                
                // Get response text first to see what we actually received
                const responseText = await response.text();
                console.log(`[API] Raw response body:`, responseText.substring(0, 500)); // First 500 chars
                
                if (response.ok) {
                    // Try to parse as JSON
                    let updatedDevice;
                    try {
                        updatedDevice = JSON.parse(responseText);
                        console.log(`[API] SiPortal device ${deviceId} updated successfully with ${endpoint.method} ${endpoint.url}`);
                        
                        // Transform the response back to our format
                        const transformedDevice = {
                            id: updatedDevice.id,
                            asset_tag: updatedDevice.name || updatedDevice.hostName || updatedDevice.id,
                            device_type: updatedDevice.type?.name || updatedDevice.deviceType || 'Unknown',
                            name: updatedDevice.name || 'Unnamed Device',
                            host_name: updatedDevice.hostName || updatedDevice.hostname || '',
                            description: updatedDevice.description || '',
                            domain: updatedDevice.domain || updatedDevice.realm || '',
                            realm: updatedDevice.realm || updatedDevice.domain || '',
                            facility: typeof updatedDevice.facility === 'object' ? 
                                     (updatedDevice.facility?.name || '') : 
                                     (updatedDevice.facility || ''),
                            username: updatedDevice.username || updatedDevice.user || '',
                            preferred_access: updatedDevice.preferredAccess || updatedDevice.preferred_access || 
                                             updatedDevice.accessMethod || '',
                            access_method: updatedDevice.accessMethod || updatedDevice.access_method || 
                                         updatedDevice.preferredAccess || '',
                            credentials: updatedDevice.credentials || updatedDevice.credential || '',
                            manufacturer: updatedDevice.type?.name || updatedDevice.manufacturer || 'Unknown',
                            model: updatedDevice.model || updatedDevice.type?.name || 'Unknown',
                            serial_number: updatedDevice.serialNumber || updatedDevice.serial_number || '',
                            status: updatedDevice.status || 'active',
                            source: 'SiPortal',
                            imported_date: new Date().toISOString(),
                            notes: Array.isArray(updatedDevice.notes) ? 
                                   updatedDevice.notes.join(', ') : 
                                   (updatedDevice.notes || ''),
                            assigned_user: updatedDevice.assignedUser || updatedDevice.assigned_user || '',
                            company_name: updatedDevice.company?.name || 'Unknown',
                            company_id: updatedDevice.company?.id || null,
                            location: typeof updatedDevice.location === 'object' ? 
                                     (updatedDevice.location?.name || '') : 
                                     (updatedDevice.location || ''),
                            ip_address: updatedDevice.ipAddress || updatedDevice.ip_address || '',
                            mac_address: updatedDevice.macAddress || updatedDevice.mac_address || '',
                            os: updatedDevice.operatingSystem || updatedDevice.os || '',
                            last_seen: updatedDevice.lastSeen || updatedDevice.last_seen || ''
                        };
                        
                        return res.json({
                            success: true,
                            message: 'IT Portal device updated successfully',
                            device: transformedDevice
                        });
                        
                    } catch (parseError) {
                        console.log(`[API] Response was successful but not JSON:`, parseError.message);
                        
                        // If update succeeded but response isn't JSON, return a mock response
                        const mockUpdatedDevice = {
                            id: parseInt(deviceId),
                            asset_tag: siPortalUpdateData.name || 'Updated Device',
                            device_type: siPortalUpdateData.deviceType || 'Unknown',
                            name: siPortalUpdateData.name || 'Updated Device',
                            host_name: siPortalUpdateData.hostName || '',
                            description: siPortalUpdateData.description || '',
                            domain: siPortalUpdateData.domain || '',
                            facility: siPortalUpdateData.facility || '',
                            username: siPortalUpdateData.username || '',
                            preferred_access: siPortalUpdateData.preferredAccess || '',
                            manufacturer: 'Unknown',
                            model: 'Unknown',
                            status: 'active',
                            source: 'SiPortal',
                            imported_date: new Date().toISOString(),
                            company_name: 'intlx Solutions, LLC',
                            company_id: 3492
                        };
                        
                        return res.json({
                            success: true,
                            message: 'IT Portal device updated successfully (non-JSON response)',
                            device: mockUpdatedDevice
                        });
                    }
                    
                } else {
                    lastError = `${endpoint.method} ${endpoint.url} returned ${response.status}: ${responseText}`;
                    console.log(`[API] ${lastError}`);
                }
                
            } catch (fetchError) {
                lastError = `${endpoint.method} ${endpoint.url} failed: ${fetchError.message}`;
                console.log(`[API] ${lastError}`);
            }
        }
        
        // If we get here, none of the endpoints worked
        throw new Error(`All SiPortal update attempts failed. Last error: ${lastError}`);
        
    } catch (error) {
        console.error('[API] Error updating SiPortal device:', error.message);
        res.status(500).json({
            error: 'Failed to update IT Portal device',
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

        // Fetch updated device data from SiPortal
        console.log(`[API] Fetching SiPortal devices for company ID: ${company_id}`);
        
        const response = await fetch(`https://www.siportal.net/api/2.0/devices?companyId=${company_id}`, {
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
        console.log(`[API] Successfully fetched ${siPortalData.data?.results?.length || 0} devices from SiPortal`);
        
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
 * Endpoint to import SiPortal devices as Zendesk assets for an organization
 * POST /api/import-siportal-devices
 * NOW SUPPORTS ANY ORGANIZATION - dynamically finds matching company
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

        // Comprehensive company search with enhanced fuzzy matching
        console.log(`[Import] Searching SiPortal for organization: "${orgName}"`);
        
        let allCompanies = [];
        let page = 1;
        let totalPages = 1;

        // Fetch all companies with proper pagination
        while (page <= 20) { // Safety limit
            const companiesResponse = await fetch(`https://www.siportal.net/api/2.0/companies?page=${page}`, {
                method: 'GET',
                headers: {
                    'Authorization': process.env.SIPORTAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            if (!companiesResponse.ok) {
                throw new Error(`SiPortal Companies API returned ${companiesResponse.status}: ${companiesResponse.statusText}`);
            }

            const companiesData = await companiesResponse.json();
            const companies = companiesData.data?.results || [];
            
            if (companies.length === 0) {
                console.log(`[Import] Page ${page}: No companies found, stopping pagination`);
                break;
            }
            
            allCompanies.push(...companies);
            console.log(`[Import] Page ${page}: Found ${companies.length} companies (total: ${allCompanies.length})`);
            
            // Check pagination metadata
            const hasMore = companiesData.meta?.has_more || 
                          companiesData.pagination?.has_more ||
                          companiesData.data?.has_more;
            
            if (hasMore === false) {
                console.log(`[Import] Reached last page based on API metadata`);
                break;
            }
            
            page++;
        }

        // Enhanced fuzzy matching
        const searchName = orgName.toLowerCase().trim();
        let matchingCompany = null;
        let matchScore = 0;

        for (const company of allCompanies) {
            const companyName = company.name?.toLowerCase().trim();
            if (!companyName) continue;

            let currentScore = 0;

            // Exact match
            if (companyName === searchName) {
                matchingCompany = company;
                matchScore = 100;
                break;
            }

            // Clean match (remove suffixes)
            const cleanCompany = companyName.replace(/[,.]?\s*(llc|inc|corp|ltd|limited)\.?$/i, '').trim();
            const cleanSearch = searchName.replace(/[,.]?\s*(llc|inc|corp|ltd|limited)\.?$/i, '').trim();
            
            if (cleanCompany === cleanSearch) {
                currentScore = 90;
            } else if (cleanCompany.includes(cleanSearch) || cleanSearch.includes(cleanCompany)) {
                currentScore = 70;
            } else {
                // Word-based matching
                const companyWords = cleanCompany.split(/\s+/);
                const searchWords = cleanSearch.split(/\s+/);
                const matchingWords = searchWords.filter(word => 
                    companyWords.some(cWord => cWord.includes(word) || word.includes(cWord))
                );
                
                if (matchingWords.length === searchWords.length && searchWords.length > 1) {
                    currentScore = 60;
                } else if (matchingWords.length > 0) {
                    currentScore = 30;
                }
            }

            if (currentScore > matchScore) {
                matchingCompany = company;
                matchScore = currentScore;
            }
        }

        if (!matchingCompany || matchScore < 50) {
            console.log(`[Import] No good match found for "${orgName}" (best score: ${matchScore})`);
            return res.status(404).json({
                error: 'No matching company found',
                message: `No matching IT Portal company found for organization "${orgName}"`,
                total_companies_searched: allCompanies.length
            });
        }

        console.log(`[Import] Match found: "${matchingCompany.name}" (ID: ${matchingCompany.id}, Score: ${matchScore})`);

        // Step 3: Fetch devices from SiPortal
        const response = await fetch(`https://www.siportal.net/api/2.0/devices?companyId=${matchingCompany.id}`, {
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
        
        console.log(`[Import] Found ${devices.length} devices in SiPortal for company ${matchingCompany.name}`);

        if (devices.length === 0) {
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

                // Create asset data with improved field mapping
                const assetData = {
                    name: device.name || device.hostName || `Device ${device.id}`,
                    asset_tag: device.name || device.hostName || device.id,
                    description: (device.description && 
                                 device.description !== 'Active' && 
                                 device.description !== 'Inactive' && 
                                 device.description !== device.status &&
                                 device.description.toLowerCase() !== 'active' &&
                                 device.description.toLowerCase() !== 'inactive') ? 
                                device.description : 
                                'Imported from SiPortal',
                    status: 'active',
                    assigned_user_id: user_id,
                    organization_id: orgId,
                    manufacturer: device.type?.name || device.manufacturer || 'Unknown',
                    model: device.model || device.type?.name || 'Unknown',
                    serial_number: device.serialNumber || device.serial_number || '',
                    purchase_date: device.purchaseDate || null,
                    notes: `Imported from SiPortal
SiPortal ID: ${device.id}
Device Type: ${device.type?.name || 'Unknown'}
Host Name: ${device.hostName || device.hostname || 'Not specified'}
Domain/Realm: ${device.domain || device.realm || 'Not specified'}
Facility: ${typeof device.facility === 'object' ? (device.facility?.name || 'Not specified') : (device.facility || 'Not specified')}
Username: ${device.username || device.user || 'Not specified'}
Preferred Access: ${device.preferredAccess || device.preferred_access || device.accessMethod || 'Not specified'}
Credentials: ${device.credentials || device.credential || 'Not specified'}
Status: ${device.status || 'Active'}
Assigned User: ${device.assignedUser || device.assigned_user || 'Unassigned'}`,
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
 * GET /api/preview-siportal-import?user_id=123 or ?organization_id=456
 * NOW SUPPORTS ANY ORGANIZATION - dynamically finds matching company
 */
router.get('/preview-siportal-import', async (req, res) => {
    try {
        const { user_id, organization_id } = req.query;
        
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

        // Comprehensive company search with enhanced fuzzy matching
        console.log(`[Preview] Searching SiPortal for organization: "${orgName}"`);
        
        let allCompanies = [];
        let page = 1;
        let totalPages = 1;

        // Fetch all companies with proper pagination
        while (page <= 20) { // Safety limit
            const companiesResponse = await fetch(`https://www.siportal.net/api/2.0/companies?page=${page}`, {
                method: 'GET',
                headers: {
                    'Authorization': process.env.SIPORTAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            if (!companiesResponse.ok) {
                throw new Error(`SiPortal Companies API returned ${companiesResponse.status}: ${companiesResponse.statusText}`);
            }

            const companiesData = await companiesResponse.json();
            const companies = companiesData.data?.results || [];
            
            if (companies.length === 0) {
                console.log(`[Preview] Page ${page}: No companies found, stopping pagination`);
                break;
            }
            
            allCompanies.push(...companies);
            console.log(`[Preview] Page ${page}: Found ${companies.length} companies (total: ${allCompanies.length})`);
            
            // Check pagination metadata
            const hasMore = companiesData.meta?.has_more || 
                          companiesData.pagination?.has_more ||
                          companiesData.data?.has_more;
            
            if (hasMore === false) {
                console.log(`[Preview] Reached last page based on API metadata`);
                break;
            }
            
            page++;
        }

        // Enhanced fuzzy matching
        const searchName = orgName.toLowerCase().trim();
        let matchingCompany = null;
        let matchScore = 0;

        for (const company of allCompanies) {
            const companyName = company.name?.toLowerCase().trim();
            if (!companyName) continue;

            let currentScore = 0;

            // Exact match
            if (companyName === searchName) {
                matchingCompany = company;
                matchScore = 100;
                break;
            }

            // Clean match (remove suffixes)
            const cleanCompany = companyName.replace(/[,.]?\s*(llc|inc|corp|ltd|limited)\.?$/i, '').trim();
            const cleanSearch = searchName.replace(/[,.]?\s*(llc|inc|corp|ltd|limited)\.?$/i, '').trim();
            
            if (cleanCompany === cleanSearch) {
                currentScore = 90;
            } else if (cleanCompany.includes(cleanSearch) || cleanSearch.includes(cleanCompany)) {
                currentScore = 70;
            } else {
                // Word-based matching
                const companyWords = cleanCompany.split(/\s+/);
                const searchWords = cleanSearch.split(/\s+/);
                const matchingWords = searchWords.filter(word => 
                    companyWords.some(cWord => cWord.includes(word) || word.includes(cWord))
                );
                
                if (matchingWords.length === searchWords.length && searchWords.length > 1) {
                    currentScore = 60;
                } else if (matchingWords.length > 0) {
                    currentScore = 30;
                }
            }

            if (currentScore > matchScore) {
                matchingCompany = company;
                matchScore = currentScore;
            }
        }

        if (!matchingCompany || matchScore < 50) {
            console.log(`[Preview] No good match found for "${orgName}" (best score: ${matchScore})`);
            return res.status(404).json({
                error: 'No matching company found',
                message: `No matching IT Portal company found for organization "${orgName}"`,
                total_companies_searched: allCompanies.length,
                sample_companies: allCompanies.slice(0, 20).map(c => c.name)
            });
        }

        console.log(`[Preview] Match found: "${matchingCompany.name}" (ID: ${matchingCompany.id}, Score: ${matchScore})`);

        // Step 3: Fetch devices from SiPortal
        const response = await fetch(`https://www.siportal.net/api/2.0/devices?companyId=${matchingCompany.id}`, {
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

        // Preview what would be imported with improved field mapping
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
                username: device.username || device.user || '',
                preferred_access: device.preferredAccess || device.preferred_access || device.accessMethod || '',
                credentials: device.credentials || device.credential || '',
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
        
        // Try to fetch devices for this specific company ID
        const devicesResponse = await fetch(`https://www.siportal.net/api/2.0/devices?companyId=${companyId}`, {
            method: 'GET',
            headers: {
                'Authorization': process.env.SIPORTAL_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (!devicesResponse.ok) {
            throw new Error(`SiPortal Devices API returned ${devicesResponse.status}: ${devicesResponse.statusText}`);
        }

        const devicesData = await devicesResponse.json();
        const deviceCount = devicesData.data?.results?.length || 0;
        
        console.log(`[Debug] Company ${companyId} has ${deviceCount} devices`);
        
        // Also try to find this company in the companies list
        let companyInfo = null;
        let page = 1;
        let found = false;
        
        while (page <= 25 && !found) { // Search up to 25 pages
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
            device_count: deviceCount,
            company_info: companyInfo,
            found_on_page: found ? page - 1 : null,
            searched_pages: page - 1
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

module.exports = router;