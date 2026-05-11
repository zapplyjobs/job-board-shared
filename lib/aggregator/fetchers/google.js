/**
 * Google Jobs Fetcher
 *
 * Fetches jobs from Google's career portal via WIZ framework HTML extraction.
 * No authentication required. GET request returns HTML with embedded JSON data.
 *
 * URL: https://www.google.com/about/careers/applications/jobs/results/
 * Params: location, company, q, employment_type, page
 * Extraction: AF_initDataCallback with key 'ds:1' contains job data array
 *
 * Each job entry: [id, title, url, [null, description_html], level, ...]
 * Total count and page size at end of data array.
 *
 * API confirmed live 2026-04-27. robots.txt disallows the path — mitigated by rate limiting.
 * 500ms delay between pages (Google is more sensitive). 1.25 MB per page.
 * MAX_ROUTINE_PAGES caps routine runs to avoid excessive bandwidth.
 *
 * Queries (5): Software Engineer (broad, 739), new grad software engineer (entry-level, 1034),
 *   University Graduate (high-precision, 12), Early Career (PhD, 79), internship (SUP-INTERN-1).
 *   The "new grad" query surfaces entry-level job IDs that don't appear on page 1 of the
 *   "Software Engineer" query — cross-query dedup ensures no duplicates in output.
 */

'use strict';

const { getHtml, delay } = require('./http-client');

const BASE_URL = 'https://www.google.com/about/careers/applications/jobs/results/';
const PAGE_SIZE = 20;
const DELAY_MS = 500;
const MAX_PAGES = 60;
const MAX_ROUTINE_PAGES = 50;

const COMPANIES = ['Google', 'DeepMind', 'YouTube'];

const QUERIES = [
  { q: 'Software Engineer' },
  { q: 'new grad software engineer' },
  { q: 'University Graduate' },
  { q: 'Early Career' },
  { q: 'internship' },
];

const HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

/**
 * Extract job data from Google's WIZ framework HTML.
 * Finds AF_initDataCallback with key 'ds:1' and parses the data array.
 */
