/**
 * SimplifyJobs Listings Fetcher
 *
 * Fetches jobs from SimplifyJobs/New-Grad-Positions and Summer2026-Internships
 * public GitHub repos. Parses listings.json for companies NOT on fetchable ATS
 * platforms (iCIMS, Taleo, Avature, proprietary portals).
 * Microsoft, Oracle, AMD removed — now have direct custom fetchers.
 *
 * Data source: Public GitHub JSON — zero ToS risk, no auth, no API quota.
 * Updated every 30 min by Simplify's backend.
 *
 * SUP-FETCHER-3: Fallback for unfetchable companies (tier 2 after direct fetchers).
 * Only ingests jobs from companies that have no direct fetcher in the pipeline.
 * Company matching: exact match against company-list.json company names.
 *
 * Listings structure per entry:
 *   { source, category, company_name, id, title, active, date_updated,
 *     date_posted, url, locations[], company_url, is_visible, sponsorship, degrees[] }
 *
 * No job descriptions available — SimplifyJobs provides title + URL only.
 * Jobs enter pipeline as T0 (no description). Acceptable for companies with
 * zero other pipeline representation.
 */

'use strict';

const https = require('https');

const REPOS = [
  {
    name: 'New-Grad-Positions',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json'
  },
  {
    name: 'Summer2026-Internships',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json'
  }
];

// Companies to fetch from SimplifyJobs — only those NOT on fetchable ATS platforms.
// These are unfetchable via GH/Lever/Ashby/WD/SR or have proprietary portals.
const TARGET_COMPANIES = [
  // Proprietary portals / auth-walled
  'TikTok', 'ByteDance',
  'Tesla', 'SentinelOne',
  // Proprietary portals
  'IBM', 'Goldman Sachs', 'Shopify',
  // API-gated / custom
  'Citadel',
  // Previously rejected/unfetchable with no direct path
  'Fortinet', 'Qualcomm',
  'Texas Instruments', 'Equinix',
  'Deloitte',
  // SUP-EXPAND-1 (F19): Blocked major companies with active SimplifyJobs US listings
  'Meta', 'Bank of America', 'Pfizer', 'Stryker', 'Charles Schwab',
  'PNC Financial Services', 'Truist Bank', 'Boston Scientific', 'CVS Health',
  'Wells Fargo',
  // F41: Major US bank, 16 active SimplifyJobs listings (6+ US entry-level)
  'JP Morgan Chase',
  // F41: SimplifyJs discovery — 5 companies with active US tech entry-level listings
  'Veeva Systems',
  'Susquehanna International Group (SIG)',
  'Amentum',
  'L3Harris Technologies',
  'Peraton',
  // F45: Coinbase migrated from GH (board 404). SimplifyJs fallback (3 US listings).
  'Coinbase',
  // F50: SimplifyJs gap analysis — unfetchable ATS, real US tech entry-level yield
  'Skydio',        // 8 US tech-EL — autonomy/drone company
  'Cirrus Logic',  // 5 US tech-EL — semiconductor company
  'Canon',         // 6 US tech-EL — mostly software interns, Irvine CA
];



const HEADERS = {
  'User-Agent': 'ZJP-Pipeline/1.0',
  'Accept': 'application/json',
};

function fetchJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: HEADERS }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(d) });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, error: e.message });
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, data: null, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, data: null, error: e.message }));
  });
}

/**
 * Parse location string into city/state/country components.
 */
function parseLocation(locStr) {
  if (!locStr || typeof locStr !== 'string') return { city: '', state: '', country: '' };

  const parts = locStr.split(',').map(s => s.trim());
  if (parts.length === 0) return { city: '', state: '', country: '' };

  const city = parts[0] || '';
  const stateOrRegion = parts[1] || '';

  // Detect US locations: "City, ST" or "City, State"
  const usStateAbbrevs = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR']);
  const upper = stateOrRegion.toUpperCase().replace(/\./g, '');

  if (usStateAbbrevs.has(upper)) {
    return { city, state: upper, country: 'us' };
  }

  // "United States" as city means country-level
  if (city.toLowerCase() === 'united states') {
    return { city: '', state: '', country: 'us' };
  }

  // Common non-US patterns
  const nonUS = new Set(['Canada','UK','United Kingdom','India','Germany','France','Singapore','Australia','Japan','China','Brazil','Netherlands','Ireland','Israel','South Korea','Switzerland','Mexico']);
  if (nonUS.has(stateOrRegion) || nonUS.has(city)) {
    return { city, state: '', country: '' };
  }

  // Default: assume US if it looks like "City, ST"
  if (upper.length === 2 && upper.match(/^[A-Z]{2}$/)) {
    return { city, state: upper, country: 'us' };
  }

  return { city, state: stateOrRegion, country: '' };
}

