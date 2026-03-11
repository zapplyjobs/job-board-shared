/**
 * Tag Engine - Rule-based job tagging
 *
 * Applies multi-layer tags to jobs based on:
 * - Title analysis (keyword matching)
 * - Description analysis (keyword matching)
 * - Employment type field (from API)
 * - Company name lookup (special tags)
 * - Location analysis (location tags)
 *
 * Phase 1: Rule-based implementation (target: >85% accuracy)
 * Phase 2: ML enhancement (if accuracy <85%)
 */

/**
 * Tag a single job with all tag categories
 * @param {Object} job - Normalized job object
 * @returns {Object} - Job with tags property added
 */
function tagJob(job) {
  const taggedJob = { ...job };

  const employment = tagEmployment(job);
  taggedJob.tags = {
    employment,
    domains: tagDomains(job),
    locations: tagLocations(job),
    // Internships default to entry_level — description context ("our team has 5+ years")
    // causes false senior/mid tags on intern jobs via year-mention detection
    experience: employment === 'internship' ? 'entry_level' : tagExperience(job),
    special: tagSpecial(job)
  };

  return taggedJob;
}

/**
 * Tag an array of jobs
 * @param {Array} jobs - Job array
 * @returns {Array} - Jobs with tags
 */
function tagJobs(jobs) {
  if (!Array.isArray(jobs)) {
    console.warn('tagJobs: Expected array, got', typeof jobs);
    return [];
  }

  return jobs.map(job => tagJob(job));
}

// Regex patterns for tagEmployment — defined once at module scope, not recreated per call.
// Entry-lock: explicit new-grad/junior title signals force entry_level before seniority checks.
const ENTRY_LOCK_RE = /\b(new\s+grad|new\s+graduate|university\s+grad|campus\s+hire|early[\s-]career|entry[\s-]level|junior|trainee|associate\s+(?:engineer|developer|analyst|scientist|researcher))\b/i;
// Mid-level: Roman numeral suffix II/III or explicit labels. Uses lookbehind/lookahead to avoid
// substring matches like 'Hawaii' (ha-waii) or 'viii'. \b alone is insufficient for 'ii' at end of word.
const MID_TITLE_RE = /(?<![a-z])(ii|iii)(?![a-z])|\b(sde\s*2|swe\s*2|l4|mid[\s-]level|intermediate)\b/i;
// Senior additions beyond existing keyword includes.
const SENIOR_EXTRA_RE = /\b(architect|distinguished|director|vp|vice\s+president)\b/i;

/**
 * Tag employment type (mutually exclusive)
 * Priority: internship > entry_lock > senior > mid_level > entry_level
 *
 * entry_lock fires before senior/mid so "Junior Architect" stays entry_level.
 * mid_level uses word-boundary regex (not includes) so 'ii' doesn't match 'Hawaii'.
 */
function tagEmployment(job) {
  const title = (job.title || '').toLowerCase();
  const description = (job.description || '').toLowerCase();
  const employmentType = (job.employment_type || '').toLowerCase();

  // Check for internship (highest priority)
  if (title.includes('intern') || title.includes('internship') || title.includes('co-op') || title.includes('coop')) {
    // Filter fake internships
    const fakePatterns = ['senior intern', 'sr. intern', 'principal intern', 'manager intern'];
    const isFakeIntern = fakePatterns.some(pattern => title.includes(pattern));

    if (!isFakeIntern) {
      return 'internship';
    }
  }

  // Entry-lock: explicit new-grad/junior signals override seniority detection
  if (ENTRY_LOCK_RE.test(job.title || '')) {
    return 'entry_level';
  }

  // Check for senior level
  if (title.includes('senior') || title.includes('sr.') || title.includes('sr ') ||
      title.includes('principal') || title.includes('staff') || title.includes('lead') ||
      SENIOR_EXTRA_RE.test(job.title || '')) {
    return 'senior';
  }

  // Check for mid-level (word-boundary regex prevents 'ii' matching 'Hawaii' etc)
  if (title.includes('mid') || title.includes('mid-level') || title.includes('mid level') ||
      MID_TITLE_RE.test(job.title || '')) {
    return 'mid_level';
  }

  // Default to entry level
  return 'entry_level';
}

/**
 * Tag domains (multi-select)
 * Returns array of matching domains
 */