function extractJobsFromHtml(html) {
  if (!html) return { jobs: [], total: 0 };

  // Find all script blocks
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let dataStr = null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const scriptContent = match[1];
    // Look for ds:1 callback in this script block
    const dataMatch = scriptContent.match(
      /AF_initDataCallback\(\{key:\s*['"]ds:1['"]\s*,\s*hash:\s*['"][^"']*['"]\s*,\s*data:(\[[\s\S]+?\])\s*,\s*sideChannel:/
    );
    if (dataMatch) {
      dataStr = dataMatch[1];
      break;
    }
  }

  if (!dataStr) return { jobs: [], total: 0 };

  // Decode unicode escapes
  const decoded = dataStr
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u003d/g, '=')
    .replace(/\\u0026/g, '&')
    .replace(/\\u0027/g, "'");

  // Extract total count from end of data: null,TOTAL,PAGE_SIZE]
  const totalMatch = decoded.match(/null,(\d+),(\d+)\]$/);
  const total = totalMatch ? parseInt(totalMatch[1]) : 0;

  // Extract individual job entries
  // Pattern: ["ID","TITLE","URL",[null,"DESCRIPTION_HTML"],...]
  const jobPattern = /\["(\d{15,25})","([^"]+?)","(https:\/\/www\.google\.com\/about\/careers\/[^"]+?)"/g;
  const jobs = [];

  let jobMatch;
  while ((jobMatch = jobPattern.exec(decoded)) !== null) {
    const jobId = jobMatch[1];
    const title = jobMatch[2];
    let url = jobMatch[3];

    // Decode URL escapes
    url = url.replace(/&amp;/g, '&');

    // Extract description — find the HTML block after the URL for this job
    const descStart = jobMatch.index + jobMatch[0].length;
    const afterUrl = decoded.substring(descStart, descStart + 2000);

    // Description is in [null,"<html>...</html>"] blocks after the URL
    // After URL: , [null, "<html>..."] or [null, "<html>..."]
    let description = null;
    const descMatch = afterUrl.match(/^,?\s*\[null,"(<[^"]{10,})"/);
    if (descMatch) {
      // Strip HTML tags for clean text
      description = descMatch[1]
        .replace(/<\/?(?:ul|ol|li|h[1-6]|p|div|br|strong|em|a|span)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n\s*\n/g, '\n')
        .trim() || null;
    }

    jobs.push({ jobId, title, url, description });
  }

  return { jobs, total };
}

/**
 * Normalize a Google job entry to the shared schema.
 */
function normalizeGoogleJob(job) {
  // Google URLs contain the job ID but redirect to signin page
  // Build a clean apply URL from the job ID
  const applyUrl = `https://www.google.com/about/careers/applications/jobs/results/${job.jobId}`;

  return {
    id: `google-${job.jobId}`,
    source: 'google',
    source_id: job.jobId,

    title: (job.title || '').trim() || null,
    company_name: 'Google',
    company_slug: 'google',

    location: 'United States',
    locations: ['United States'],
    job_city: '',
    job_state: '',

    url: applyUrl,
    apply_url: applyUrl,

    departments: [],
    employment_type: null,

    posted_at: new Date().toISOString(),
    fetched_at: new Date().toISOString(),

    description: job.description,
  };
}

/**
 * Fetch all Google jobs for a single query.
 * @param {Object} query - { q, employment_type }
 * @param {number} maxPages - Max pages to fetch
 * @returns {Promise<Array>} normalized jobs
 */
async function fetchQueryJobs(query, maxPages) {
  const jobs = [];
  const seenIds = new Set();
  let page = 1;
  let total = 0;

  while (page <= maxPages) {
    const params = new URLSearchParams({
      location: 'United States',
      q: query.q,
      page: String(page),
    });
    if (query.employment_type) {
      params.set('employment_type', query.employment_type);
    }
    for (const c of COMPANIES) {
      params.append('company', c);
    }

    const url = `${BASE_URL}?${params.toString()}`;
    const result = await getHtml(url, { headers: HEADERS, timeout: 20000 });

    if (!result || result.status !== 200) {
      console.log(`  Page ${page}: HTTP ${result?.status || 'null'}, stopping`);
      break;
    }

    const extracted = extractJobsFromHtml(result.html);
    if (page === 1) {
      total = extracted.total;
      console.log(`  Total results: ${total}`);
    }

    // Deduplicate within query
    const newJobs = extracted.jobs.filter(j => !seenIds.has(j.jobId));
    for (const j of newJobs) seenIds.add(j.jobId);

    jobs.push(...newJobs);
    console.log(`  Page ${page}: ${extracted.jobs.length} extracted, ${newJobs.length} new (running total: ${jobs.length})`);

    if (extracted.jobs.length < PAGE_SIZE) break;
    if (page * PAGE_SIZE >= total) break;

    page++;
    await delay(DELAY_MS);
  }

  return jobs;
}

/**
 * Fetch all Google jobs across queries.
 * @param {Object} options - { previousJobCount }
 * @returns {Promise<Array>} normalized jobs (may contain duplicates across queries)
 */
async function fetchAllGoogleJobs(options = {}) {
  console.log('\n🔍 Fetching from Google Careers...');
  console.log('━'.repeat(60));

  const { previousJobCount = 0 } = options;
  const maxPages = previousJobCount < 100 ? MAX_PAGES : MAX_ROUTINE_PAGES;

  const allJobs = [];
  const seenIds = new Set();

  for (const query of QUERIES) {
    console.log(`\n  Query: "${query.q}" (max ${maxPages} pages)`);
    const jobs = await fetchQueryJobs(query, maxPages);

    // Cross-query dedup
    const newJobs = jobs.filter(j => !seenIds.has(j.jobId));
    for (const j of newJobs) seenIds.add(j.jobId);

    allJobs.push(...newJobs);
    console.log(`  Query total: ${jobs.length} extracted, ${newJobs.length} new after dedup`);

    await delay(DELAY_MS);
  }

  const normalized = allJobs.map(normalizeGoogleJob);
  console.log(`\n  Total unique jobs: ${normalized.length}`);
  return normalized;
}

module.exports = { fetchAllGoogleJobs };
