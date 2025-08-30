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
 * Refresh the companies cache - UPDATED to fetch ALL companies
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
        const seenIds = new Set(); // Prevent duplicates
        
        while (page <= 100) { // Increased safety limit from 50 to 100 pages
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
                if (consecutiveEmptyPages >= 3) { // Stop after 3 consecutive empty pages
                    console.log(`[Cache] Three consecutive empty pages, stopping at page ${page}`);
                    break;
                }
            } else {
                consecutiveEmptyPages = 0;
                
                // Only add unique companies
                let newCompanies = 0;
                companies.forEach(company => {
                    if (!seenIds.has(company.id)) {
                        seenIds.add(company.id);
                        allCompanies.push(company);
                        newCompanies++;
                    }
                });
                
                // Log every 10th page for progress tracking
                if (page % 10 === 0) {
                    console.log(`[Cache] Page ${page}: ${companies.length} companies, ${newCompanies} new (total unique: ${allCompanies.length})`);
                }
            }
            
            page++;
            
            // Add small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        companiesCache.companies = allCompanies;
        companiesCache.lastUpdated = new Date();
        console.log(`[Cache] Updated companies cache with ${allCompanies.length} unique companies from ${page-1} pages`);
        
        // Log some sample company names for debugging
        console.log(`[Cache] Sample companies:`, allCompanies.slice(0, 5).map(c => c.name).join(', '));
        
        // Log categories for verification
        const universitiesCount = allCompanies.filter(c => 
            c.name && (c.name.toLowerCase().includes('university') || c.name.toLowerCase().includes('college'))
        ).length;
        const healthCount = allCompanies.filter(c => 
            c.name && (c.name.toLowerCase().includes('health') || c.name.toLowerCase().includes('medical'))
        ).length;
        
        console.log(`[Cache] Categories: ${universitiesCount} universities/colleges, ${healthCount} health/medical organizations`);
        
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
 * Enhanced search with multiple strategies - FIXED VERSION
 */
function searchCompaniesInCache(orgName) {
    const variations = generateNameVariations(orgName);
    let bestMatch = null;
    let bestScore = 0;
    let matchMethod = '';

    console.log(`[Search] Searching for: "${orgName}"`);
    console.log(`[Search] Generated variations:`, variations);

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
                console.log(`[Search] EXACT MATCH: "${companyName}" === "${variation}"`);
                return { company, score: 100, method: 'normalized_exact' };
            }

            // FIXED: Much stricter substring matching
            const minLength = Math.min(normalizedCompany.length, variation.length);
            const maxLength = Math.max(normalizedCompany.length, variation.length);
            const lengthRatio = minLength / maxLength;

            if (normalizedCompany.includes(variation) || variation.includes(normalizedCompany)) {
                // Only accept substring matches if:
                // 1. The shorter string is at least 70% of the longer string, OR
                // 2. The shorter string is at least 10 characters long AND 50% ratio
                if (lengthRatio >= 0.7 || (minLength >= 10 && lengthRatio >= 0.5)) {
                    score = Math.max(score, 85);
                    method = 'strict_substring';
                    console.log(`[Search] STRICT SUBSTRING: "${companyName}" <-> "${variation}" (ratio: ${lengthRatio.toFixed(2)})`);
                } else {
                    // Give a much lower score for weak substring matches
                    score = Math.max(score, 35);
                    method = 'weak_substring';
                    console.log(`[Search] WEAK SUBSTRING (rejected): "${companyName}" <-> "${variation}" (ratio: ${lengthRatio.toFixed(2)})`);
                }
            }

            // Word-based similarity - UNCHANGED
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
                    const wordScore = 70 + (matchRatio - 0.7) * 50;
                    if (wordScore > score) {
                        score = wordScore;
                        method = 'word_similarity';
                        console.log(`[Search] WORD MATCH: "${companyName}" <-> "${variation}" (ratio: ${matchRatio.toFixed(2)})`);
                    }
                }
            }

            // Levenshtein distance for close matches - UNCHANGED
            if (score === 0 && variation.length > 3 && normalizedCompany.length > 3) {
                const distance = levenshteinDistance(variation, normalizedCompany);
                const maxLen = Math.max(variation.length, normalizedCompany.length);
                const similarity = 1 - (distance / maxLen);
                
                if (similarity >= 0.8) {
                    score = similarity * 60;
                    method = 'edit_distance';
                    console.log(`[Search] EDIT DISTANCE: "${companyName}" <-> "${variation}" (similarity: ${similarity.toFixed(2)})`);
                }
            }

            if (score > bestScore) {
                bestMatch = company;
                bestScore = score;
                matchMethod = method;
                console.log(`[Search] NEW BEST: "${companyName}" with score ${score.toFixed(1)} (${method})`);
            }
        }
    }

    // RAISED threshold from 60 to 75 to prevent false matches
    if (bestMatch && bestScore >= 75) {
        console.log(`[Search] FINAL MATCH: "${bestMatch.name}" with score ${bestScore.toFixed(1)} (${matchMethod})`);
        return { company: bestMatch, score: bestScore, method: matchMethod };
    } else {
        console.log(`[Search] NO GOOD MATCH: Best was "${bestMatch?.name}" with score ${bestScore.toFixed(1)} (threshold: 75)`);
        return null;
    }
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
 * Debug function to see what companies are available in cache
 */
