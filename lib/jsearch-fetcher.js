#!/usr/bin/env node

/**
 * JSearch API Fetcher - Shared Library
 *
 * Factory function for creating domain-specific JSearch fetchers
 * Extracted from individual repo implementations (Phase 4.3)
 *
 * Usage:
 *   const createJSearchFetcher = require('./shared/lib/jsearch-fetcher');
 *   const fetcher = createJSearchFetcher(SEARCH_QUERIES, JSEARCH_API_KEY, options);
 *   const jobs = await fetcher.fetchAllJSearchJobs();
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

/**
 * Create a JSearch fetcher instance with domain-specific queries
 *
 * @param {Array<string>} searchQueries - Domain-specific search queries
 * @param {string} apiKey - JSearch API key
 * @param {Object} options - Configuration options
 * @param {number} options.maxRequestsPerDay - Daily quota (default: 30)
 * @param {string} options.usageFile - Path to usage tracking file (default: .github/data/jsearch_usage.json)
 * @param {string} options.baseUrl - JSearch API base URL (default: jsearch.p.rapidapi.com)
 * @returns {Object} Fetcher instance with fetchAllJSearchJobs method
 */
function createJSearchFetcher(searchQueries, apiKey, options = {}) {
    // Configuration with defaults
    const config = {
        apiKey,
        searchQueries,
        baseUrl: options.baseUrl || 'jsearch.p.rapidapi.com',
        maxRequestsPerDay: options.maxRequestsPerDay || 30,
        usageFile: options.usageFile || path.join(process.cwd(), '.github', 'data', 'jsearch_usage.json')
    };

    /**
     * Load usage tracking from file
     */
    function loadUsageTracking() {
        try {
            if (fs.existsSync(config.usageFile)) {
                const data = fs.readFileSync(config.usageFile, 'utf8');
                const parsed = JSON.parse(data);

                // Reset if it's a new day
                const today = new Date().toDateString();
                if (parsed.date !== today) {
                    console.log(`📅 New day detected, resetting usage tracking`);
                    return {
                        date: today,
                        requests: 0,
                        remaining: config.maxRequestsPerDay,
                        queries_executed: []
                    };
                }

                return parsed;
            }
        } catch (error) {
            console.warn('⚠️ Error loading usage tracking:', error.message);
        }

        // Default tracking structure
        return {
            date: new Date().toDateString(),
            requests: 0,
            remaining: config.maxRequestsPerDay,
            queries_executed: []
        };
    }

    /**
     * Save usage tracking
     */
    function saveUsageTracking(data) {
        try {
            const dir = path.dirname(config.usageFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(config.usageFile, JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
            console.error('⚠️ Error saving usage tracking:', error.message);
        }
    }

    /**
     * Make HTTPS request to JSearch API
     */
    function fetchFromJSearch(query) {
        return new Promise((resolve, reject) => {
            const params = new URLSearchParams({
                query: `${query} United States`,
                employment_types: 'FULLTIME,PARTTIME,INTERN',
                num_pages: '3',  // 3 pages × 10 jobs = 30 jobs per day total
                date_posted: 'month',
                country: 'us'
            });

            const options = {
                hostname: config.baseUrl,
                path: `/search?${params.toString()}`,
                method: 'GET',
                headers: {
                    'X-RapidAPI-Key': config.apiKey,
                    'X-RapidAPI-Host': config.baseUrl
                }
            };

            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);
                        resolve(jsonData.data || []);
                    } catch (error) {
                        console.error(`Error parsing JSON for query "${query}":`, error.message);
                        resolve([]);
                    }
                });
            });

            req.on('error', (error) => {
                console.error(`Request failed for query "${query}":`, error.message);
                resolve([]);
            });

            req.setTimeout(15000, () => {
                req.destroy();
                console.error(`Request timeout for query "${query}"`);
                resolve([]);
            });

            req.end();
        });
    }

    /**
     * Fetch all jobs from JSearch with rate limiting
     */
    async function fetchAllJSearchJobs() {
        if (!config.apiKey) {
            console.error('❌ JSEARCH_API_KEY environment variable not set');
            return [];
        }

        // Load usage tracking
        const usage = loadUsageTracking();

        // Check rate limit
        if (usage.requests >= config.maxRequestsPerDay) {
            console.log(`⏸️ JSearch daily limit reached (${usage.requests}/${config.maxRequestsPerDay}), skipping this run`);
            return [];
        }

        // Log available quota
        console.log(`📊 JSearch quota: ${usage.remaining}/${config.maxRequestsPerDay} requests remaining`);

        try {
            // Rotate queries based on current hour (spreads requests across queries)
            const currentHour = new Date().getUTCHours();
            const queryIndex = currentHour % config.searchQueries.length;
            const query = config.searchQueries[queryIndex];

            console.log(`📡 JSearch API - Query: "${query}" (${usage.requests + 1}/${config.maxRequestsPerDay} today)`);

            const jobs = await fetchFromJSearch(query);

            // Update usage tracking
            usage.requests++;
            usage.remaining = config.maxRequestsPerDay - usage.requests;
            usage.queries_executed.push(query);

            saveUsageTracking(usage);

            console.log(`✅ JSearch returned ${jobs.length} jobs`);
            console.log(`📊 Usage: ${usage.requests}/${config.maxRequestsPerDay} requests, ${usage.remaining} remaining`);

            return jobs;

        } catch (error) {
            console.error('❌ JSearch API error:', error.message);
            return [];
        }
    }

    // Return fetcher instance
    return {
        fetchAllJSearchJobs,
        SEARCH_QUERIES: config.searchQueries  // Export for backwards compatibility
    };
}

module.exports = createJSearchFetcher;
