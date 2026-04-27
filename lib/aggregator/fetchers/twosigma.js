/**
 * Two Sigma Jobs Fetcher
 *
 * Fetches jobs from Two Sigma's public RSS/Atom feed (Avature platform).
 * No authentication required. Single request returns all open roles.
 *
 * URL: https://careers.twosigma.com/careers/OpenRoles/feed/
 * Method: GET
 * Params: jobRecordsPerPage=100
 * Response: XML RSS feed with <item> elements
 *
 * Per item: title (CDATA), description (location, CDATA), link (full URL),
 *           guid (full URL with job ID), pubDate (RFC 2822)
 *
 * ~20 jobs total. Mostly NY-based quant/research roles.
 * robots.txt: GREEN — explicit Allow: /careers.
 * Live-verified 2026-04-27.
 */

'use strict';

const https = require('https');

const FEED_URL = 'https://careers.twosigma.com/careers/OpenRoles/feed/?jobRecordsPerPage=100';
const USER_AGENT = 'Mozilla/5.0 (compatible; job-board-bot/1.0)';

/**
 * GET request returning raw string, or null on error/timeout.
 */
function getUrl(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT }
    }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * Parse RSS XML into array of job items.
 * Lightweight regex-based parsing — avoids adding an XML parser dependency.
 */
function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const title = extractCdata(block, 'title');
    const description = extractCdata(block, 'description');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');

    items.push({ title, description, link, pubDate });
  }

  return items;
}

function extractCdata(block, tag) {
  const m = block.match(new RegExp(`<${tag}>[\\s\\S]*?<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>[\\s\\S]*?</${tag}>`));
  return m ? m[1].trim() : '';
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}

/**
 * Extract job ID from URL. Last path segment after final /.
 */
function extractJobId(url) {
  if (!url) return null;
  const parts = url.split('/');
  return parts[parts.length - 1] || null;
}

/**
 * Parse location from RSS description field.
 * Format: "United States New York City" or "United Kingdom of Great Britain and Northern Ireland London"
 * Returns just the city/region part after the country name.
 */
function parseLocation(desc) {
  if (!desc) return '';
  // Remove common country prefixes
  return desc
    .replace(/^United States\s*/i, '')
    .replace(/^United Kingdom.*?\s+(?=[A-Z])/i, '')
    .trim();
}

/**
 * Normalize one Two Sigma job to the shared schema.
 */
function normalizeTwoSigmaJob(item) {
  const jobId = extractJobId(item.link);
  const location = parseLocation(item.description);

  let postedAt = null;
  if (item.pubDate) {
    const d = new Date(item.pubDate);
    if (!isNaN(d.getTime())) postedAt = d.toISOString();
  }

  return {
    id: `twosigma-${jobId || ''}`,
    source: 'twosigma',
    source_id: jobId,

    title: item.title || null,
    company_name: 'Two Sigma',
    company_slug: 'twosigma',

    location,
    locations: location ? [location] : [],
    job_city: location,
    job_state: '',

    url: item.link || null,
    apply_url: item.link || null,

    departments: [],
    employment_type: null,

    posted_at: postedAt,
    fetched_at: new Date().toISOString(),

    description: null,
  };
}

/**
 * Fetch all Two Sigma jobs from the RSS feed.
 * @returns {Promise<Array>} normalized jobs
 */
async function fetchAllTwoSigmaJobs() {
  console.log('\n2️⃣ Fetching from Two Sigma...');
  console.log('━'.repeat(60));

  const result = await getUrl(FEED_URL);
  if (!result || result.status !== 200) {
    console.log(`  HTTP ${result?.status || 'error'} — no jobs fetched`);
    return [];
  }

  const items = parseRssItems(result.body);
  const jobs = items.map(normalizeTwoSigmaJob);

  console.log(`  Two Sigma total: ${jobs.length} jobs`);
  return jobs;
}

module.exports = { fetchAllTwoSigmaJobs };
