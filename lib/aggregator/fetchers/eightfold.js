/**
 * Eightfold AI Jobs API Client
 *
 * Fetches jobs from companies using the Eightfold.ai ATS platform.
 * No authentication required for public listings.
 *
 * URL: https://{tenant}.eightfold.ai/api/apply/v2/jobs
 * Method: GET
 * Params: num (page size), start (offset)
 * Response: { count: N, positions: [...] }
 *
 * API confirmed live 2026-03-11:
 *   aexp (American Express): 493 jobs
 *   johndeere (John Deere): 184 jobs
 *   zebra (Zebra Technologies): 266 jobs
 *
 * IMPORTANT: Do NOT include a `domain` param — returns 404 with it.
 */

'use strict';

const https = require('https');

const PAGE_SIZE = 50;
const MAX_JOBS_PER_TENANT = 2000;
const DELAY_MS = 400;

/**
 * GET request returning parsed JSON, or null on error/timeout.
 */
function getJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-board-bot/1.0)' }
    }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch (_) { resolve(null); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normalize one Eightfold position record to the shared schema.
 * @param {Object} pos - raw position from API
 * @param {string} tenant - e.g. 'aexp'
 * @param {string} companyName - e.g. 'American Express'
 */
function normalizeEightfoldJob(pos, tenant, companyName) {
  const location = (pos.location || '').trim();
  // canonicalPositionUrl is already a full URL (e.g. "https://aexp.eightfold.ai/careers/job/12345")
  // Do NOT prepend base — that causes double-concatenation ("https://aexp.eightfold.aihttps://...").
  const applyUrl = pos.canonicalPositionUrl && pos.canonicalPositionUrl.startsWith('https://')
    ? pos.canonicalPositionUrl
    : pos.canonicalPositionUrl
      ? `https://${tenant}.eightfold.ai${pos.canonicalPositionUrl}`
      : `https://${tenant}.eightfold.ai/careers?pid=${pos.id}`;

  // Parse ISO date from time_to_live_first_listed or listed_date fields
  let postedAt = null;
  const rawDate = pos.time_to_live_first_listed || pos.listed_date || null;
  if (rawDate) {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) postedAt = d.toISOString();
  }

  return {
    // Core fields
    id: `eightfold-${tenant}-${pos.id}`,
    source: 'eightfold',
    source_id: String(pos.id),

    // Job details
    title: (pos.name || '').trim() || null,
    company_name: companyName,
    company_slug: tenant,

    // Location
    location,
    locations: location ? [location] : [],
    job_city: null,
    job_state: null,

    // URL
    url: applyUrl,
    apply_url: applyUrl,

    // Metadata
    departments: pos.department ? [pos.department] : [],
    employment_type: pos.job_type || null,

    // Dates — if no date available, use fetched_at for natural TTL expiry
    posted_at: postedAt || new Date().toISOString(),
    fetched_at: new Date().toISOString(),

    // Description — available inline for some tenants (Zebra: 100%, JohnDeere: ~10%, AmEx: 0%)
    description: (pos.job_description && pos.job_description.trim()) || null,
  };
}

/**
 * Fetch all jobs from a single Eightfold tenant.
 * @param {Object} tenant - { name, slug } — e.g. { name: "American Express", slug: "aexp" }
 * @returns {Promise<Array>} normalized job objects
 */
async function fetchEightfoldTenantJobs(tenant) {
  const { name, slug } = tenant;
  const jobs = [];
  let start = 0;
  let total = null;

  while (start < MAX_JOBS_PER_TENANT) {
    const url = `https://${slug}.eightfold.ai/api/apply/v2/jobs?num=${PAGE_SIZE}&start=${start}`;
    const result = await getJson(url);

    if (!result || result.status !== 200 || !result.data) {
      console.log(`   ⚠️ Eightfold error (${result ? result.status : 'timeout'}): ${name}`);
      break;
    }

    const { count, positions } = result.data;
    if (total === null) total = count || 0;

    const page = positions || [];
    if (page.length === 0) break;

    jobs.push(...page.map(pos => normalizeEightfoldJob(pos, slug, name)));

    if (start + PAGE_SIZE >= total) break;
    start += PAGE_SIZE;
    await delay(DELAY_MS);
  }

  return jobs;
}

/**
 * Fetch jobs from all configured Eightfold tenants.
 * @param {Array<Object>} tenants - array of { name, slug }
 * @param {Object} options
 * @param {number} options.delayMs - delay between tenants (default: 400ms)
 * @returns {Promise<Array>} normalized jobs
 */
async function fetchAllEightfoldJobs(tenants, options = {}) {
  const { delayMs = DELAY_MS } = options;

  console.log('\n🌀 Fetching from Eightfold...');
  console.log('━'.repeat(60));

  const allJobs = [];

  for (const tenant of tenants) {
    const jobs = await fetchEightfoldTenantJobs(tenant);
    allJobs.push(...jobs);
    console.log(`  ${tenant.name} (${tenant.slug}): ${jobs.length} jobs`);
    await delay(delayMs);
  }

  console.log(`  Total: ${allJobs.length}`);
  return allJobs;
}

module.exports = { fetchAllEightfoldJobs };
