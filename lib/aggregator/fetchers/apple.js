/**
 * Apple Jobs Fetcher
 *
 * Fetches jobs from Apple's careers site via HTML JSON extraction.
 * Apple embeds React SSR hydration data in the page HTML containing
 * structured job listings — no API key or authentication needed.
 *
 * URL: https://jobs.apple.com/en-us/search
 * Method: GET
 * Params: sort=newest, page=N, location=united-states-USA
 * Response: HTML with embedded JSON in window.__staticRouterHydrationData
 *
 * Extraction: regex → JSON.parse → navigate loaderData.search.searchResults
 * Per job: postingTitle, locations[0].name, postingDate/postDateInGMT,
 *          positionId, reqId, jobSummary, transformedPostingTitle
 *
 * No pagination limit observed; 20 results per page, ~5,024 total.
 * robots.txt: GREEN — no restrictions on jobs.apple.com.
 * Live-verified 2026-04-27.
 */

'use strict';

const https = require('https');

const BASE_URL = 'https://jobs.apple.com';
const SEARCH_PATH = '/en-us/search';
const PAGE_SIZE = 20;
const DELAY_MS = 300;
const MAX_PAGES = 300;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * GET request returning raw HTML string, or null on error/timeout.
 */
function getHtml(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        return getHtml(res.headers.location).then(resolve);
      }
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ status: res.statusCode, html: d }));
    });
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract job results from Apple's embedded hydration data.
 * Returns { jobs: [...], totalRecords: N, page: N } or null.
 */
function extractJobsFromHtml(html) {
  // Apple embeds: window.__staticRouterHydrationData = JSON.parse("...");
  // The inner string is a JSON string literal containing the actual JSON data.
  // Double JSON.parse: first unescapes the string literal, second parses the data.
  const match = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\);/s);
  if (!match) return null;

  try {
    const jsonString = JSON.parse(match[1]);
    const data = JSON.parse(jsonString);

    const searchData = data.loaderData?.search;
    if (!searchData) return null;

    return {
      jobs: searchData.searchResults || [],
      totalRecords: searchData.totalRecords || 0,
      page: searchData.page || 1,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Parse Apple's date strings. Prefer postDateInGMT (ISO), fallback to postingDate ("Apr 27, 2026").
 */
function parseDate(job) {
  if (job.postDateInGMT) {
    return new Date(job.postDateInGMT).toISOString();
  }
  if (job.postingDate) {
    const d = new Date(job.postingDate);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * Normalize one Apple job record to the shared schema.
 */
function normalizeAppleJob(job) {
  const loc = (job.locations && job.locations[0]) || {};
  const location = (loc.name || '').trim();

  const slug = (job.transformedPostingTitle || '').trim();
  const positionId = String(job.positionId || '');
  const applyUrl = positionId && slug
    ? `${BASE_URL}/en-us/details/${positionId}/${slug}`
    : null;

  return {
    id: `apple-${positionId || job.reqId}`,
    source: 'apple',
    source_id: positionId || job.reqId,

    title: (job.postingTitle || '').trim() || null,
    company_name: 'Apple',
    company_slug: 'apple',

    location,
    locations: location ? [location] : [],
    job_city: (loc.city || '').trim(),
    job_state: (loc.stateProvince || '').trim(),

    url: applyUrl,
    apply_url: applyUrl,

    departments: job.team ? [job.team.teamName] : [],
    employment_type: null,

    posted_at: parseDate(job),
    fetched_at: new Date().toISOString(),

    description: (job.jobSummary || '').trim() || null,
  };
}

/**
 * Fetch all Apple US jobs, paginating through search results.
 * @returns {Promise<Array>} normalized jobs
 */
async function fetchAllAppleJobs() {
  console.log('\n🍎 Fetching from Apple Jobs...');
  console.log('━'.repeat(60));

  const allJobs = [];
  let page = 1;
  let totalRecords = 0;

  while (page <= MAX_PAGES) {
    const url = `${BASE_URL}${SEARCH_PATH}?sort=newest&location=united-states-USA&page=${page}`;

    const result = await getHtml(url);
    if (!result || result.status !== 200) {
      console.log(`  Page ${page}: HTTP ${result?.status || 'error'} — stopping`);
      break;
    }

    const extracted = extractJobsFromHtml(result.html);
    if (!extracted || !extracted.jobs.length) {
      console.log(`  Page ${page}: ${extracted ? '0 results' : 'parse failed'} — stopping`);
      break;
    }

    if (page === 1) {
      totalRecords = extracted.totalRecords;
      console.log(`  Total Apple US jobs: ${totalRecords}`);
    }

    const normalized = extracted.jobs.map(normalizeAppleJob);
    allJobs.push(...normalized);

    if (page % 20 === 0) {
      console.log(`  Page ${page}/${Math.ceil(totalRecords / PAGE_SIZE)}: ${allJobs.length} jobs fetched`);
    }

    // Stop if we've fetched all results
    if (allJobs.length >= totalRecords) break;

    page++;
    await delay(DELAY_MS);
  }

  console.log(`  Apple total: ${allJobs.length} jobs (${page} pages)`);
  return allJobs;
}

module.exports = { fetchAllAppleJobs };