/**
 * Normalize a SimplifyJobs listing to the shared schema.
 */
function normalizeListing(listing) {
  const locs = (listing.locations || [])
    .map(parseLocation)
    .filter(l => l.country === 'us');

  const primaryLoc = locs[0] || { city: '', state: '', country: 'us' };

  return {
    id: `simplify-${listing.id}`,
    source: 'simplify',
    source_id: listing.id,

    title: (listing.title || '').trim() || null,
    company_name: listing.company_name,
    company_slug: listing.company_name.toLowerCase().replace(/[^a-z0-9]+/g, ''),

    location: primaryLoc.city ? `${primaryLoc.city}, ${primaryLoc.state}` : 'United States',
    locations: locs.length > 0 ? locs.map(l => l.country === 'us' ? 'us' : l.country) : ['us'],
    job_city: primaryLoc.city,
    job_state: primaryLoc.state,

    url: listing.url,
    apply_url: listing.url,

    departments: [],
    employment_type: null,

    // FRESHNESS-2: If date_posted is older than 7 days, substitute Date.now().
    // SimplifyJobs internship listings stay active for months but date_posted reflects
    // original posting date. Without override, deduplicator and posted-jobs-manager
    // reject these as expired (>7 day TTL). Same pattern as GH/Lever/Ashby.
    posted_at: (() => {
      const postedMs = listing.date_posted ? listing.date_posted * 1000 : NaN;
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return new Date(!isNaN(postedMs) && postedMs > cutoff ? postedMs : Date.now()).toISOString();
    })(),
    fetched_at: new Date().toISOString(),

    description: null, // SimplifyJobs provides title + URL only — no descriptions
  };
}

/**
 * Fetch all SimplifyJobs listings for target companies.
 * @returns {Promise<Array>} normalized jobs (US-only, active listings)
 */
async function fetchAllSimplifyJobs() {
  console.log('\n📋 Fetching from SimplifyJobs...');
  console.log('━'.repeat(60));

  const targetSet = new Set(TARGET_COMPANIES.map(c => c.toLowerCase()));
  const allJobs = [];
  const seenIds = new Set();
  let totalListings = 0;
  let activeListings = 0;
  let targetActive = 0;

  for (const repo of REPOS) {
    console.log(`  Fetching ${repo.name}...`);
    const result = await fetchJson(repo.url);

    if (!result || result.status !== 200 || !result.data) {
      console.log(`  ${repo.name}: HTTP ${result?.status || 'error'} (${result?.error || 'unknown'}) — skipping`);
      continue;
    }

    const listings = Array.isArray(result.data) ? result.data : [];
    totalListings += listings.length;
    const active = listings.filter(l => l.active !== false);
    activeListings += active.length;

    const targetListings = active.filter(l => {
      const name = (l.company_name || '').toLowerCase();
      return targetSet.has(name);
    });

    for (const listing of targetListings) {
      if (seenIds.has(listing.id)) continue;
      seenIds.add(listing.id);
      targetActive++;

      const normalized = normalizeListing(listing);
      // Filter to US-only
      if (normalized.locations.includes('us') || normalized.job_state) {
        allJobs.push(normalized);
      }
    }

    console.log(`  ${repo.name}: ${listings.length} total, ${active.length} active, ${targetListings.length} target company`);
  }

  console.log(`\n  Total: ${totalListings} listings (${activeListings} active), ${targetActive} from target companies`);
  console.log(`  US jobs after normalization: ${allJobs.length}`);
  return allJobs;
}

module.exports = { fetchAllSimplifyJobs, TARGET_COMPANIES };