function tagDomains(job) {
  const title = (job.title || '').toLowerCase();
  const description = (job.description || '').toLowerCase();
  const tags = [];

  // Software domain (removed bare 'developer' — too broad, matches 'developer relations', 'developer advocate')
  const softwareKeywords = [
    'software engineer', 'software developer', 'full stack', 'fullstack',
    'frontend', 'back end', 'backend', 'web developer', 'web dev',
    'mobile developer', 'ios developer', 'android developer',
    'devops', 'sre', 'site reliability', 'platform engineer',
    'swe',
    // Intern-specific patterns missed by above (INTERN-1 fix):
    'software intern', 'systems engineer', 'computer engineer', 'computer engineering',
    'cybersecurity', 'cyber security', 'network engineer', 'information technology',
    'information security', 'cloud engineer',
  ];
  const isSalesRole = /\b(sales|account executive|pre-sales|presales)\b/i.test(title);
  if (!isSalesRole && softwareKeywords.some(kw => title.includes(kw))) {
    tags.push('software');
  } else if (!isSalesRole && softwareKeywords.some(kw => description.includes(kw))) {
    tags.push('software');
  }

  // AI domain (title-only — prevents description contamination misrouting general jobs)
  // Keywords derived from S78 Auditor sample of 33 intercepted AI-title jobs (all_jobs.json 2026-02-25)
  const aiKeywords = [
    'machine learning', 'computer vision', 'deep learning',
    'applied ai', 'ai engineer', 'ai researcher',
    'nlp', 'natural language processing',
    'large language model', 'llm', 'generative ai'
  ];
  if (aiKeywords.some(kw => title.includes(kw))) {
    tags.push('ai');
  }

  // Data Science domain (title-first, description fallback — specific keywords only)
  const dataScienceKeywords = [
    'data scientist', 'data science', 'data engineer', 'data analyst',
    'machine learning', 'ml engineer', 'ai engineer'
  ];
  if (dataScienceKeywords.some(kw => title.includes(kw))) {
    tags.push('data_science');
  } else if (dataScienceKeywords.some(kw => description.includes(kw))) {
    tags.push('data_science');
  }

  // Hardware domain
  const hardwareKeywords = [
    'hardware engineer', 'embedded', 'firmware', 'electrical engineer',
    'chip design', 'fpga', 'pcb', 'vlsi', 'robotics', 'mechatronics',
    'avionics', 'mechanical engineer', 'new graduate engineer',
    'manufacturing engineer', 'manufacturing engineering',
    'materials engineer', 'materials engineering',
    'process engineer', 'process technician',
    'controls engineer', 'controls specialist',
    'hvac technician', 'hvac engineer',
    'industrial automation', 'manufacturing automation', 'building automation', 'process automation',
    // Intern-specific patterns missed by above (INTERN-1 fix):
    'electrical engineering', 'test engineer', 'design engineer',
    'mechanical design', 'hardware design', 'hardware test',
  ];
  if (hardwareKeywords.some(kw => title.includes(kw))) {
    tags.push('hardware');
  }

  // Nursing domain (title-only — short credentials use word-boundary regex)
  const nursingExact = [
    'registered nurse', 'nurse practitioner', 'nursing', 'travel nurse', 'lvn', 'graduate nurse',
    'licensed practical nurse', 'licensed vocational nurse',
    'patient care technician', 'patient care tech',
    'surgical technician', 'surgical tech',
    'pharmacy technician', 'pharmacy tech',
    'physical therapist', 'occupational therapist',
    'rehab aide', 'rehabilitation aide',
    'medical lab scientist', 'medical laboratory scientist',
    'dialysis technician', 'dialysis tech',
    'emergency department technician', 'emergency dept technician',
    'respiratory therapist',
    'medical assistant',
    'phlebotomist',
    'radiology technologist', 'radiologic technologist',
    'sonographer', 'ultrasound technologist',
    'pharmacist',
    'dietitian',
    'sterile processing technician',
    'speech therapist', 'speech language pathologist',
    'ct technologist', 'computed tomography technologist',
    'mammography technologist',
    'polysomnographic technician', 'sleep technician', 'sleep tech',
    'cytogenetics technologist', 'cytogenetic technologist',
    'pathologist assistant',
    'paramedic',
    'patient access representative',
    'ambulatory surgery assistant',
    'unit service associate',
    'clinic assistant', 'practice assistant',
    'neonatal transport',
  ];
  // \bnurse\b catches bare 'nurse' titles (charge nurse, nurse educator, etc.)
  // without matching 'nursery'. Short credentials use word-boundary to avoid false positives.
  // AEMT (Advanced EMT) added as word-boundary credential.
  const nursingCredentials = /\b(nurse|rn|lpn|cna|crna|np|aemt|emt)\b/i;
  // 'social worker' only in hospital context — title-match is sufficient since hospital Workday tenants
  // won't title non-clinical social work roles as 'social worker' without qualification
  const nursingOther = ['social worker', 'medical social worker', 'clinical social worker'];
  if (
    nursingExact.some(kw => title.includes(kw)) ||
    nursingCredentials.test(title) ||
    nursingOther.some(kw => title.includes(kw))
  ) {
    tags.push('nursing');
  }

  // Finance / Quant domain (title-only — function-based, not employer-based)
  // Matches quant trading/research roles regardless of which firm posts them.
  // Deliberately excludes generic 'financial analyst', 'finance coordinator' (corp support roles).
  // SWE roles at trading firms stay tagged 'software' — function matters, not employer.
  const financeKeywords = [
    'quantitative trader', 'quantitative researcher', 'quantitative developer',
    'quantitative analyst', 'quant trader', 'quant researcher', 'quant developer',
    'quant strategist', 'quant analyst', 'trading engineer', 'trading strategist',
    'broker trader', 'floor trader', 'options trader', 'derivatives trader',
    'algorithmic trader', 'algo trader', 'market maker', 'execution trader',
    'investment analyst', 'portfolio analyst', 'risk analyst'
  ];
  if (financeKeywords.some(kw => title.includes(kw))) {
    tags.push('finance');
  }

  // Product domain
  const productKeywords = [
    'product manager', 'product designer', 'ux designer',
    'ui designer', 'user experience', 'product owner', 'product marketing'
  ];
  if (productKeywords.some(kw => title.includes(kw))) {
    tags.push('product');
  }

  // Default to general if no matches
  if (tags.length === 0) {
    tags.push('general');
  }

  return tags;
}

