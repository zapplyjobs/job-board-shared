/**
 * ATS Fetcher - Wrapper for all ATS sources
 *
 * Coordinates fetching from multiple ATS platforms:
 * Greenhouse, Lever, Ashby, Workday, Eightfold, SmartRecruiters
 *
 * Company counts loaded dynamically from company-list.json.
 */

const fs = require('fs');
const path = require('path');

// Import ATS clients
const { fetchAllGreenhouseJobs } = require('./greenhouse');
const { fetchAllLeverJobs } = require('./lever');
const { fetchAllAshbyJobs } = require('./ashby');
const { fetchAllWorkdayJobs } = require('./workday');
const { fetchAllEightfoldJobs } = require('./eightfold');
const { fetchAllSmartRecruitersJobs } = require('./smartrecruiters');

// Load company list
const COMPANY_LIST_FILE = path.join(__dirname, 'company-list.json');
const companyList = JSON.parse(fs.readFileSync(COMPANY_LIST_FILE, 'utf8'));

/**
 * Fetch jobs from all ATS sources
 * @param {Object} options - Fetching options
 * @param {number} options.delayMs - Delay between API calls (default: 500ms)
 * @param {Array<string>} options.sources - Which sources to fetch ('greenhouse', 'lever', 'ashby'), default: all
 * @returns {Promise<Object>} - { jobs, stats }
 */
async function fetchFromAllATS(options = {}) {
    const {
        delayMs = 100,
        sources = ['greenhouse', 'lever', 'ashby', 'workday', 'eightfold', 'smartrecruiters']
    } = options;

    console.log('\n📦 Fetching from ATS sources (parallel)...');
    console.log('━'.repeat(60));

    const results = {
        jobs: [],
        stats: {
            total_jobs: 0,
            by_source: {},
            by_company: {},
            companies_fetched: 0,
            companies_with_jobs: 0,
            fetch_duration_ms: 0
        }
    };

    const startTime = Date.now();

    try {
        // Build fetch tasks for all active sources — run all in parallel.
        // Each ATS hits a completely different API domain, so there is no shared
        // rate-limit risk between sources. Parallelism cuts Step 1 from ~20 min
        // to the time of the slowest single source (Workday, ~2-3 min).
        const fetchTasks = [];

        if (sources.includes('greenhouse') && companyList.greenhouse.length > 0)
            fetchTasks.push({ name: 'greenhouse', promise: fetchAllGreenhouseJobs(companyList.greenhouse, { delayMs }) });

        if (sources.includes('lever') && companyList.lever.length > 0)
            fetchTasks.push({ name: 'lever', promise: fetchAllLeverJobs(companyList.lever, { delayMs }) });

        if (sources.includes('ashby') && companyList.ashby.length > 0)
            fetchTasks.push({ name: 'ashby', promise: fetchAllAshbyJobs(companyList.ashby, { delayMs }) });

        if (sources.includes('workday') && companyList.workday && companyList.workday.length > 0)
            fetchTasks.push({ name: 'workday', promise: fetchAllWorkdayJobs(companyList.workday, { delayMs: 200 }) });

        if (sources.includes('eightfold') && companyList.eightfold && companyList.eightfold.length > 0)
            fetchTasks.push({ name: 'eightfold', promise: fetchAllEightfoldJobs(companyList.eightfold, { delayMs }) });

        if (sources.includes('smartrecruiters') && companyList.smartrecruiters && companyList.smartrecruiters.length > 0)
            fetchTasks.push({ name: 'smartrecruiters', promise: fetchAllSmartRecruitersJobs(companyList.smartrecruiters, { delayMs }) });

        // allSettled — one slow/failing source doesn't abort the others
        const settled = await Promise.allSettled(fetchTasks.map(t => t.promise));

        for (let i = 0; i < fetchTasks.length; i++) {
            const { name } = fetchTasks[i];
            const outcome = settled[i];
            if (outcome.status === 'fulfilled') {
                results.jobs.push(...outcome.value);
                results.stats.by_source[name] = outcome.value.length;
            } else {
                console.error(`❌ ${name} fetch failed: ${outcome.reason?.message}`);
                results.stats.by_source[name] = 0;
            }
        }

        // Calculate stats
        results.stats.total_jobs = results.jobs.length;
        results.stats.companies_fetched =
            (sources.includes('greenhouse') ? companyList.greenhouse.length : 0) +
            (sources.includes('lever') ? companyList.lever.length : 0) +
            (sources.includes('ashby') ? companyList.ashby.length : 0) +
            (sources.includes('workday') && companyList.workday ? companyList.workday.length : 0) +
            (sources.includes('eightfold') && companyList.eightfold ? companyList.eightfold.length : 0) +
            (sources.includes('smartrecruiters') && companyList.smartrecruiters ? companyList.smartrecruiters.length : 0);

        // Count by company
        for (const job of results.jobs) {
            const company = job.company_name || job.company_slug;
            results.stats.by_company[company] = (results.stats.by_company[company] || 0) + 1;
        }

        results.stats.companies_with_jobs = Object.keys(results.stats.by_company).length;
        results.stats.fetch_duration_ms = Date.now() - startTime;

        // Print summary
        console.log('\n📊 ATS Fetch Summary:');
        console.log('━'.repeat(60));
        console.log(`Total jobs: ${results.stats.total_jobs}`);
        console.log(`Companies fetched: ${results.stats.companies_fetched}`);
        console.log(`Companies with jobs: ${results.stats.companies_with_jobs}`);
        console.log(`Duration: ${(results.stats.fetch_duration_ms / 1000).toFixed(1)}s`);
        console.log('');
        console.log('By source:');
        for (const [source, count] of Object.entries(results.stats.by_source)) {
            console.log(`  ${source}: ${count} jobs`);
        }

        return results;

    } catch (error) {
        console.error('\n❌ Error fetching from ATS sources:', error.message);
        throw error;
    }
}

/**
 * Get usage stats (for compatibility with JSearch fetcher)
 * @returns {Object} Usage statistics
 */
function getUsageStats() {
    return {
        companies_total: companyList.greenhouse.length + companyList.lever.length + companyList.ashby.length + (companyList.workday ? companyList.workday.length : 0) + (companyList.eightfold ? companyList.eightfold.length : 0) + (companyList.smartrecruiters ? companyList.smartrecruiters.length : 0),
        greenhouse_companies: companyList.greenhouse.length,
        lever_companies: companyList.lever.length,
        ashby_companies: companyList.ashby.length,
        workday_tenants: companyList.workday ? companyList.workday.length : 0,
        eightfold_tenants: companyList.eightfold ? companyList.eightfold.length : 0,
        smartrecruiters_companies: companyList.smartrecruiters ? companyList.smartrecruiters.length : 0
    };
}

module.exports = {
    fetchFromAllATS,
    getUsageStats
};