function debugCompanySearch(searchTerm) {
    console.log(`[Debug] Searching for: "${searchTerm}"`);
    console.log(`[Debug] Cache has ${companiesCache.companies.length} companies`);
    
    // Show companies that contain any word from the search term
    const searchWords = searchTerm.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const candidates = [];
    
    for (const company of companiesCache.companies) {
        if (!company.name) continue;
        
        const companyName = company.name.toLowerCase();
        const matchingWords = searchWords.filter(word => 
            companyName.includes(word)
        );
        
        if (matchingWords.length > 0) {
            candidates.push({
                id: company.id,
                name: company.name,
                matchingWords: matchingWords,
                score: (matchingWords.length / searchWords.length) * 100
            });
        }
    }
    
    // Sort by score and show top 15 candidates
    candidates.sort((a, b) => b.score - a.score);
    console.log(`[Debug] Top 15 candidates for "${searchTerm}":`, 
        candidates.slice(0, 15).map(c => `${c.name} (${c.matchingWords.join(', ')}) - ${c.score}%`)
    );
    
    return candidates;
}

/**
 * COMPLETE Debug endpoint - fetches ALL companies from SiPortal
 * GET /api/debug-siportal-companies?search=university
 */
router.get('/debug-siportal-companies', async (req, res) => {
    try {
        const searchTerm = req.query.search || '';
        const maxPages = parseInt(req.query.maxPages) || 50; // Safety limit, can be increased
        
        console.log(`[Debug] Searching ALL SiPortal companies for: "${searchTerm}"`);
        
        let allCompanies = [];
        const seenIds = new Set();
        let page = 1;
        let consecutiveEmptyPages = 0;
        
        while (page <= maxPages) {
            console.log(`[Debug] Fetching page ${page}...`);
            
            const response = await fetch(`https://www.siportal.net/api/2.0/companies?page=${page}`, {
                method: 'GET',
                headers: {
                    'Authorization': process.env.SIPORTAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.error(`[Debug] API error on page ${page}: ${response.status}`);
                break;
            }

            const data = await response.json();
            const companies = data.data?.results || [];
            
            if (companies.length === 0) {
                consecutiveEmptyPages++;
                console.log(`[Debug] Page ${page}: Empty page (${consecutiveEmptyPages}/3)`);
                
                // Stop after 3 consecutive empty pages
                if (consecutiveEmptyPages >= 3) {
                    console.log(`[Debug] Stopping at page ${page} - 3 consecutive empty pages`);
                    break;
                }
            } else {
                consecutiveEmptyPages = 0;
                
                // Only add unique companies
                let newCompanies = 0;
                companies.forEach(company => {
                    if (!seenIds.has(company.id)) {
                        seenIds.add(company.id);
                        allCompanies.push(company);
                        newCompanies++;
                    }
                });
                
                console.log(`[Debug] Page ${page}: ${companies.length} companies, ${newCompanies} new (total unique: ${allCompanies.length})`);
            }
            
            page++;
            
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log(`[Debug] FINAL: Fetched ${allCompanies.length} unique companies from ${page-1} pages`);
        
        // Sort companies by name for easier browsing
        allCompanies.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        
        // Filter companies if search term provided
        let filteredCompanies = allCompanies;
        if (searchTerm) {
            const lowerSearch = searchTerm.toLowerCase();
            filteredCompanies = allCompanies.filter(company => 
                company.name && company.name.toLowerCase().includes(lowerSearch)
            );
        }
        
        // Show results (limit to 200 for display, but include count)
        const results = filteredCompanies.slice(0, 200).map(company => ({
            id: company.id,
            name: company.name
        }));
        
        // Also show some sample companies by category for quick analysis
        const universitiesAndColleges = allCompanies.filter(c => 
            c.name && (c.name.toLowerCase().includes('university') || 
                      c.name.toLowerCase().includes('college') ||
                      c.name.toLowerCase().includes('school'))
        ).slice(0, 10);
        
        const healthAndMedical = allCompanies.filter(c => 
            c.name && (c.name.toLowerCase().includes('health') || 
                      c.name.toLowerCase().includes('medical') ||
                      c.name.toLowerCase().includes('hospital'))
        ).slice(0, 10);
        
        const governmentAndAuthorities = allCompanies.filter(c => 
            c.name && (c.name.toLowerCase().includes('authority') || 
                      c.name.toLowerCase().includes('government') ||
                      c.name.toLowerCase().includes('city') ||
                      c.name.toLowerCase().includes('county'))
        ).slice(0, 10);
        
        res.json({
            success: true,
            searchTerm: searchTerm,
            totalCompanies: allCompanies.length,
            filteredCompanies: filteredCompanies.length,
            showing: results.length,
            pagesSearched: page - 1,
            companies: results,
            samples: {
                universities: universitiesAndColleges.map(c => ({ id: c.id, name: c.name })),
                health: healthAndMedical.map(c => ({ id: c.id, name: c.name })),
                government: governmentAndAuthorities.map(c => ({ id: c.id, name: c.name }))
            }
        });
        
    } catch (error) {
        console.error('[Debug] Error fetching SiPortal companies:', error.message);
        res.status(500).json({
            error: 'Failed to fetch companies',
            details: error.message
        });
    }
});

/**
 * DIAGNOSTIC endpoint to debug SiPortal pagination issues
 * GET /api/debug-siportal-pagination
 */
router.get('/debug-siportal-pagination', async (req, res) => {
    try {
        console.log(`[Diagnostic] Testing SiPortal pagination...`);
        
        const results = [];
        
        // Test first 5 pages and examine the responses in detail
        for (let page = 1; page <= 5; page++) {
            console.log(`[Diagnostic] Testing page ${page}...`);
            
            const response = await fetch(`https://www.siportal.net/api/2.0/companies?page=${page}`, {
                method: 'GET',
                headers: {
                    'Authorization': process.env.SIPORTAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                results.push({
                    page: page,
                    error: `API returned ${response.status}: ${response.statusText}`
                });
                continue;
            }

            const data = await response.json();
            const companies = data.data?.results || [];
            
            // Get detailed info about this page
            const pageInfo = {
                page: page,
                companies_count: companies.length,
                companies: companies.map(c => ({ id: c.id, name: c.name })),
                
                // Check for pagination metadata
                meta: data.meta || null,
                pagination: data.pagination || null,
                links: data.links || null,
                
                // Raw response structure (first 3 keys only to avoid huge output)
                raw_structure: Object.keys(data).slice(0, 10),
                
                // Check if any company IDs repeat from page 1
                repeated_from_page_1: page > 1 ? 
                    companies.filter(c => results[0]?.companies?.some(p1c => p1c.id === c.id)).length : 
                    0
            };
            
            results.push(pageInfo);
            
            console.log(`[Diagnostic] Page ${page}: ${companies.length} companies, ${pageInfo.repeated_from_page_1} repeated from page 1`);
        }
        
        // Try different pagination approaches
        console.log(`[Diagnostic] Testing alternative pagination methods...`);
        
        const alternatives = [];
        
        // Method 1: Try offset/limit instead of page
        try {
            const offsetResponse = await fetch(`https://www.siportal.net/api/2.0/companies?offset=20&limit=20`, {
                method: 'GET',
                headers: {
                    'Authorization': process.env.SIPORTAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });
            
            if (offsetResponse.ok) {
                const offsetData = await offsetResponse.json();
                alternatives.push({
                    method: 'offset/limit',
                    success: true,
                    companies_count: offsetData.data?.results?.length || 0,
                    raw_structure: Object.keys(offsetData)
                });
            } else {
                alternatives.push({
                    method: 'offset/limit',
                    success: false,
                    error: `${offsetResponse.status}: ${offsetResponse.statusText}`
                });
            }
        } catch (err) {
            alternatives.push({
                method: 'offset/limit',
                success: false,
                error: err.message
            });
        }
        
        // Method 2: Try per_page parameter
        try {
            const perPageResponse = await fetch(`https://www.siportal.net/api/2.0/companies?page=2&per_page=20`, {
                method: 'GET',
                headers: {
                    'Authorization': process.env.SIPORTAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });
            
            if (perPageResponse.ok) {
                const perPageData = await perPageResponse.json();
                alternatives.push({
                    method: 'page/per_page',
                    success: true,
                    companies_count: perPageData.data?.results?.length || 0,
                    raw_structure: Object.keys(perPageData)
                });
            } else {
                alternatives.push({
                    method: 'page/per_page',
                    success: false,
                    error: `${perPageResponse.status}: ${perPageResponse.statusText}`
                });
            }
        } catch (err) {
            alternatives.push({
                method: 'page/per_page',
                success: false,
                error: err.message
            });
        }
        
        res.json({
            success: true,
            diagnosis: "SiPortal API pagination test",
            page_results: results,
            alternative_methods: alternatives,
            summary: {
                total_unique_companies: [...new Set(results.flatMap(r => r.companies?.map(c => c.id) || []))].length,
                pages_with_data: results.filter(r => r.companies_count > 0).length,
                pagination_appears_broken: results.length > 1 && results.every((r, i) => i === 0 || r.repeated_from_page_1 === r.companies_count),
                recommendation: results.length > 1 && results.every((r, i) => i === 0 || r.repeated_from_page_1 === r.companies_count) ? 
                    "API pagination is broken - same results on every page" : 
                    "Pagination might be working"
            }
        });
        
    } catch (error) {
        console.error('[Diagnostic] Error testing pagination:', error.message);
        res.status(500).json({
            error: 'Failed to test pagination',
            details: error.message
        });
    }
});

/**
 * SIMPLE endpoint to get companies without pagination (just page 1)
 * GET /api/debug-siportal-simple
 */
router.get('/debug-siportal-simple', async (req, res) => {
    try {
        console.log(`[Simple] Fetching companies from page 1 only...`);
        
        const response = await fetch(`https://www.siportal.net/api/2.0/companies?page=1`, {
            method: 'GET',
            headers: {
                'Authorization': process.env.SIPORTAL_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`SiPortal API returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log(`[Simple] Raw API response structure:`, Object.keys(data));
        console.log(`[Simple] Companies array length:`, data.data?.results?.length || 0);
        console.log(`[Simple] Sample company:`, JSON.stringify(data.data?.results?.[0], null, 2));
        
        const companies = data.data?.results || [];
        
        res.json({
            success: true,
            message: "Single page fetch from SiPortal",
            raw_response_keys: Object.keys(data),
            meta: data.meta || null,
            pagination: data.pagination || null,
            total_companies: companies.length,
            companies: companies.map(c => ({ id: c.id, name: c.name }))
        });
        
    } catch (error) {
        console.error('[Simple] Error fetching companies:', error.message);
        res.status(500).json({
            error: 'Failed to fetch companies',
            details: error.message
        });
    }
});

/**
 * COMPREHENSIVE pagination testing for SiPortal API
 * Tests all common pagination parameter combinations
 * GET /api/debug-all-pagination-methods
 */
router.get('/debug-all-pagination-methods', async (req, res) => {
    try {
        console.log(`[Comprehensive] Testing all possible pagination methods...`);
        
        const testCases = [
            // Standard pagination patterns
            { name: "page_only", params: "page=2" },
            { name: "page_per_page", params: "page=2&per_page=20" },
            { name: "page_limit", params: "page=2&limit=20" },
            { name: "page_size", params: "page=2&size=20" },
            { name: "page_count", params: "page=2&count=20" },
            
            // Offset/limit patterns
            { name: "offset_limit", params: "offset=20&limit=20" },
            { name: "skip_take", params: "skip=20&take=20" },
            { name: "start_limit", params: "start=20&limit=20" },
            
            // Higher limits to test max page size
            { name: "large_limit", params: "page=1&limit=100" },
            { name: "max_limit", params: "page=1&limit=500" },
            { name: "huge_limit", params: "page=1&limit=1000" },
            
            // Alternative API versions
            { name: "v1_page", params: "page=2", version: "1.0" },
            
            // Search/filter parameters that might return more
            { name: "all_companies", params: "all=true" },
            { name: "include_inactive", params: "include_inactive=true&page=2" },
            { name: "status_all", params: "status=all&page=2" },
            
            // Sort parameters that might affect results
            { name: "sort_name", params: "page=2&sort=name" },
            { name: "sort_id", params: "page=2&sort=id" },
            { name: "order_by_name", params: "page=2&orderby=name" },
        ];
        
        const results = [];
        
        for (const testCase of testCases) {
            console.log(`[Comprehensive] Testing: ${testCase.name} (${testCase.params})`);
            
            try {
                const apiVersion = testCase.version || "2.0";
                const url = `https://www.siportal.net/api/${apiVersion}/companies?${testCase.params}`;
                
                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    const companies = data.data?.results || [];
                    
                    // Check if companies are different from our known "page 1" set
                    const knownPage1Ids = [3495, 3496, 3497, 3498, 3499]; // First 5 IDs from page 1
                    const hasDifferentCompanies = companies.some(c => !knownPage1Ids.includes(c.id));
                    
                    const result = {
                        test: testCase.name,
                        params: testCase.params,
                        url: url,
                        success: true,
                        companies_count: companies.length,
                        has_different_companies: hasDifferentCompanies,
                        first_company_id: companies[0]?.id,
                        first_company_name: companies[0]?.name,
                        unique_score: hasDifferentCompanies ? "UNIQUE" : "DUPLICATE"
                    };
                    
                    results.push(result);
                    console.log(`[Comprehensive] ${testCase.name}: ${companies.length} companies, ${result.unique_score}`);
                    
                } else {
                    results.push({
                        test: testCase.name,
                        params: testCase.params,
                        url: url,
                        success: false,
                        error: `${response.status}: ${response.statusText}`,
                        companies_count: 0,
                        unique_score: "ERROR"
                    });
                }
                
            } catch (err) {
                results.push({
                    test: testCase.name,
                    params: testCase.params,
                    success: false,
                    error: err.message,
                    companies_count: 0,
                    unique_score: "ERROR"
                });
            }
            
            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        // Analyze results
        const successful_tests = results.filter(r => r.success);
        const unique_results = results.filter(r => r.unique_score === "UNIQUE");
        const large_results = results.filter(r => r.companies_count > 20);
        
        res.json({
            success: true,
            method: "Comprehensive pagination parameter testing",
            total_tests: testCases.length,
            successful_tests: successful_tests.length,
            tests_with_unique_data: unique_results.length,
            tests_with_more_than_20: large_results.length,
            results: results,
            analysis: {
                working_pagination_methods: unique_results.map(r => r.test),
                larger_page_sizes: large_results.map(r => `${r.test}: ${r.companies_count} companies`),
                recommendation: unique_results.length > 0 ? 
                    `SUCCESS! Found working pagination: ${unique_results[0].params}` : 
                    "No working pagination found - API may be limited to 20 companies"
            }
        });
        
    } catch (error) {
        console.error('[Comprehensive] Error testing pagination methods:', error.message);
        res.status(500).json({
            error: 'Failed to test pagination methods',
            details: error.message
        });
    }
});

/**
 * Test specific pagination parameters from documentation
 * GET /api/debug-doc-pagination?method=PARAM_FROM_DOCS
 */
router.get('/debug-doc-pagination', async (req, res) => {
    try {
        const method = req.query.method;
        
        if (!method) {
            return res.json({
                error: "Missing method parameter",
                usage: "Add ?method=YOUR_PARAMS to test specific pagination from docs",
                examples: [
                    "?method=page=2&pageSize=50",
                    "?method=offset=20&max=50", 
                    "?method=start=20&rows=50"
                ]
            });
        }
        
        console.log(`[Doc Test] Testing documentation method: ${method}`);
        
        const url = `https://www.siportal.net/api/2.0/companies?${method}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': process.env.SIPORTAL_API_KEY,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            return res.json({
                success: false,
                method: method,
                url: url,
                error: `${response.status}: ${response.statusText}`
            });
        }
        
        const data = await response.json();
        const companies = data.data?.results || [];
        
        // Check if this returns different companies than page 1
        const knownPage1Ids = [3495, 3496, 3497, 3498, 3499];
        const hasDifferentCompanies = companies.some(c => !knownPage1Ids.includes(c.id));
        
        res.json({
            success: true,
            method: method,
            url: url,
            companies_count: companies.length,
            has_different_companies: hasDifferentCompanies,
            result: hasDifferentCompanies ? "SUCCESS - Found different companies!" : "Same companies as page 1",
            companies: companies.map(c => ({ id: c.id, name: c.name })),
            raw_response_structure: Object.keys(data),
            meta: data.meta || null,
            pagination: data.pagination || null
        });
        
    } catch (error) {
        console.error('[Doc Test] Error testing specific method:', error.message);
        res.status(500).json({
            error: 'Failed to test specific pagination method',
            details: error.message
        });
    }
});

/**
 * Alternative method to discover all companies through devices endpoint
 * Since /companies pagination is broken, we'll get companies from device records
 * GET /api/debug-companies-from-devices
 */
router.get('/debug-companies-from-devices', async (req, res) => {
    try {
        console.log(`[Alternative] Discovering companies through devices endpoint...`);
        
        const uniqueCompanies = new Map();
        let page = 1;
        let totalDevices = 0;
        let consecutiveEmptyPages = 0;
        
        // Fetch devices and extract company info
        while (page <= 50 && consecutiveEmptyPages < 3) {
            console.log(`[Alternative] Fetching devices page ${page}...`);
            
            const response = await fetch(`https://www.siportal.net/api/2.0/devices?page=${page}`, {
                method: 'GET',
                headers: {
                    'Authorization': process.env.SIPORTAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.log(`[Alternative] Devices API error on page ${page}: ${response.status}`);
                break;
            }

            const data = await response.json();
            const devices = data.data?.results || [];
            
            if (devices.length === 0) {
                consecutiveEmptyPages++;
                console.log(`[Alternative] Page ${page}: Empty page (${consecutiveEmptyPages}/3)`);
                continue;
            } else {
                consecutiveEmptyPages = 0;
            }
            
            // Extract unique companies from devices
            devices.forEach(device => {
                if (device.company && device.company.id) {
                    const companyId = device.company.id;
                    if (!uniqueCompanies.has(companyId)) {
                        uniqueCompanies.set(companyId, {
                            id: companyId,
                            name: device.company.name || `Company ${companyId}`,
                            device_count: 1
                        });
                    } else {
                        uniqueCompanies.get(companyId).device_count++;
                    }
                }
            });
            
            totalDevices += devices.length;
            console.log(`[Alternative] Page ${page}: ${devices.length} devices, ${uniqueCompanies.size} unique companies found`);
            
            page++;
            
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        const companiesArray = Array.from(uniqueCompanies.values());
        companiesArray.sort((a, b) => a.name.localeCompare(b.name));
        
        // Look for your target organizations
        const targetOrgs = ['simmons', 'university', 'college', 'health', 'medical', 'hospital', 'massport', 'beth', 'israel', 'lahey'];
        const matchingCompanies = companiesArray.filter(company => 
            targetOrgs.some(target => 
                company.name.toLowerCase().includes(target)
            )
        );
        
        console.log(`[Alternative] FINAL: Found ${companiesArray.length} companies from ${totalDevices} devices`);
        
        res.json({
            success: true,
            method: "Companies discovered through devices endpoint",
            total_devices_scanned: totalDevices,
            pages_scanned: page - 1,
            unique_companies_found: companiesArray.length,
            companies: companiesArray,
            target_matches: matchingCompanies,
            comparison_with_companies_endpoint: {
                companies_endpoint_total: 20,
                devices_endpoint_total: companiesArray.length,
                difference: companiesArray.length - 20,
                conclusion: companiesArray.length > 20 ? "Devices endpoint reveals more companies!" : "Same limited set"
            }
        });
        
    } catch (error) {
        console.error('[Alternative] Error discovering companies through devices:', error.message);
        res.status(500).json({
            error: 'Failed to discover companies through devices',
            details: error.message
        });
    }
});

/**
 * Test direct company searches for known organizations
 * GET /api/debug-test-direct-searches
 */
router.get('/debug-test-direct-searches', async (req, res) => {
    try {
        console.log(`[Direct Search Test] Testing direct searches for target organizations...`);
        
        // Test organizations that should have devices
        const testOrganizations = [
            'Simmons University',
            'Simmons College',
            'Beth Israel Lahey Health',
            'Lahey Health',
            'Beth Israel',
            'Massport',
            'Massachusetts Port Authority',
            'University of Massachusetts',
            'UMass',
            // Add some that we know exist from the 20 companies
            'Aetna Life Insurance',
            'Analog Devices'
        ];
        
        const results = [];
        
        for (const orgName of testOrganizations) {
            console.log(`[Direct Search Test] Testing: "${orgName}"`);
            
            try {
                const response = await fetch(`https://www.siportal.net/api/2.0/devices?company=${encodeURIComponent(orgName)}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': process.env.SIPORTAL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    const devices = data.data?.results || [];
                    
                    const result = {
                        organization: orgName,
                        success: true,
                        devices_found: devices.length,
                        company_info: devices.length > 0 ? devices[0].company : null
                    };
                    
                    results.push(result);
                    console.log(`[Direct Search Test] "${orgName}": ${devices.length} devices found`);
                } else {
                    results.push({
                        organization: orgName,
                        success: false,
                        error: `${response.status}: ${response.statusText}`,
                        devices_found: 0
                    });
                }
            } catch (err) {
                results.push({
                    organization: orgName,
                    success: false,
                    error: err.message,
                    devices_found: 0
                });
            }
            
            // Small delay between searches
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        const successful_searches = results.filter(r => r.success && r.devices_found > 0);
        const total_devices_found = successful_searches.reduce((sum, r) => sum + r.devices_found, 0);
        
        res.json({
            success: true,
            method: "Direct company name searches",
            organizations_tested: testOrganizations.length,
            successful_matches: successful_searches.length,
            total_devices_found: total_devices_found,
            results: results,
            summary: {
                organizations_with_devices: successful_searches.map(r => `${r.organization} (${r.devices_found} devices)`),
                recommendation: successful_searches.length > 0 ? 
                    "Direct search works! Use this method to find your target organizations" : 
                    "Target organizations not found - they may not be SiPortal customers"
            }
        });
        
    } catch (error) {
        console.error('[Direct Search Test] Error testing direct searches:', error.message);
        res.status(500).json({
            error: 'Failed to test direct searches',
            details: error.message
        });
    }
});

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
            
            // Step 3: Search in cache if available - FIXED VERSION
            if (companiesCache.companies.length > 0) {
                console.log(`[API] Searching in cache (${companiesCache.companies.length} companies)`);
                
                // ADD DEBUG LOGGING HERE
                debugCompanySearch(orgName);
                
                const cacheResult = searchCompaniesInCache(orgName);
                
                if (cacheResult) {
                    matchingCompany = cacheResult.company;
                    console.log(`[API] Cache match found: "${matchingCompany.name}" (ID: ${matchingCompany.id}, Score: ${cacheResult.score}, Method: ${cacheResult.method})`);
                } else {
                    console.log(`[API] No good cache match found for "${orgName}"`);
                }
            } else {
                console.log(`[API] No cache available, will try direct search`);
            }

            // Step 4: IMPROVED Direct Search with Multiple Variations
            if (!matchingCompany) {
                console.log(`[API] No match found in cache for "${orgName}", trying direct company search`);
                
                // Try multiple search variations
                const searchVariations = [
                    orgName,
                    orgName.replace(/[,.]?\s*(llc|inc|corp|ltd|limited|company|co\.).*$/i, '').trim(),
                    orgName.split(',')[0].trim(), // Take part before first comma
                    orgName.split('&')[0].trim(),  // Take part before &
                    orgName.replace(/\s+and\s+.*$/i, '').trim(), // Take part before " and "
                    orgName.replace(/.*\s+of\s+/, '').trim() // For "University of X" -> "X"
                ].filter(v => v.length > 2); // Remove empty or too short variations

                console.log(`[API] Will try these search variations:`, searchVariations);

                let foundDevices = [];
                let matchedCompanyInfo = null;

                for (const searchVariation of searchVariations) {
                    if (foundDevices.length > 0) break; // Stop if we found devices
                    
                    try {
                        console.log(`[API] Trying direct search with: "${searchVariation}"`);
                        
                        const directResponse = await fetch(`https://www.siportal.net/api/2.0/devices?company=${encodeURIComponent(searchVariation)}`, {
                            method: 'GET',
                            headers: {
                                'Authorization': process.env.SIPORTAL_API_KEY,
                                'Content-Type': 'application/json'
                            }
                        });
                        
                        if (directResponse.ok) {
                            const directData = await directResponse.json();
                            const devices = directData.data?.results || [];
                            
                            console.log(`[API] Direct search for "${searchVariation}" returned ${devices.length} devices`);
                            
                            if (devices.length > 0) {
                                foundDevices = devices;
                                // Extract company info from the first device
                                matchedCompanyInfo = devices[0].company || {
                                    id: `direct-${Date.now()}`,
                                    name: searchVariation
                                };
                                console.log(`[API] SUCCESS: Found ${devices.length} devices for "${searchVariation}"`);
                                
                                // Transform and return the devices immediately
                                const transformedAssets = devices.map(device => ({
                                    // Basic identification
                                    id: device.id,
                                    asset_tag: device.name || device.hostName || device.id,
                                    
                                    // IT Portal specific fields (matching your actual field names)
                                    device_type: device.type?.name || device.deviceType || 'Unknown',
                                    name: device.name || 'Unnamed Device',
                                    host_name: device.hostName || device.hostname || '',
                                    description: device.description || '', // FIXED: Show actual description
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
                                    company_name: matchedCompanyInfo.name,
                                    company_id: matchedCompanyInfo.id,
                                    
                                    // Additional fields that might be useful
                                    location: typeof device.location === 'object' ? (device.location?.name || '') : (device.location || ''),
                                    ip_address: device.ipAddress || device.ip_address || '',
                                    mac_address: device.macAddress || device.mac_address || '',
                                    os: device.operatingSystem || device.os || '',
                                    last_seen: device.lastSeen || device.last_seen || ''
                                }));
                                
                                console.log(`[API] Returning ${transformedAssets.length} devices via direct search for "${searchVariation}"`);
                                return res.json({
                                    assets: transformedAssets,
                                    company: {
                                        name: matchedCompanyInfo.name,
                                        id: matchedCompanyInfo.id
                                    },
                                    organization: {
                                        name: orgName,
                                        id: user.organization_id
                                    },
                                    search_method: 'direct_search',
                                    matched_variation: searchVariation
                                });
                            }
                        } else {
                            console.log(`[API] Direct search failed for "${searchVariation}": ${directResponse.status}`);
                        }
                    } catch (error) {
                        console.log(`[API] Direct search error for "${searchVariation}": ${error.message}`);
                    }
                }
                
                // If we reach here, no variations worked
                console.log(`[API] No matching company found for "${orgName}" after trying ${searchVariations.length} variations`);
                
                return res.json({ 
                    assets: [],
                    message: `No matching IT Portal company found for "${orgName}". Tried variations: ${searchVariations.join(', ')}`,
                    search_method: 'direct_search_failed',
                    variations_tried: searchVariations,
                    companies_searched: 'direct_api'
                });
            }

            // Start cache refresh for next time if we haven't already
            if (!companiesCache.isUpdating && companiesCache.companies.length === 0) {
                refreshCompaniesCache().catch(err => 
                    console.error('[API] Cache refresh failed:', err.message)
                );
            }
        }

        console.log(`[API] Match found: "${matchingCompany.name}" (ID: ${matchingCompany.id})`);

        // Step 5: Fetch devices for the matching company
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
            description: device.description || '', // FIXED: Show actual description
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

                // Create asset data with improved field mapping
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