// routes/api.js
// This file defines all the API endpoints and calls the appropriate service functions.

const express = require('express');
const router = express.Router();
const zendeskService = require('../services/zendesk');
const googleSheetsService = require('../services/googleSheets');

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

        // Step 1: Comprehensive company search with proper pagination
        console.log(`[API] Searching SiPortal for organization: "${orgName}"`);
        
        let allCompanies = [];
        let page = 1;
        let maxPages = 20; // Safety limit to prevent infinite loops

        // Fetch all companies with pagination - handle SiPortal's actual pagination behavior
        while (page <= maxPages) {
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
                // No more companies, break the loop
                console.log(`[API] Page ${page}: No companies found, stopping pagination`);
                break;
            }
            
            allCompanies.push(...companies);
            console.log(`[API] Page ${page}: Found ${companies.length} companies (total: ${allCompanies.length})`);
            
            // Check if there's pagination metadata
            const hasMore = companiesData.meta?.has_more || 
                          companiesData.pagination?.has_more ||
                          companiesData.data?.has_more;
            
            const totalPages = companiesData.meta?.total_pages || 
                             companiesData.pagination?.total_pages;
            
            // More robust pagination detection
            if (hasMore === false || (totalPages && page >= totalPages)) {
                console.log(`[API] Reached last page based on API metadata`);
                break;
            }
            
            // If we consistently get the same number of companies (likely page size), continue
            // Only stop if we get 0 companies or if we've reached reasonable limits
            if (page >= 20) { // Safety: Don't go beyond 20 pages
                console.log(`[API] Reached page limit of 20, stopping`);
                break;
            }
            
            page++;
        }

        console.log(`[API] Total companies retrieved: ${allCompanies.length} across ${page} pages`);

        // Step 2: Enhanced fuzzy matching with scoring
        const searchName = orgName.toLowerCase().trim();
        let matchingCompany = null;
        let matchScore = 0;
        let allMatches = []; // For debugging

        for (const company of allCompanies) {
            const companyName = company.name?.toLowerCase().trim();
            if (!companyName) continue;

            let currentScore = 0;

            // Strategy 1: Exact match (highest score)
            if (companyName === searchName) {
                matchingCompany = company;
                matchScore = 100;
                console.log(`[API] Exact match found: "${company.name}" (ID: ${company.id})`);
                break;
            }

            // Strategy 2: Clean match (remove suffixes and punctuation)
            const cleanCompany = companyName.replace(/[,.]?\s*(llc|inc|corp|ltd|limited)\.?$/i, '').trim();
            const cleanSearch = searchName.replace(/[,.]?\s*(llc|inc|corp|ltd|limited)\.?$/i, '').trim();
            
            if (cleanCompany === cleanSearch) {
                currentScore = 90;
            }
            // Strategy 3: Clean substring match
            else if (cleanCompany.includes(cleanSearch) || cleanSearch.includes(cleanCompany)) {
                currentScore = 70;
            }
            // Strategy 4: Word-based matching (all words present)
            else {
                const companyWords = cleanCompany.split(/\s+/).filter(w => w.length > 0);
                const searchWords = cleanSearch.split(/\s+/).filter(w => w.length > 0);
                const matchingWords = searchWords.filter(word => 
                    companyWords.some(cWord => 
                        cWord.includes(word) || word.includes(cWord) ||
                        // Handle common abbreviations
                        (word === 'home' && cWord.includes('home')) ||
                        (word === 'keep' && cWord.includes('keep'))
                    )
                );
                
                if (matchingWords.length === searchWords.length && searchWords.length > 1) {
                    currentScore = 60;
                } else if (matchingWords.length >= Math.ceil(searchWords.length * 0.6)) {
                    // At least 60% of words match
                    currentScore = 40;
                } else if (matchingWords.length > 0) {
                    currentScore = 20;
                }
            }

            // Keep track of all potential matches for debugging
            if (currentScore > 0) {
                allMatches.push({
                    name: company.name,
                    id: company.id,
                    score: currentScore
                });
            }

            // Keep track of the best match
            if (currentScore > matchScore) {
                matchingCompany = company;
                matchScore = currentScore;
            }
        }

        // Log top matches for debugging
        console.log(`[API] Top 5 potential matches:`, 
            allMatches
                .sort((a, b) => b.score - a.score)
                .slice(0, 5)
                .map(m => `"${m.name}" (ID: ${m.id}, Score: ${m.score})`)
        );

        if (!matchingCompany || matchScore < 40) { // Lowered threshold for better matching
            console.log(`[API] No good match found for "${orgName}" (best score: ${matchScore})`);
            console.log(`[API] Total companies searched: ${allCompanies.length}`);
            console.log(`[API] First 20 companies:`, allCompanies.slice(0, 20).map(c => `"${c.name}"`).join(', '));
            
            // Check if "Keep Me Home" appears anywhere in the company names
            const homeMatches = allCompanies.filter(c => 
                c.name?.toLowerCase().includes('keep') || 
                c.name?.toLowerCase().includes('home')
            );
            
            if (homeMatches.length > 0) {
                console.log(`[API] Companies containing 'keep' or 'home':`, homeMatches.map(c => `"${c.name}" (ID: ${c.id})`));
            }
            
            return res.json({ 
                assets: [],
                message: `No matching IT Portal company found for "${orgName}"`,
                total_companies_searched: allCompanies.length,
                top_matches: allMatches.sort((a, b) => b.score - a.score).slice(0, 10),
                sample_companies: allCompanies.slice(0, 30).map(c => c.name)
            });
        }

        console.log(`[API] Best match: "${matchingCompany.name}" (ID: ${matchingCompany.id}, Score: ${matchScore})`);

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
        console.log(`[API] SiPortal response: ${siPortalData.data?.results?.length || 0} devices for ${matchingCompany.name}`);
        
        // Transform SiPortal device data
        const assets = (siPortalData.data?.results || []).map(device => ({
            id: device.id,
            asset_tag: device.name || device.hostName || device.id,
            description: `${device.name || ''} ${device.hostName || ''}`.trim() || 'IT Portal Device',
            manufacturer: device.type?.name || 'Unknown',
            model: device.type?.name || 'Unknown',
            status: 'active', // Adjust based on actual device status field
            source: 'SiPortal',
            imported_date: new Date().toISOString(),
            notes: device.notes || '',
            serial_number: device.serialNumber,
            device_type: device.type?.name,
            assigned_user: device.assignedUser,
            // Include company info for debugging
            company_name: matchingCompany.name,
            company_id: matchingCompany.id
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

                // Create asset data
                const assetData = {
                    name: device.name || device.hostName || `Device ${device.id}`,
                    asset_tag: device.name || device.hostName || device.id,
                    description: `${device.name || ''} ${device.hostName || ''}`.trim() || 'Imported from SiPortal',
                    status: 'active',
                    assigned_user_id: user_id,
                    organization_id: orgId,
                    manufacturer: device.type?.name || 'Unknown',
                    model: device.type?.name || 'Unknown',
                    serial_number: device.serialNumber || '',
                    purchase_date: device.purchaseDate || null,
                    notes: `Imported from SiPortal\nSiPortal ID: ${device.id}\nDevice Type: ${device.type?.name || 'Unknown'}\nAssigned User: ${device.assignedUser || 'Unassigned'}`,
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

        // Preview what would be imported
        const preview = devices.map(device => {
            const assetExists = existingAssets?.some(asset => 
                asset.serial_number === device.serialNumber ||
                (asset.notes && asset.notes.includes(`SiPortal ID: ${device.id}`))
            );

            return {
                device_id: device.id,
                name: device.name || device.hostName || `Device ${device.id}`,
                serial_number: device.serialNumber || '',
                device_type: device.type?.name || 'Unknown',
                assigned_user: device.assignedUser || 'Unassigned',
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

module.exports = router;