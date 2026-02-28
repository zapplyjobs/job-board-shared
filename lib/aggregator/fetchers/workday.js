/**
 * Workday Job Board API Client
 *
 * Fetches jobs from Workday's public career site API.
 * No authentication required — this is the same endpoint career site browsers call.
 *
 * URL pattern: https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 * Method: POST
 * Body: { "limit": 20, "offset": 0 }
 * Response: { "total": N, "jobPostings": [...], "facets": [...] }
 *
 * Each job in jobPostings has: title, externalPath, locationsText, postedOn, bulletFields
 * Apply URL: https://{tenant}.wd{N}.myworkdayjobs.com{externalPath}
 *
 * Schema verified 2026-02-28 against Salesforce (1,311 jobs) and CrowdStrike (627 jobs).
 * Note: facet IDs (workerSubType, country) differ per tenant — do not hardcode.
 */

'use strict';

const https = require('https');

const PAGE_SIZE = 20;
const MAX_JOBS = 500;  // Cap per tenant to avoid runaway pagination

/**
 * Make a POST request to a Workday jobs endpoint.
 * @param {string} url
 * @param {Object} body
 * @returns {Promise<{status: number, data: Object}|null>}
 */
function postJson(url, body) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent': 'Mozilla/5.0 (compatible; job-board-bot/1.0)',
            }
        };

        const req = https.request(url, options, (res) => {
            let d = '';
            res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(d) });
                } catch (_) {
                    resolve({ status: res.statusCode, data: null });
                }
            });
        });

        req.setTimeout(15000, () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(payload);
        req.end();
    });
}

/**
 * Parse a Workday locationsText into structured city/state fields.
 * Workday formats vary: "California - San Francisco", "Washington - Seattle", "Remote",
 * "2 Locations", "United States of America", or blank.
 *
 * @param {string} locationsText
 * @returns {{ job_city: string, job_state: string, location: string }}
 */
function parseWorkdayLocation(locationsText) {
    if (!locationsText) return { job_city: '', job_state: '', location: '' };

    const raw = locationsText.trim();

    // "N Locations" — multiple offices, no specific city
    if (/^\d+ locations?$/i.test(raw)) {
        return { job_city: '', job_state: '', location: raw };
    }

    // "Remote" variants
    if (/^remote$/i.test(raw)) {
        return { job_city: '', job_state: '', location: 'Remote' };
    }

    // "State - City" format (most common Workday pattern)
    // e.g. "California - San Francisco", "Washington - Seattle", "Texas - Austin"
    const stateCityMatch = raw.match(/^([^-]+?)\s*-\s*(.+)$/);
    if (stateCityMatch) {
        const statePart = stateCityMatch[1].trim();
        const cityPart = stateCityMatch[2].trim();

        // Skip non-US state patterns
        if (/^(india|ireland|germany|france|japan|mexico|canada|australia|singapore|spain|netherlands|sweden|switzerland|norway|denmark|brazil|colombia|peru|philippines|saudi|uae|taiwan|south korea|united kingdom|new zealand|finland|austria|belgium|italy|portugal|south africa|thailand|indonesia)/i.test(statePart)) {
            return { job_city: cityPart, job_state: '', location: raw };
        }

        // US state names → abbreviate for consistency with other fetchers
        const STATE_ABBR = {
            'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR',
            'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
            'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID',
            'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS',
            'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
            'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS',
            'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV',
            'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
            'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK',
            'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
            'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT',
            'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV',
            'Wisconsin': 'WI', 'Wyoming': 'WY', 'District of Columbia': 'DC',
        };

        const stateAbbr = STATE_ABBR[statePart];
        if (stateAbbr) {
            // Strip "Metro - Remote", "- Remote" suffixes from city
            const city = cityPart.replace(/\s*[-–]\s*(remote|metro.*|cw only.*)$/i, '').trim();
            return { job_city: city, job_state: stateAbbr, location: raw };
        }

        return { job_city: cityPart, job_state: '', location: raw };
    }

    return { job_city: '', job_state: '', location: raw };
}

/**
 * Normalize a raw Workday jobPosting to common job schema.
 * @param {Object} posting - Raw jobPosting from Workday API
 * @param {string} baseUrl - e.g. "https://salesforce.wd12.myworkdayjobs.com"
 * @param {string} tenantName - Human name e.g. "Salesforce"
 * @returns {Object} Normalized job object
 */
