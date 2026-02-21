/**
 * Greenhouse Job Board API Client
 *
 * Fetches jobs from Greenhouse's public API.
 * No authentication required for GET requests.
 *
 * API Docs: https://developers.greenhouse.io/job-board.html
 * Endpoint: https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs
 */

const https = require('https');

const BASE_URL = 'https://boards-api.greenhouse.io/v1/boards';

/**
 * Fetch jobs from a single Greenhouse board
 * @param {string} companySlug - Company's board token (e.g., 'anthropic')
 * @returns {Promise<Array>} Array of normalized job objects
 */
async function fetchGreenhouseJobs(companySlug) {
    const url = `${BASE_URL}/${companySlug}/jobs?content=true`;

    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';

            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode === 404) {
                        console.log(`   ⚠️ Greenhouse board not found: ${companySlug}`);
                        resolve([]);
                        return;
                    }

                    if (res.statusCode !== 200) {
                        console.log(`   ⚠️ Greenhouse API error for ${companySlug}: ${res.statusCode}`);
                        resolve([]);
                        return;
                    }

                    const response = JSON.parse(data);
                    const jobs = response.jobs || [];

                    // Normalize to common format
                    const normalizedJobs = jobs.map(job => normalizeGreenhouseJob(job, companySlug));
                    resolve(normalizedJobs);

                } catch (error) {
                    console.error(`   ❌ Error parsing Greenhouse response for ${companySlug}:`, error.message);
                    resolve([]);
                }
            });
        }).on('error', (error) => {
            console.error(`   ❌ Network error fetching ${companySlug}:`, error.message);
            resolve([]);
        });
    });
}

/**
 * Parse a Greenhouse location string into structured fields.
 *
 * Greenhouse returns free-text like "Hybrid - New York", "Remote - US: All locations",
 * "San Francisco, CA", "In-Office", "Remote - Cyprus". The tag-engine reads job.location
 * directly, but job_city/job_state are used by Discord location routing.
 *
 * @param {string} locationStr - Raw location string from Greenhouse API
 * @returns {{ job_city: string, job_state: string }}
 */
function parseGreenhouseLocation(locationStr) {
    if (!locationStr) return { job_city: '', job_state: '' };

    // Strip common prefixes: "Hybrid - ", "Remote - ", "In-Office - "
    const cleaned = locationStr.replace(/^(hybrid|remote|in-office)\s*[-–]\s*/i, '').trim();

    // Skip non-geographic strings
    if (!cleaned || /^(us|remote|all locations|select locations)/i.test(cleaned)) {
        return { job_city: '', job_state: '' };
    }

    // "San Francisco, CA" → city + state
    const cityStateMatch = cleaned.match(/^([^,]+),\s*([A-Z]{2})$/);
    if (cityStateMatch) {
        return { job_city: cityStateMatch[1].trim(), job_state: cityStateMatch[2] };
    }

    // "New York" with no state — city only
    return { job_city: cleaned, job_state: '' };
}

/**
 * Normalize Greenhouse job to common format
 * @param {Object} job - Raw Greenhouse job object
 * @param {string} companySlug - Company slug for reference
 * @returns {Object} Normalized job object
 */
function normalizeGreenhouseJob(job, companySlug) {
    // Extract location from Greenhouse format
    const location = job.location?.name || 'Remote';
    const { job_city, job_state } = parseGreenhouseLocation(location);

    // Parse departments
    const departments = job.departments?.map(d => d.name) || [];

    return {
        // Core fields
        id: `greenhouse-${companySlug}-${job.id}`,
        source: 'greenhouse',
        source_url: 'boards-api.greenhouse.io',
        source_id: job.id.toString(),

        // Job details
        title: job.title,
        company_name: job.company?.name || companySlug,
        company_slug: companySlug,

        // Location — raw string for tag-engine, structured fields for routing
        location: location,
        locations: [location],
        job_city: job_city,
        job_state: job_state,

        // URL
        url: job.absolute_url,

        // Metadata
        departments: departments,
        employment_type: job.employment_type || null,

        // Dates — created_at is the posting date; updated_at changes on edits
        posted_at: job.created_at || job.updated_at || new Date().toISOString(),
        fetched_at: new Date().toISOString(),

        // Description (if content=true was requested)
        description: job.content || null,

        // Original data for debugging
        _raw: {
            source: 'greenhouse',
            original_id: job.id
        }
    };
}

/**
 * Fetch jobs from multiple Greenhouse companies
 * @param {Array<{slug: string, name: string}>} companies - List of companies to fetch
 * @param {Object} options - Options
 * @param {number} options.delayMs - Delay between requests (default: 500ms)
 * @returns {Promise<Array>} All jobs from all companies
 */
async function fetchAllGreenhouseJobs(companies, options = {}) {
    const { delayMs = 500 } = options;
    const allJobs = [];

    console.log(`\n🌿 Fetching from ${companies.length} Greenhouse boards...`);

    for (const company of companies) {
        const slug = typeof company === 'string' ? company : company.slug;
        const name = typeof company === 'string' ? company : company.name;

        try {
            const jobs = await fetchGreenhouseJobs(slug);

            if (jobs.length > 0) {
                console.log(`   ✅ ${name}: ${jobs.length} jobs`);
                allJobs.push(...jobs);
            } else {
                console.log(`   ○ ${name}: 0 jobs`);
            }

            // Rate limiting
            if (delayMs > 0) {
                await new Promise(r => setTimeout(r, delayMs));
            }

        } catch (error) {
            console.error(`   ❌ ${name}: ${error.message}`);
        }
    }

    console.log(`   📊 Greenhouse total: ${allJobs.length} jobs`);
    return allJobs;
}

module.exports = {
    fetchGreenhouseJobs,
    fetchAllGreenhouseJobs,
    normalizeGreenhouseJob,
    parseGreenhouseLocation
};