/**
 * US-headquartered company slugs used for Layer 2 location fallback.
 * Only applied when Layer 1 (explicit location string) returns no US signal AND
 * the location string is an ambiguous bare value ('In-Office', 'Remote', 'N Locations').
 * These are companies where ANY office posting is plausibly US — US-only or near-US-only footprint.
 * Do NOT add multinational companies whose non-US offices post with bare location strings.
 */
const US_HQ_SLUGS = new Set([
  'cloudflare',        // In-Office (37 interns, US-only HQ pattern)
  'geisinger-health',  // Work from Home (9 interns, US healthcare system)
  'caci',              // Remote (2 interns, US defense contractor)
  'voltus',            // Remote (2 interns, US energy startup)
  'supabase',          // Remote (1 intern, US startup)
  'safariai',          // Remote (1 intern, US startup)
  'f5',                // N Locations (4 interns, US networking company)
  'leidos',            // Remote/Teleworker US (5 interns, US defense contractor)
]);

/**
 * Non-US location indicators (city names, countries, regions)
 * Used to detect ATS jobs with non-US locations (ATS normalizer sets job.location
 * as a string but doesn't populate job.job_country, so is_us_only is unreliable for ATS)
 */
const NON_US_LOCATIONS = [
  // Countries
  'canada', 'mexico', 'ireland', 'united kingdom', 'uk', 'germany', 'france',
  'netherlands', 'india', 'singapore', 'japan', 'australia', 'brazil', 'spain',
  'sweden', 'denmark', 'norway', 'finland', 'switzerland', 'poland', 'czechia',
  'romania', 'argentina', 'chile', 'colombia', 'peru', 'israel', 'turkey',
  'south korea', 'china', 'taiwan', 'new zealand', 'south africa', 'portugal',
  'costa rica', 'saudi arabia', 'hungary', 'ukraine', 'egypt', 'nigeria',
  'pakistan', 'bangladesh', 'vietnam', 'indonesia', 'thailand', 'malaysia',
  'philippines', 'greece', 'italy', 'belgium', 'austria', 'czech republic',
  // Common non-US cities that appear in ATS feeds
  'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', // Canada
  'london', 'manchester', 'edinburgh', // UK
  'dublin', 'cork', // Ireland
  'berlin', 'munich', 'hamburg', // Germany
  'amsterdam', 'rotterdam', // Netherlands
  'bengaluru', 'bangalore', 'mumbai', 'hyderabad', 'pune', 'chennai', 'delhi', // India
  'singapore',
  'sydney', 'melbourne', 'brisbane', // Australia
  'tokyo', 'osaka', // Japan
  'mexico city', 'guadalajara', 'monterrey', // Mexico
  'paris', 'lyon', // France
  'stockholm', 'gothenburg', // Sweden
  'tel aviv', 'jerusalem', // Israel
  'zurich', 'geneva', // Switzerland
  'warsaw', 'krakow', // Poland
  'prague', // Czechia
  'bucharest', // Romania
  'madrid', 'barcelona', // Spain
  'lisbon', 'porto', // Portugal
];