function normalizeWorkdayJob(posting, baseUrl, tenantName) {
    const { job_city, job_state, location } = parseWorkdayLocation(posting.locationsText);

    // Workday's externalPath is like "/job/California---San-Francisco/Software-Engineer_JR12345"
    // The apply URL is the full base + externalPath
    const applyUrl = posting.externalPath ? `${baseUrl}${posting.externalPath}` : null;

    // Extract requisition ID from bulletFields[0] (e.g. "JR321835")
    const reqId = (posting.bulletFields && posting.bulletFields[0]) || null;

    // Build a stable ID: workday-{tenantKey}-{reqId or slugged title}
    const tenantKey = tenantName.toLowerCase().replace(/\s+/g, '-');
    const idSuffix = reqId || slugify(posting.title || 'unknown');
    const jobId = `workday-${tenantKey}-${idSuffix}`;

    // postedOn values: "Posted Today", "Posted N Days Ago", "Posted + 30 Days Ago"
    const postedAt = parsePostedOn(posting.postedOn);

    return {
        // Core fields
        id: jobId,
        source: 'workday',
        source_url: baseUrl,
        source_id: reqId || idSuffix,

        // Job details
        title: posting.title || null,
        company_name: tenantName,
        company_slug: tenantKey,

        // Location
        location: location,
        locations: [location],
        job_city,
        job_state,

        // URL
        url: applyUrl,
        apply_url: applyUrl,

        // Metadata
        departments: [],
        employment_type: null,  // not in listing response — tag-engine infers downstream

        // Dates
        posted_at: postedAt,
        fetched_at: new Date().toISOString(),

        // No description in listing — Workday job detail pages require browser rendering
        description: null,

        _raw: {
            source: 'workday',
            externalPath: posting.externalPath,
            reqId,
        }
    };
}

function slugify(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/**
 * Parse Workday's relative date strings into ISO dates.
 * "Posted Today" → today, "Posted 3 Days Ago" → 3 days ago, "Posted + 30 Days Ago" → 30+ days ago
 */
function parsePostedOn(postedOn) {
    if (!postedOn) return new Date().toISOString();
    const now = new Date();

    const todayMatch = postedOn.match(/today/i);
    if (todayMatch) return now.toISOString();

    const daysMatch = postedOn.match(/(\d+)\s*days?\s*ago/i);
    if (daysMatch) {
        const days = parseInt(daysMatch[1], 10);
        const date = new Date(now);
        date.setDate(date.getDate() - days);
        return date.toISOString();
    }

    // "Posted + 30 Days Ago" → treat as exactly N days ago
    const plusDaysMatch = postedOn.match(/\+\s*(\d+)\s*days?\s*ago/i);
    if (plusDaysMatch) {
        const days = parseInt(plusDaysMatch[1], 10);
        const date = new Date(now);
        date.setDate(date.getDate() - days);
        return date.toISOString();
    }

    return now.toISOString();
}

/**
 * Fetch all jobs from a single Workday tenant.
 * Paginates until all jobs fetched or MAX_JOBS cap reached.
 *
 * @param {Object} tenant - { name, url, site } — e.g. { name: "Salesforce", url: "https://salesforce.wd12.myworkdayjobs.com", site: "External_Career_Site" }
 * @returns {Promise<Array>} Normalized job objects
 */
async function fetchWorkdayJobs(tenant) {
    const { name, url, site } = tenant;
    const endpoint = `${url}/wday/cxs/${new URL(url).hostname.split('.')[0]}/${site}/jobs`;

    let offset = 0;
    let total = null;
    const allPostings = [];

    while (true) {
        const result = await postJson(endpoint, { limit: PAGE_SIZE, offset });

        if (!result) {
            console.log(`   ⚠️ Workday network error: ${name}`);
            break;
        }

        if (result.status === 401 || result.status === 403) {
            console.log(`   ⚠️ Workday auth required (${result.status}): ${name} — skipping`);
            break;
        }

        if (result.status === 422) {
            console.log(`   ⚠️ Workday 422 (wrong site alias?): ${name} endpoint: ${endpoint}`);
            break;
        }

        if (result.status !== 200 || !result.data) {
            console.log(`   ⚠️ Workday error ${result.status}: ${name}`);
            break;
        }

        const postings = result.data.jobPostings || [];
        if (total === null) total = result.data.total || 0;

        allPostings.push(...postings);

        if (allPostings.length >= total || allPostings.length >= MAX_JOBS || postings.length < PAGE_SIZE) {
            break;
        }

        offset += PAGE_SIZE;

        // Polite delay between pages
        await new Promise(r => setTimeout(r, 300));
    }

    return allPostings.map(p => normalizeWorkdayJob(p, url, name));
}

/**
 * Fetch jobs from all Workday tenants.
 * @param {Array<{name, url, site}>} tenants
 * @param {Object} options
 * @param {number} options.delayMs - Delay between tenants (default: 800ms)
 * @returns {Promise<Array>} All normalized jobs
 */
async function fetchAllWorkdayJobs(tenants, options = {}) {
    const { delayMs = 800 } = options;
    const allJobs = [];

    console.log(`\n🔷 Fetching from ${tenants.length} Workday tenants...`);

    for (const tenant of tenants) {
        try {
            const jobs = await fetchWorkdayJobs(tenant);

            if (jobs.length > 0) {
                console.log(`   ✅ ${tenant.name}: ${jobs.length} jobs`);
                allJobs.push(...jobs);
            } else {
                console.log(`   ○ ${tenant.name}: 0 jobs`);
            }

            if (delayMs > 0) {
                await new Promise(r => setTimeout(r, delayMs));
            }
        } catch (err) {
            console.error(`   ❌ ${tenant.name}: ${err.message}`);
        }
    }

    console.log(`   📊 Workday total: ${allJobs.length} jobs`);
    return allJobs;
}

module.exports = {
    fetchWorkdayJobs,
    fetchAllWorkdayJobs,
    normalizeWorkdayJob,
    parseWorkdayLocation,
};
