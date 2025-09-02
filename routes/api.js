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
 * This is now optional/secondary - primary method is direct company ID
 */
let companiesCache = {
    companies: [],
    lastUpdated: null,
    isUpdating: false
};

/**
 * Refresh the companies cache (optional - for company lookup helper)
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
        let hasMore = true;
        
        while (hasMore && page <= 100) { // Increased limit for complete coverage
            const response = await fetch(`https://www.siportal.net/api/2.0/companies?page=${page}&per_page=50`, {
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
            const companies = data.data?.results || data.data || [];
            
            if (companies.length === 0) {
                hasMore = false;
                console.log(`[Cache] No more companies at page ${page}`);
            } else {
                allCompanies.push(...companies);
                
                // Log progress every 10 pages
                if (page % 10 === 0) {
                    console.log(`[Cache] Page ${page}: ${companies.length} companies (total: ${allCompanies.length})`);
                }
                
                // Check for pagination indicators
                hasMore = data.meta?.has_more || data.pagination?.has_more || companies.length === 50;
            }
            
            page++;
            
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        companiesCache.companies = allCompanies;
        companiesCache.lastUpdated = new Date();
        console.log(`[Cache] Updated companies cache with ${allCompanies.length} companies from ${page-1} pages`);
        
        // Log some sample company names for debugging
        if (allCompanies.length > 0) {
            console.log(`[Cache] Sample companies:`, allCompanies.slice(0, 5).map(c => c.name).join(', '));
        }
        
    } catch (error) {
        console.error('[Cache] Error refreshing companies cache:', error.message);
    } finally {
        companiesCache.isUpdating = false;
    }
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
 * Endpoint to list all SiPortal companies (for company lookup helper)
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
 * SIMPLIFIED IT Portal Assets endpoint
 * Now primarily uses direct company_id parameter
 * Falls back to organization lookup only when needed
 */
router.get('/it-portal-assets', async (req, res) => {
    try {
        const { company_id, user_id } = req.query;
        
        // PRIMARY METHOD: Direct company_id usage
        if (company_id) {
            console.log(`[API] Fetching SiPortal devices for company ID: ${company_id}`);
            
            const response = await fetch(`https://www.siportal.net/api/2.0/devices?companyId=${company_id}`, {
                method: 'GET',
                headers: {
                    'Authorization': process.env.SIPORTAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                // Handle specific error cases
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
            
            console.log(`[API] Found ${devices.length} devices for company ID ${company_id}`);
            
            // Transform SiPortal device data to standard format
            const assets = devices.map(device => ({
                // Basic identification
                id: device.id,
                asset_tag: device.name || device.hostName || device.id,
                
                // IT Portal specific fields
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
                status: device.status || 
                       (device.description && (device.description.toLowerCase() === 'active' || device.description.toLowerCase() === 'inactive') ? 
                        device.description.toLowerCase() : 'active'),
                
                // Metadata fields
                source: 'SiPortal',
                imported_date: new Date().toISOString(),
                notes: Array.isArray(device.notes) ? device.notes.join(', ') : (device.notes || ''),
                assigned_user: device.assignedUser || device.assigned_user || '',
                
                // Company info
                company_id: company_id,
                
                // Additional fields
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
        
        // FALLBACK METHOD: Look up company ID from user's organization
        if (user_id) {
            console.log(`[API] Looking up IT Portal Company ID for user: ${user_id}`);
            
            const user = await zendeskService.getUserById(user_id);
            if (!user.organization_id) {
                return res.json({ 
                    assets: [],
                    message: 'User has no organization associated',
                    error_type: 'no_organization'
                });
            }

            const organization = await zendeskService.getOrganizationById(user.organization_id);
            const itPortalCompanyId = organization?.organization_fields?.it_portal_company_id;
            
            if (!itPortalCompanyId) {
                return res.json({ 
                    assets: [],
                    message: 'No IT Portal Company ID configured for this organization',
                    organization: {
                        id: user.organization_id,
                        name: organization?.name
                    },
                    error_type: 'no_company_id_configured'
                });
            }
            
            // Recursively call with company_id
            req.query.company_id = itPortalCompanyId;
            delete req.query.user_id; // Remove user_id to avoid recursion
            return router.handle(req, res);
        }
        
        // No valid parameters provided
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

// Initialize companies cache on startup (optional - for company lookup helper)
if (process.env.SIPORTAL_API_KEY) {
    // Start cache refresh in background
    refreshCompaniesCache().catch(err => 
        console.error('[Startup] Initial cache refresh failed:', err.message)
    );
}

module.exports = router;