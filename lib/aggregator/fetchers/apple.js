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
 * Pagination (SUP-FETCHER-3 + first-run detection):
 * - First run (no previous Apple jobs in pool): fetches ALL pages (~251).
 * - Routine runs: caps at MAX_ROUTINE_PAGES (50 pages = 1,000 most recent).
 * - Jobs leaving the cap range caught by 7-day TTL.
 * - Incremental (AGG-SPEED-6): if previousJobIds provided and page-1 IDs all match,
 *   skips remaining pages. Carry-forward preserves existing Apple jobs in pool.
 *
 * Internship supplement (SUP-INTERN-2):
 * - After main fetch, queries ?search=internship&sort=relevance for aggregate postings.
 * - Apple posts 10 internship categories (SWE, HW, ML/AI, EPM, etc.) as single listings.
 * - Only page 1 needed. Strict title filter (/intern/i) prevents false matches.
 * - Adds ~10 aggregate postings per run with descriptions for enrichment.
 *
 * robots.txt: GREEN — no restrictions on jobs.apple.com.
 * Live-verified 2026-05-03.
 */

'use strict';

const { getHtml, delay } = require('./http-client');

const BASE_URL = 'https://jobs.apple.com';
const SEARCH_PATH = '/en-us/search';
const PAGE_SIZE = 20;
const DELAY_MS = 1000;
const MAX_PAGES = 300;
const MAX_ROUTINE_PAGES = 50;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function extractJobsFromHtml(html) {
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
 * Initial population (previousJobCount < FIRST_RUN_THRESHOLD): fetches all pages.
 * Routine runs: caps at MAX_ROUTINE_PAGES (50 pages = 1,000 most recent).
 *
 * The threshold catches the case where a previous capped run seeded jobs into
 * the pool — those jobs exist but don't represent a complete initial fetch.
 *
 * @param {Object} [options]
 * @param {number} [options.previousJobCount=0] - Apple jobs from previous pipeline run.
 * @param {Set<string>} [options.previousJobIds] - Apple job IDs from prior run (for incremental skip).
 * @returns {Promise<Array>} normalized jobs
 */
const FIRST_RUN_THRESHOLD = 200;

async function fetchAppleInternships(existingIds) {
  console.log('\n  🎓 Fetching Apple internship postings...');
  const internJobs = [];

  const url = `${BASE_URL}${SEARCH_PATH}?search=internship&sort=relevance&location=united-states-USA&page=1`;
  const result = await getHtml(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 20000,
    maxRetries: 1,
    retryDelay: 5000,
    followRedirects: true,
  });
  if (!result || result.status !== 200) {
    console.log(`  Internship page: HTTP ${result?.status || 'error'} — skipping`);
    return internJobs;
  }

  const extracted = extractJobsFromHtml(result.html);
  if (!extracted || !extracted.jobs.length) {
    console.log(`  Internship page: ${extracted ? '0 results' : 'parse failed'} — skipping`);
    return internJobs;
  }

  for (const job of extracted.jobs) {
    const title = (job.postingTitle || '').trim();
    if (!/internships?\b/i.test(title)) continue;
    const normalized = normalizeAppleJob(job);
    if (!existingIds.has(normalized.id)) {
      existingIds.add(normalized.id);
      // Aggregate internship postings have stale posted_at (original creation date, often >1yr old).
      // They're evergreen listings that Apple keeps live — override posted_at to fetch date
      // so the deduplicator's TTL window doesn't filter them as expired.
      normalized.posted_at = new Date().toISOString();
      internJobs.push(normalized);
    }
  }

  console.log(`  Internship postings: ${internJobs.length} (deduped)`);
  await delay(DELAY_MS);
  return internJobs;
}

async function fetchAllAppleJobs({ previousJobCount = 0, previousJobIds } = {}) {
  console.log('\n🍎 Fetching from Apple Jobs...');
  console.log('━'.repeat(60));

  const allJobs = [];
  const seenIds = new Set();
  let page = 1;
  let totalRecords = 0;
  const needsFullFetch = previousJobCount < FIRST_RUN_THRESHOLD;
  const pageLimit = needsFullFetch ? MAX_PAGES : MAX_ROUTINE_PAGES;

  if (needsFullFetch) {
    console.log(`  🔄 Full fetch mode: previous count ${previousJobCount} < ${FIRST_RUN_THRESHOLD} threshold (initial population needed)`);
  }

  while (page <= pageLimit) {
    const url = `${BASE_URL}${SEARCH_PATH}?sort=newest&location=united-states-USA&page=${page}`;

    let result = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      result = await getHtml(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 20000,
        maxRetries: 0,
        followRedirects: true,
      });
      if (result && result.status === 200) break;
      if (result?.status === 429 && attempt < 3) {
        const backoff = (attempt + 1) * 3000;
        console.log(`  Page ${page}: HTTP 429 (attempt ${attempt + 1}/4) — waiting ${backoff}ms`);
        await delay(backoff);
        continue;
      }
      break;
    }

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
      const totalPages = Math.ceil(totalRecords / PAGE_SIZE);
      console.log(`  Total Apple US jobs: ${totalRecords} (~${totalPages} pages)`);

      // AGG-SPEED-6: Skip remaining pages if nothing changed
      if (!needsFullFetch && previousJobIds && previousJobIds.size > 0) {
        const page1Ids = extracted.jobs.map(j => `apple-${j.positionId || j.reqId}`);
        const allKnown = page1Ids.length > 0 && page1Ids.every(id => previousJobIds.has(id));

        if (allKnown) {
          console.log(`  ⚡ Incremental skip: page-1 IDs all known (${page1Ids.length} checked). Skipping ${Math.min(totalPages, pageLimit) - 1} pages.`);
          for (const job of extracted.jobs) {
            const normalized = normalizeAppleJob(job);
            if (!seenIds.has(normalized.id)) { seenIds.add(normalized.id); allJobs.push(normalized); }
          }
          break; // Skip remaining pages
        } else {
          console.log(`  📄 Full fetch needed: new jobs on page 1. Proceeding with ${pageLimit} pages.`);
        }
      }

      if (!needsFullFetch && totalPages > MAX_ROUTINE_PAGES) {
        console.log(`  Capping at ${MAX_ROUTINE_PAGES} pages (${MAX_ROUTINE_PAGES * PAGE_SIZE} most recent)`);
      }
    }

    for (const job of extracted.jobs) {
      const normalized = normalizeAppleJob(job);
      if (!seenIds.has(normalized.id)) {
        seenIds.add(normalized.id);
        allJobs.push(normalized);
      }
    }

    if (page % 20 === 0) {
      console.log(`  Page ${page}/${Math.ceil(totalRecords / PAGE_SIZE)}: ${allJobs.length} jobs fetched`);
    }

    if (allJobs.length >= totalRecords) break;

    page++;
    await delay(DELAY_MS);
  }

  const internJobs = await fetchAppleInternships(seenIds);
  allJobs.push(...internJobs);

  console.log(`  Apple total: ${allJobs.length} jobs (${page} pages${internJobs.length ? ` + ${internJobs.length} internships` : ''})${needsFullFetch ? ' (full fetch)' : ' (routine cap)'}`);
  return allJobs;
}

module.exports = { fetchAllAppleJobs };
