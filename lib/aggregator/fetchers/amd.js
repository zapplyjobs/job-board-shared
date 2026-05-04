/**
 * AMD Careers Jobs API Client
 *
 * Fetches jobs from AMD's public JSON API at careers.amd.com.
 * No authentication required.
 *
 * Endpoint: GET https://careers.amd.com/api/jobs?page=N
 * Pagination: 10/page, totalCount field in response.
 * Response: { jobs: [{ data: { title, description, city, state, country, ... } }], totalCount }
 *
 * API confirmed live 2026-04-30. ~1,397 total jobs, ~200 US.
 * Descriptions: 12-20K chars HTML. Qualifications/responsibilities in separate fields.
 *
 * SUP-FETCHER-13: Custom fetcher for AMD — highest-value remaining T0 company.
 * AMD was previously SimplifyJs-only (T0 quality, title-only). Direct fetcher provides
 * full descriptions, structured locations, and employer-direct apply links.
 */

'use strict';

const { getJson, delay } = require('./http-client');

const BASE_URL = 'https://careers.amd.com';
const API_PATH = '/api/jobs';
const PAGE_SIZE = 10;
const DELAY_MS = 300;

const STATE_MAP = {
  'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
  'Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA',
  'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA',
  'Kansas':'KS','Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD',
  'Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS',
  'Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH',
  'New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC',
  'North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA',
  'Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD','Tennessee':'TN',
  'Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA',
  'West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY',
  'District of Columbia':'DC','Puerto Rico':'PR',
};

const HEADERS = { 'Accept': 'application/json' };

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeAmdJob(jobData) {
  const city = (jobData.city || '').trim();
  const rawState = (jobData.state || '').trim();
  const country = (jobData.country || '').trim();
  const countryCode = (jobData.country_code || '').trim().toUpperCase();
  const stateCode = countryCode === 'US' ? (STATE_MAP[rawState] || rawState) : rawState;

  const locationParts = [city, stateCode, country].filter(Boolean);
  const location = locationParts.length ? locationParts.join(', ') : null;

  const jobId = jobData.req_id || jobData.slug || '';
  const applyUrl = jobData.apply_url || `https://careers.amd.com/jobs/${jobId}`;

  const postedAt = jobData.posted_date
    ? new Date(jobData.posted_date).toISOString()
    : null;

  const descParts = [];
  const mainDesc = stripHtml(jobData.description);
  if (mainDesc) descParts.push(mainDesc);
  const quals = stripHtml(jobData.qualifications);
  if (quals) descParts.push('Qualifications:\n' + quals);
  const resps = stripHtml(jobData.responsibilities);
  if (resps) descParts.push('Responsibilities:\n' + resps);

  const categories = Array.isArray(jobData.categories)
    ? jobData.categories.map(c => c.name || c).filter(Boolean)
    : [];

  return {
    id: `amd-${jobId}`,
    source: 'amd',
    source_id: jobId,

    title: (jobData.title || '').trim() || null,
    company_name: 'AMD',
    company_slug: 'amd',

    location,
    locations: location ? [location] : [],
    job_city: city || null,
    job_state: countryCode === 'US' ? stateCode : null,

    url: applyUrl,
    apply_url: applyUrl,

    departments: categories,
    employment_type: jobData.employment_type || null,

    posted_at: postedAt,
    fetched_at: new Date().toISOString(),

    description: descParts.length ? descParts.join('\n\n') : null,
  };
}

async function fetchAllAmdJobs() {
  console.log('\n💻 Fetching from AMD Careers...');
  console.log('━'.repeat(60));

  const allJobs = [];
  let page = 1;
  let totalCount = 0;

  // First page to get total count
  const firstUrl = `${BASE_URL}${API_PATH}?page=${page}`;
  const firstResult = await getJson(firstUrl);

  if (!firstResult || firstResult.status !== 200 || !firstResult.data) {
    console.log(`  Page 1: status=${firstResult?.status || 'null'}, stopping`);
    return [];
  }

  totalCount = firstResult.data.totalCount || 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  console.log(`  Total positions: ${totalCount} (${totalPages} pages)`);

  const firstJobs = firstResult.data.jobs || [];
  for (const j of firstJobs) {
    if (j.data) allJobs.push(normalizeAmdJob(j.data));
  }
  page++;

  // Remaining pages
  while (page <= totalPages) {
    const url = `${BASE_URL}${API_PATH}?page=${page}`;
    const result = await getJson(url);

    if (!result || result.status !== 200 || !result.data?.jobs) {
      console.log(`  Page ${page}: status=${result?.status || 'null'}, stopping`);
      break;
    }

    const jobs = result.data.jobs || [];
    if (jobs.length === 0) break;

    for (const j of jobs) {
      if (j.data) allJobs.push(normalizeAmdJob(j.data));
    }

    if (page % 20 === 0) {
      console.log(`  Progress: page ${page}/${totalPages}, ${allJobs.length} jobs`);
    }

    page++;
    if (page <= totalPages) await delay(DELAY_MS);
  }

  const usJobs = allJobs.filter(j => j.location && j.location.includes('US'));
  const withDesc = allJobs.filter(j => j.description).length;
  console.log(`  Fetched: ${allJobs.length} jobs (${usJobs.length} US, ${withDesc} with descriptions)`);

  return allJobs;
}

module.exports = { fetchAllAmdJobs };