/**
 * Tag locations (multi-select)
 * Handles both JSearch format (job.is_us_only, job.is_remote)
 * and ATS format (job.location as string, no job_country field)
 */
function tagLocations(job) {
  const tags = [];

  // Combine all location fields for checking
  const locationStr = (
    job.location || job.job_city || job.job_location || job.job_country || ''
  ).toLowerCase();

  // is_us_only takes priority over all location string analysis.
  // Must be checked FIRST — hospital campus names like "Indian River Hospital" contain
  // NON_US_LOCATIONS substrings ("india") that would otherwise falsely block the us tag.
  const isExplicitlyNonUS = job.is_us_only !== true &&
    NON_US_LOCATIONS.some(place => locationStr.includes(place));

  if (job.is_us_only === true) {
    tags.push('us');
  } else if (isExplicitlyNonUS) {
    // Don't add 'us' tag — skip to remote check
  } else if (locationStr) {
    // ATS jobs with a location that didn't match non-US list: check for US indicators
    const usKeywords = [
      // Full state names
      'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
      'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
      'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
      'minnesota','mississippi','missouri','montana','nebraska','nevada',
      'new hampshire','new jersey','new mexico','new york','north carolina',
      'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
      'south carolina','south dakota','tennessee','texas','utah','vermont',
      'virginia','washington','west virginia','wisconsin','wyoming','district of columbia',
      // Common US cities (synced with US_CITIES_SLUG in workday.js — WD-F7 fix)
      'san francisco', 'los angeles', 'chicago', 'seattle', 'austin',
      'boston', 'denver', 'atlanta', 'miami', 'dallas', 'houston', 'phoenix',
      'cleveland', 'kansas city', 'philadelphia', 'san diego', 'minneapolis',
      'detroit', 'portland', 'las vegas', 'baltimore', 'nashville', 'memphis',
      'louisville', 'milwaukee', 'albuquerque', 'tucson', 'sacramento',
      'salt lake city', 'raleigh', 'richmond', 'pittsburgh', 'cincinnati',
      'indianapolis', 'columbus', 'charlotte', 'jacksonville', 'san antonio',
      // Additional US cities from US_CITIES_SLUG (Workday slug parser) — WD-F7
      'san jose', 'fort worth', 'fresno', 'mesa', 'omaha', 'colorado springs',
      'long beach', 'virginia beach', 'tampa', 'new orleans', 'arlington',
      'wichita', 'bakersfield', 'aurora', 'anaheim', 'santa ana', 'corpus christi',
      'riverside', 'st. louis', 'st louis', 'saint louis', 'lexington', 'stockton',
      'st. paul', 'st paul', 'saint paul', 'greensboro', 'toledo', 'newark', 'plano',
      'henderson', 'lincoln', 'buffalo', 'fort wayne', 'jersey city', 'chula vista',
      'orlando', 'st. petersburg', 'st petersburg', 'norfolk', 'chandler', 'laredo',
      'madison', 'durham', 'lubbock', 'winston-salem', 'garland', 'glendale',
      'hialeah', 'reno', 'baton rouge', 'irvine', 'chesapeake', 'scottsdale',
      'fremont', 'gilbert', 'san bernardino', 'birmingham', 'rochester', 'spokane',
      'des moines', 'montgomery',
      // Tech hubs / defense corridors
      'mclean', 'tysons', 'bethesda', 'herndon', 'reston', 'redmond', 'bellevue',
      'mountain view', 'sunnyvale', 'santa clara', 'cupertino', 'menlo park',
      'palo alto', 'brooklyn', 'manhattan', 'cambridge', 'ann arbor', 'boulder',
      'san ramon', 'foster city', 'santa monica', 'el segundo', 'torrance',
      'thousand oaks', 'princeton', 'parsippany', 'hackensack', 'morristown',
      // Additional Workday tenant cities
      'lehi', 'waltham', 'irving',
      // Explicit US remote indicators — bare "Remote" alone is NOT sufficient
      'united states', '- usa', ', usa', '(usa)', 'u.s.a', '- us', ', us',
    ];
    // All 50 state abbreviations: match after comma/space/pipe, word-boundary terminated.
    // Previous regex required delimiter after abbr (e.g. "NY,") — failed "Boise, ID - Main Site".
    // \b is sufficient: prevents 'us' in 'teleworker us' from matching (not preceded by separator).
    const US_STATE_ABBR = new Set([
      'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
      'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
      'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
      'va','wa','wv','wi','wy','dc'
    ]);
    const stateAbbrRe = /[,\s|]\s*([a-z]{2})\b/g;
    let stateAbbrM;
    let hasStateAbbr = false;
    while ((stateAbbrM = stateAbbrRe.exec(locationStr)) !== null) {
      if (US_STATE_ABBR.has(stateAbbrM[1])) { hasStateAbbr = true; break; }
    }

    if (usKeywords.some(s => locationStr.includes(s)) || hasStateAbbr) {
      tags.push('us');
    }

    // Layer 2: company-slug fallback for ambiguous bare location strings.
    // Only fires when Layer 1 returned no 'us' signal. Applies to known US-HQ companies
    // that post with bare strings ('In-Office', 'Remote', 'N Locations') with no city/state.
    // Multinational companies are deliberately excluded — their bare-string posts could be anywhere.
    if (!tags.includes('us')) {
      const isAmbiguousBare = /^(in-office|remote|work from home|hybrid|\d+\s+locations?)$/i.test(locationStr.trim());
      if (isAmbiguousBare && US_HQ_SLUGS.has(job.company_slug)) {
        tags.push('us');
      }
    }

    // Layer 3: explicit US pattern strings not caught by Layer 1 keywords.
    // 'USA - Remote', 'USA Remote' — reversed order vs '- usa' keyword.
    // 'US-XX-...' — Workday site codes (US-CT-EAST HARTFORD-..., US-PR-AGUADILLA-...).
    if (!tags.includes('us')) {
      if (/^usa[\s\-]/i.test(locationStr) || /^us-[a-z]{2}-/i.test(locationStr)) {
        tags.push('us');
      }
    }

    // If location exists but doesn't match US or non-US list, don't assume US
  }

  // Check for remote
  if (job.is_remote === true) {
    tags.push('remote');
  } else if (locationStr.includes('remote') && !isExplicitlyNonUS) {
    tags.push('remote');
  }

  // Check for hybrid (ATS sources only — JSearch uses is_remote bool, no hybrid signal)
  // Matches: "Hybrid - New York, NY" | "Hybrid" | "Hybrid Mesa AZ" | "hybrid"
  if (locationStr.includes('hybrid')) {
    tags.push('hybrid');
  }

  // Check for on-site (not remote, not hybrid)
  if (job.is_remote === false && !tags.includes('remote') && !tags.includes('hybrid')) {
    tags.push('on_site');
  }

  return tags;
}

/**
 * Tag experience level based on year requirements in the job description.
 * Values align with tags.employment vocabulary: entry_level / mid_level / senior_level / unknown.
 *
 * Classification thresholds (minimum years mentioned):
 *   0–1 years  → entry_level
 *   2–3 years  → mid_level
 *   4+ years   → senior_level
 *   no match   → unknown
 *
 * Note: ~8.8% of entry_level-tagged jobs state 4+ year requirements — this reflects
 * real tension in the data (companies posting "entry-level" but requiring experience).
 * This is exposed honestly here, not corrected. The scoring engine should weight accordingly.
 */
function tagExperience(job) {
  const raw = (job.description || '') + ' ' + (job.title || '');

  // Strip HTML tags and decode common entities before pattern matching
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ')
    .toLowerCase();

  // Match "X+ years", "X years of/experience", "X-Y years" — extract the minimum number
  // Covers dominant ATS patterns: "1+ years of experience", "3+ years", "2-4 years"
  const YEAR_RE = /(\d+)\s*\+?\s*(?:to|-|–)?\s*\d*\s*years?\s*(?:of\s+)?(?:professional\s+)?(?:relevant\s+)?(?:work\s+)?(?:exp(?:erience)?|professional)/gi;
  const YEAR_SIMPLE = /(\d+)\s*\+\s*years?|(\d+)\s+years?\s+of/gi;

  const years = [];
  let m;
  while ((m = YEAR_RE.exec(text)) !== null) {
    const y = parseInt(m[1], 10);
    if (y > 0 && y <= 20) years.push(y);
  }
  if (years.length === 0) {
    while ((m = YEAR_SIMPLE.exec(text)) !== null) {
      const y = parseInt(m[1] || m[2], 10);
      if (y > 0 && y <= 20) years.push(y);
    }
  }

  if (years.length === 0) return 'unknown';

  const minYears = Math.min(...years);
  if (minYears <= 1) return 'entry_level';
  if (minYears <= 3) return 'mid_level';
  return 'senior_level';
}

/**
 * Tag special companies (multi-select)
 */
function tagSpecial(job) {
  const tags = [];
  const companyName = (job.company_name || '').toLowerCase();

  // FAANG companies
  const faangCompanies = [
    'facebook', 'meta', 'amazon', 'apple', 'netflix', 'google',
    'alphabet', 'microsoft', 'google', 'nvidia'
  ];
  if (faangCompanies.some(company => companyName.includes(company))) {
    tags.push('faang');
  }

  // Unicorn startups (approximate list)
  const unicornCompanies = [
    'stripe', 'plaid', 'databricks', 'snowflake', 'airbnb',
    'robinhood', 'doorash', 'instacart', 'coinbase', 'ribbit',
    'chime', 'rippling', 'epic', 'snowflake', 'plaid'
  ];
  if (unicornCompanies.some(company => companyName.includes(company))) {
    tags.push('unicorn');
  }

  // Fortune 500 (simplified - would need comprehensive list)
  const fortune500Companies = [
    'walmart', 'amazon', 'apple', 'cv health', 'unitedhealth',
    'mckesson', 'cardinal', 'exxon', 'at&t', 'costco'
  ];
  if (fortune500Companies.some(company => companyName.includes(company))) {
    tags.push('fortune500');
  }

  return tags;
}

/**
 * Generate tag statistics for a batch of jobs
 * @param {Array} jobs - Tagged jobs
 * @returns {Object} - Tag statistics
 */
function generateTagStats(jobs) {
  const stats = {
    employment: {},
    domains: {},
    locations: {},
    experience: {},
    special: {},
    total: jobs.length
  };

  jobs.forEach(job => {
    if (!job.tags) return;

    // Count employment tags (mutually exclusive)
    if (job.tags.employment) {
      stats.employment[job.tags.employment] = (stats.employment[job.tags.employment] || 0) + 1;
    }

    // Count domain tags (multi-select)
    if (job.tags.domains && Array.isArray(job.tags.domains)) {
      job.tags.domains.forEach(domain => {
        stats.domains[domain] = (stats.domains[domain] || 0) + 1;
      });
    }

    // Count location tags (multi-select)
    if (job.tags.locations && Array.isArray(job.tags.locations)) {
      job.tags.locations.forEach(location => {
        stats.locations[location] = (stats.locations[location] || 0) + 1;
      });
    }

    // Count experience tags (mutually exclusive)
    if (job.tags.experience) {
      stats.experience[job.tags.experience] = (stats.experience[job.tags.experience] || 0) + 1;
    }

    // Count special tags (multi-select)
    if (job.tags.special && Array.isArray(job.tags.special)) {
      job.tags.special.forEach(special => {
        stats.special[special] = (stats.special[special] || 0) + 1;
      });
    }
  });

  return stats;
}

module.exports = {
  tagJob,
  tagJobs,
  tagEmployment,
  tagDomains,
  tagLocations,
  tagExperience,
  tagSpecial,
  generateTagStats
};
