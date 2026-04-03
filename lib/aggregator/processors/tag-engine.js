/**
 * Tag Engine - Multi-layer job tagging
 *
 * Classification layers (in priority order):
 * 1. Title keyword matching (primary — all 16 domains)
 * 2. O*NET taxonomy lookup (fallback for general-tagged jobs — 12,084 title variants)
 * 3. Description phrase matching (fallback for GH/Lever/Ashby jobs with descriptions)
 * 4. Default to 'general' if no layer matches
 *
 * Also tags: employment type, locations, experience level, special companies.
 */

const path = require('path');

// Layer 5: Tenant-context defaults from company-list.json (TAG-10 S237).
// Claude-researched per-tenant domain assignments. Only for verified single-domain companies.
// Fires ONLY when all other layers (dept, keywords, O*NET, desc-fallback) produce no match.
const TENANT_DEFAULTS = (() => {
  try {
    const cl = require(path.join(__dirname, '..', 'fetchers', 'company-list.json'));
    const map = new Map();
    for (const ats of Object.values(cl)) {
      if (!Array.isArray(ats)) continue;
      for (const entry of ats) {
        if (entry.default_domain) {
          // Build slug from name (same logic as fetchers)
          const slug = (entry.slug || entry.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          if (slug) map.set(slug, entry.default_domain);
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
})();

// O*NET unified domain lookup — 28,486 title variants mapped to our domains via SOC codes.
// Source: O*NET v29.1 (public domain, CC BY 4.0). See TAG_CLASSIFICATION_RESEARCH_S233.md.
// Two matching methods: substring for 3+ word titles, word-boundary regex for 2-word titles.
// Word-indexed for fast candidate filtering.
const ONET = (() => {
  try {
    const data = require(path.join(__dirname, 'onet-unified-lookup.json'));

    // 3+ word titles: substring matching, word-indexed
    const substringEntries = data.substring || [];
    const substringWordIndex = new Map();
    substringEntries.forEach(([title], idx) => {
      for (const word of title.split(/\s+/)) {
        if (word.length < 4) continue;
        if (!substringWordIndex.has(word)) substringWordIndex.set(word, []);
        substringWordIndex.get(word).push(idx);
      }
    });

    // 2-word titles: word-boundary regex, first-word-indexed
    const regexEntries = [];
    const regexWordIndex = new Map();
    for (const [title, domain] of (data.regex || [])) {
      const re = new RegExp('\\b' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      const idx = regexEntries.length;
      regexEntries.push({ title, domain, re });
      const firstWord = title.split(/\s+/).find(w => w.length >= 4) || title.split(/\s+/)[0];
      if (!regexWordIndex.has(firstWord)) regexWordIndex.set(firstWord, []);
      regexWordIndex.get(firstWord).push(idx);
    }

    return { substringEntries, substringWordIndex, regexEntries, regexWordIndex };
  } catch {
    console.warn('tag-engine: onet-unified-lookup.json not found — O*NET fallback disabled');
    return { substringEntries: [], substringWordIndex: new Map(), regexEntries: [], regexWordIndex: new Map() };
  }
})();

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
  // INTERN-DETECT-1: expanded to catch co-op, graduate engineer, seasonal programs
  // Uses word boundary \b to avoid "Internal Medicine" matching "intern"
  const internWordRegex = /\b(intern|internship|co-op|coop)\b/i;
  const seasonalRegex = /\b(summer|fall|spring|winter)\s+20\d{2}\b/i;
  const seasonalGrad = /\b(summer|fall|spring|winter)\s+20\d{2}\s+graduate\b/i;

  if (internWordRegex.test(job.title || '') || seasonalRegex.test(job.title || '') || seasonalGrad.test(job.title || '')) {
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
function tagDomains(job, options) {
  const debug = options && options.debug;
  const title = (job.title || '').toLowerCase();
  const description = (job.description || '').toLowerCase();
  const tags = [];
  const matches = debug ? [] : null;

  // Debug helper: find which keyword matched in a list
  function findMatch(keywords, text) {
    for (const kw of keywords) {
      if (text.includes(kw)) return kw;
    }
    return null;
  }
  function pushTag(domain, keyword, source) {
    tags.push(domain);
    if (matches) matches.push({ domain, keyword: keyword || (domain === 'general' ? '(no match)' : '(regex)'), source: source || 'title' });
  }

  // Department/team-based classification (highest confidence — company's own categorization).
  // GH: departments[], Lever: team, Ashby: department + team. Checked BEFORE title keywords
  // because the company's classification is more reliable than keyword inference.
  // RULE ORDER MATTERS: first match wins (break on match). More specific rules must come
  // before broader ones — e.g., 'product engineering' → software before 'product' → product.
  const deptRaw = (job.team || job.department || (job.departments && job.departments[0]) || '').toLowerCase();
  if (deptRaw) {
    const DEPT_RULES = [
      // Trailing \b kept on rules with short patterns (it, ui) to prevent substring FPs.
      // 'XXX engineering' forms added explicitly where 'XXX eng\b' missed the full word.
      [/\b(software|platform engineer(?:ing)?|web engineer(?:ing)?|mobile engineer(?:ing)?|data engineer(?:ing)?|backend|frontend|devops|sre|infra engineer(?:ing)?|security engineer(?:ing)?|it engineer(?:ing)?|product engineer(?:ing)?|it)\b/i, 'software'],
      [/\b(machine learning|artificial intelligence|ai |data science|ml engineer(?:ing)?)\b/i, 'ai'],
      [/\b(data anal|business intel|analytics)\b/i, 'data_science'],
      [/\b(hardware|electrical|mechanical|embedded|firmware|test engineer(?:ing)?|systems engineer(?:ing)?|materials engineer(?:ing)?)\b/i, 'hardware'],
      [/\b(sales|business develop|account exec|revenue)\b/i, 'sales'],
      [/\b(marketing|brand|content|growth|creative|communications)\b/i, 'marketing'],
      [/\b(finance|accounting|treasury|tax |fp&a|financial|actuarial)\b/i, 'finance'],
      [/\b(legal|compliance|regulatory|counsel)\b/i, 'legal'],
      [/\b(human resources|human resource|people|talent|recruiting|hr )\b/i, 'hr'],
      [/\b(operations|ops |customer (experience|success|care|support)|fleet|supply chain|cx|field service)\b/i, 'operations'],
      [/\b(product|design|ux|ui)\b/i, 'product'],
      [/\b(manufacturing|production|assembly|quality)\b/i, 'manufacturing'],
      [/\b(healthcare|clinical|medical|nursing|pharma)\b/i, 'healthcare'],
      [/\b(warehouse|logistics|distribution|shipping|transport)\b/i, 'logistics'],
      [/\b(retail|store|merchandis)\b/i, 'retail'],
    ];
    for (const [re, domain] of DEPT_RULES) {
      if (re.test(deptRaw)) {
        pushTag(domain, '(dept: ' + deptRaw.substring(0, 30) + ')', 'department');
        break;
      }
    }
  }

  // Software domain (removed bare 'developer' — too broad, matches 'developer relations', 'developer advocate')
  const softwareKeywords = [
    'software engineer', 'software developer', 'full stack', 'fullstack',
    'frontend', 'back end', 'backend', 'web developer', 'web dev',
    'mobile developer', 'ios developer', 'android developer',
    'devops', 'site reliability', 'platform engineer',
    // Intern-specific patterns missed by above (INTERN-1 fix):
    'software intern', 'systems engineer', 'computer engineer', 'computer engineering',
    'cybersecurity', 'cyber security', 'network engineer', 'information technology',
    'information security', 'cloud engineer',
    // INTERN-1a Wave 2: additional patterns from Strategist simulation (196 reclassifications)
    'security engineer', 'infrastructure engineer', 'compiler', 'middleware', 'flight software',
    'it service', 'it systems', 'cyber incident', 'threat detection', 'threat investigation',
    'red team', 'product security', 'support engineer', 'technical support engineer',
    'ai automation', 'technical writer', 'software development engineer',
    'developer experience', 'datapath engineer', 'application developer',
    'automation developer', 'internet measurement', 'digital engineer',
    'enterprise architecture analyst',
    // TAG-OVERHAUL-A additions:
    'servicenow',                   // ServiceNow Developer/Platform Admin — enterprise IT software
    'software quality assurance',   // SW QA — explicit software testing roles
    'sw qa',                        // abbreviated form
    'information systems security', // ISSO — infosec role, distinct from physical 'security officer'
    // FRESHNESS-3: GH general-tagged misclassification fixes (S179 Auditor data audit — 14 confirmed misses)
    'perception engineer',          // Robotics/AI perception (Anduril) — software domain
    'it infrastructure engineer',   // IT infra (Vercel) — software domain
    'full-stack engineer',          // hyphenated form missed by 'full stack' keyword
    // TAG-CATEGORY-REDESIGN Option 2 (S207 Strategist vocabulary audit — ~120 general+US reclassifications)
    'solutions engineer',           // 48 hits — tech/pre-sales/defense tech (isSalesRole guard blocks 'sales solutions engineer')
    'systems analyst',              // 43 hits — IT/business systems analysis
    'technical operations engineer',// 15 hits — Anduril defense tech ops
    'qa engineer',                  // ~9 hits — SW QA (safe bare pattern; 'quality assurance engineer' bare is NOT added — manufacturing FP risk)
    'test automation engineer',     // ~4 hits — SW test automation
    'network automation engineer',  // ~4 hits — IT network automation
    'software automation engineer', // ~3 hits — SW automation
    'programmer analyst',           // ~6 hits — Boeing/defense SW programmer-analysts
    // TAXONOMY-AUDIT-1 (S225): general-tagged engineering roles
    'project engineer',             // 163 hits — engineering project roles (guard: not sales/manufacturing)
    'integration engineer',         // 90 hits — systems integration (defense/tech)
    // TAG-MISROUTE-1 Issue 3b (S229): keywords added to compensate for removing description fallback
    'forward deployed engineer',    // 26 hits — Palantir/Glean/Commure (was caught by desc only)
    'systems development engineer', // 14 hits — Amazon SDE variant
    'android engineer',             // 13 hits — mobile dev (was caught by desc only)
    'ios engineer',                 // 10 hits — mobile dev (was caught by desc only)
    'linux engineer',               // 13 hits — systems/infra
    'solution engineer',            // 84 hits — singular form missed by 'solutions engineer'
    'technical services engineer',  // 10 hits — tech support engineering
    'professional services engineer', // 4 hits — implementation engineering
    // TAG-1 S233: G1 keyword expansion — 365 US general reclassifications
    'data center engineer',         // DC infra/operations engineering (software-adjacent)
    'data center administrator',    // DC admin roles (DCIM, infrastructure)
    'data center analyst',          // DC operations analysis
    'data center database',         // DC database admin roles
    // NOTE: bare 'data center' removed — matched facilities/safety roles (14 DC Technician, 8 Safety Engineer FPs)
    'systems administrator',        // 37 hits — IT sysadmin roles
    'system administrator',         // 26 hits — singular form
    'research engineer',            // 72 hits — ML/AI research (OpenAI, Anduril, KBR)
    'automation engineer',          // 36 hits — SW/infra automation (guard: not HVAC/building)
    'desktop support',              // 11 hits — IT desktop support
    'security analyst',             // 13 hits — infosec analyst (guard: not physical security)
    'customer engineer',            // 21 hits — technical customer-facing (Google, etc.)
    'engineering intern',           // 76 hits — general eng interns at tech cos (guard: not mech/civil/chem)
    'help desk',                    // 8 hits — IT help desk
    'it support',                   // 15 hits — IT support roles
    'network admin',                // 6 hits — network administration
    // TAG-1 S233: defense/enterprise title gaps — 69 US reclassifications
    'devsecops',                    // 6 hits — DevSecOps engineer (defense/gov)
    'reverse engineer',             // 5 hits — software reverse engineering
    'simulation engineer',          // 15 hits — M&S engineer (defense/tech)
    'database administrator',       // 16 hits — DBA roles
    'database engineer',            // 4 hits — database engineering
    'splunk',                       // 3 hits — Splunk engineer/admin (SIEM)
    'scrum master',                 // 8 hits — agile process role
    'technical program manager',    // 6 hits — TPM roles (Cloudflare, Astranis)
    'cloud system',                 // 2 hits — cloud systems engineer
    // TAG-1 S233: deep-dive residual gaps
    'microsoft dynamics',           // 8 hits — ERP development/consulting
    'power apps',                   // 4 hits — low-code platform development
    'information system security',  // 6 hits — ISSO/infosec role
    'technical editor',             // 4 hits — technical documentation (complements 'technical writer')
    // TAG-5 S233: titles with special chars that O*NET regex can't match at word boundaries
    '.net developer',               // 7 hits — .NET framework development
    '.net engineer',                // .NET engineering roles
    'asp.net',                      // ASP.NET web development
    // TAG-6 S233: promoted from O*NET (high-volume matches → permanent keywords)
    'systems specialist',           // 20 hits — IT systems specialist
    // TAG-9 S237: Phase 4 keyword expansion
    'cloud developer',              // 3 hits — cloud infrastructure development
    'bi developer',                 // 2 hits — business intelligence development
    'unity developer',              // 2 hits — Unity game/simulation development
    'integration developer',        // 2 hits — systems integration development
    'configuration management',     // 4 hits — CM/DevOps roles
    'network implementation',       // 2 hits — network deployment engineering
    'uipath developer',             // 1 hit — RPA development
    'drupal developer',             // 1 hit — CMS development
    // TAG-9 S237: Phase 5 vocabulary extraction
    'service desk',                 // 11 gen, 100% spec — IT service desk
    'program manager',              // 8 gen, 88% spec — technical program management
    // TAG-9 S237: Phase 6 keyword sweep
    'deployment strategist',        // 6 gen — deployment/field strategist roles
    'configuration analyst',        // 3 gen — IT configuration analysis
    'network automation',           // 4 gen — bare form (had only 'network automation engineer')
    // TAG-10 S237: Claude-classified per-company keywords
    'security researcher',          // 1 gen — security research roles (OpenAI)
    // TAG-10 S237: Layer 5 title classification sweep
    'compositing developer',        // 2 gen — VFX compositing (DreamWorks)
    'manual tester',                // 2 gen — manual QA testing
    'geospatial',                   // 1 gen — geospatial development
    'cyber intern',                 // 2 gen — cybersecurity internships
    // TAG-10 S237: Phase 10 random sample reading
    'security operations center',   // 2 gen — SOC operators/analysts
    'cyber capability',             // 1 gen — cyber capability development
    'computer support',             // 1 gen — computer/IT support
    'command center',               // 1 gen — command center operations
    'information assurance',        // 2 gen — IA/ISSO roles
    'cyberspace',                   // 1 gen — cyberspace operations
    // TAG-10 S237: Phase 13 varied sample + desc reading
    'digital forensics',            // 1 gen — digital forensics engineering
    'cyber threat',                 // 4 gen — cyber threat analysts
    'presale engineer',             // 1 gen — singular form (had 'presales')
    // TAG-10 S237: Phase 14 varied sample + desc reading
    'escalations engineer',         // 2 gen — escalation engineering
    'threat model',                 // 2 gen — threat modeling
    'release engineer',             // 4 gen — release engineering
    'jr. programmer',               // 1 gen — junior programmer
    'jr developer',                 // 1 gen — junior developer
    // TAG-10 S237: Phase 6 exhaustive title classification
    'implementation engineer',      // 4 gen — implementation/deployment engineering
    'engineering manager',          // 2 gen — engineering management
    // TAG-10 S237: Phase 9 random sample discovery
    'developer relations',          // 4 gen — DevRel engineering
    'it operations',                // 3 gen — IT operations roles
    // TAG-10 S238: title keyword gap analysis
    'front-end developer',          // 1 gen — hyphenated form (had 'frontend' but not 'front-end developer')
    'full-stack developer',         // 1 gen — hyphenated form (had 'full-stack engineer' but not developer)
    'power platform developer',     // 3 gen — Microsoft Power Platform development
    'cyber warfare',                // 2 gen — cyber warfare engineering (Booz Allen)
    'developer advocate',           // 2 gen — DevRel advocacy roles
    // TAG-11 S238: adaptive classifier cycle 2
    'internationalization engineer', // 1 gen, 0 FP — i18n engineering (Netflix)
    // TAG-11 S238: cycle 3 — 'integration designer' rejected: 'integration' in software catches first
    // TAG-11 S238: adaptive classifier cycle 4 (CACI)
    'broadcom administrator',        // 2 gen, 0 FP — VMware/Broadcom admin
    'itsm administrator',            // 1 gen, 0 FP — ITSM/ServiceNow admin
    'application administrator',     // 1 gen, 0 FP — application admin
    'patching engineer',             // 1 gen, 0 FP — patch management engineering
    'noc engineer',                  // 2 gen, 0 FP — network operations center
    'automated remediation',         // 1 gen, 0 FP — IT automated remediation
    'network operations center',     // 1 gen, 0 FP — NOC roles
    'mission it',                    // 1 gen, 0 FP — mission IT operator (defense)
    'computer network operator',     // 1 gen, 0 FP — CNO roles (defense)
    'infrastructure watch',          // 1 gen, 0 FP — NOSC infrastructure watch
    // TAG-11 S238: adaptive classifier cycle 5 (Booz Allen)
    'mumps developer',               // 1 gen, 0 FP — MUMPS/M programming
    'linux system engineer',         // 1 gen, 0 FP — Linux syseng
    'prisma access',                 // 1 gen, 0 FP — Palo Alto Prisma Access
    'm365 platform',                 // 1 gen, 0 FP — M365 platform owner
    'network firewall engineer',     // 1 gen, 0 FP — firewall engineering
    'cno developer',                 // 1 gen, 0 FP — computer network operations dev
    'cno analyst',                   // 2 gen, 0 FP — CNO analyst/programmer
    'helpdesk technician',           // 1 gen, 0 FP — helpdesk tech
    // TAG-11 S238: adaptive classifier cycle 6 (Leidos)
    'cyber infrastructure',          // 1 gen, 0 FP — cyber infrastructure specialist
    'gcp cyber',                     // 1 gen, 0 FP — GCP cyber engineer (USAF Cloud One)
    'network monitor',               // 1 gen, 0 FP — network monitor specialist
    'netops specialist',             // 1 gen, 0 FP — network operations specialist
    'noc technician',                // 1 gen, 0 FP — NOC technician
    'cross domain implementation',   // 1 gen, 0 FP — cross domain analyst
    // TAG-11 S238: adaptive classifier cycle 7 (Guidehouse)
    'celonis developer',             // 1 gen, 0 FP — Celonis process mining
    'workday integrations',          // 1 gen, 0 FP — Workday integrations
    'cyber risk assessment',         // 1 gen, 0 FP — cyber risk assessment analyst
    // TAG-11 S238: adaptive classifier cycle 9 (Boeing)
    // TAG-11 S238: adaptive classifier cycle 10 (Disney/GM/FLIR)
    'crowds artist',                    // 1 gen, 0 FP — VFX crowds artist (Disney)
    'pc garage',                        // 1 gen, 0 FP — PC garage technician (GM)
    'cognos administrator',             // 1 gen, 0 FP — Cognos BI admin (FLIR)

    'sap functional',                // 1 gen, 0 FP — SAP functional FI/CO analyst
    // TAG-11 S238: adaptive classifier cycle 11 (10-19 tier sample)
    'firewall engineer',             // 1 gen, 0 FP — firewall engineering (bare form)
    'computational imaging',         // 1 gen, 0 FP — computational imaging research
    // TAG-13 S238: cloud operations engineer is software, not hardware (O*NET maps to hardware)
    'cloud operations engineer',     // blocks O*NET hardware match for cloud ops roles
    // TAG-11 S238: adaptive classifier cycle 14 (OpenAI) — desc-verified
    'ml framework engineer',         // 1 gen, 0 FP — ML framework engineering
    'distributed training engineer', // 1 gen, 0 FP — distributed training (Sora)
    // TAG-11 S238: adaptive classifier cycle 15 (Cloudflare)
    'detection & mitigation',       // 1 gen, 0 FP — detection & mitigation engineering
    'developer educator',           // 1 gen, 0 FP — developer education
    'workday functional',           // 1 gen, 0 FP — Workday functional specialist
    // TAG-11 S238: adaptive classifier cycle 16 (CrowdStrike)
    'ai security consultant',       // 1 gen, 0 FP — AI security consulting
    'data protection analyst',      // 2 gen, 0 FP — data protection analysis
    'ng siem',                      // 1 gen, 0 FP — next-gen SIEM
    // TAG-11 S238: adaptive classifier cycle 17
    'technology evangelist',        // 1 gen, 0 FP — technology evangelist (Motorola)
    'premierone',                   // 1 gen, 0 FP — PremierOne records (Motorola)
    // TAG-11 S238: adaptive classifier cycle 18
    'civil construction software',  // 1 gen, 0 FP — civil construction software (Trimble)
    'erp business advisor',         // 1 gen, 0 FP — ERP business advisor (Trimble)
    // TAG-11 S238: cycle 22
    'coupa support',                // 1 gen, 0 FP — Coupa support network (Caterpillar)
    // TAG-11 S238: cycle 19
    'saas governance',              // 1 gen, 0 FP — SaaS governance (Prudential)
    // TAG-11 S238: cycle 20
    'sdn enterprise',               // 1 gen, 0 FP — SDN enterprise engineer (AIG)
    'fix onboarding',               // 1 gen, 0 FP — FIX protocol onboarding (Broadridge)
    // TAG-11 S238: cycle 21
    'it/ot infrastructure',         // 1 gen, 0 FP — IT/OT infrastructure (Elanco)
    // TAG-11 S238: cycle 23
    'dynamics 365',                 // 1 gen, 0 FP — Dynamics 365 developer
    // TAG-11 S238: cycle 24
    'threat collections',           // 1 gen, 0 FP — threat collections engineer (Anthropic)
    'mixed reality developer',      // 1 gen, 0 FP — mixed reality development (Palantir)
    // TAG-11 S238: cycle 26
    'field ciso',                   // 1 gen, 0 FP — field CISO (F5)
    // TAG-11 S238: cycle 27
    'endpoint engineer',            // 1 gen, 0 FP — endpoint engineering (Genentech)
    // TAG-11 S238: cycle 28
    'power platform consultant',    // 1 gen, 0 FP — Power Platform consultant (Guidehouse)
    // TAG-11 S238: cycle 30
    'ai governance',                // 1 gen, 0 FP — AI governance specialist (Guidehouse)
    // TAG-12 S238: moved from operations (CACI Job Category = Information Technology)
    'interface sustainment',         // 2 gen — interface sustainment analyst (IT role)
    // TAG-11 S239 C33: CACI (Job Category: Information Technology) + Guidehouse (cyber/SaaS)
    'sharepoint farm',              // 1 gen, 0 FP — SharePoint Farm Admin (CACI IT)
    'hbss',                         // 1 gen, 0 FP — HBSS/ESS Administrator (CACI IT)
    'pl/sql developer',             // 1 gen, 0 FP — PL/SQL Developer (CACI IT)
    'sap master data',              // 1 gen, 0 FP — SAP Master Data Governance SME (CACI IT)
    'ai context',                   // 1 gen, 0 FP — AI Context Engineer (CACI IT)
    'application monitoring',       // 1 gen, 0 FP — 24/7 Application Monitoring (CACI IT)
    'network access control',       // 1 gen, 0 FP — Network Access Control Engineer (CACI IT)
    'vulnerability management',     // 2 gen, 0 real FP — pre-existing ops misclassification (Astranis/Workday)
    'risk management framework',    // 1 gen, 0 FP — RMF Expert (Guidehouse Cyber)
    'rmf expert',                   // 1 gen, 0 FP — RMF Expert (Guidehouse Cyber, title-specific guard)
    'secops',                       // 1 gen, 0 FP — VulnMgmt & SecOps Specialist (Guidehouse)
    'icam',                         // 1 gen, 0 real FP — ICAM Eng (BAH ops misclassification)
    'microsoft power platform',     // 1 gen, 0 FP — Power Platform Consultant (Guidehouse)
    'multiplatform planning',       // 1 gen, 0 FP — Multiplatform Planning & Strategy (NBCUniversal)
    'on-platform strategy',         // 1 gen, 0 FP — On-Platform Strategy Specialist (NBCUniversal)
    'lighting and look dev',        // 1 gen, 0 FP — Lighting & Look Dev Tools Engineer (DreamWorks)
    'look dev tools',               // 1 gen, 0 FP — Look Dev Tools Engineer (DreamWorks, broader guard)
    'system integration technician', // 1 gen, 0 FP — System Integration Tech (NBCUniversal broadcast)
    'integration designer',         // 1 gen, 0 FP — Integration Designer (NBCUniversal)
    // TAG-11 S239 C35: RTX software
    'sap ariba',                    // 1 gen, 0 FP — SAP Ariba Cloud Integration Gateway Developer (RTX)
    'digital technology intern',    // 2 gen, 0 FP — Digital Technology Internship (RTX, Carrier)
    // TAG-11 S239 C36: Disney software
    'maximo administrator',         // 1 gen, 0 FP — Maximo Administrator (Disney Parks)
    'set extension artist',         // 1 gen, 0 FP — Set Extension Artist (Disney Animation CG)
  ];
  const isSalesRole = /\b(sales|account executive|pre-sales|presales)\b/i.test(title);
  // Guard: retail "Back End Clerk" is not a backend engineer (Lowe's — 6 FPs, S229)
  const isRetailClerk = /\b(clerk|stocker|cashier)\b/i.test(title);
  // TAG-MISROUTE-1 Issue 3a (S229): short keywords need word-boundary regex — includes() causes
  // "answer" → "anSWEr", "disrespect" → "diSREspect" false positives (509 + 151 FPs)
  const softwareShortKeywords = /\b(swe|sre)\b/i;
  // TAG-1 S233: guards for newly added software keywords
  // 'automation engineer' — HVAC/building/industrial automation is hardware, not software
  const isNonSwAutomation = /\b(hvac|building|industrial|process)\b/i.test(title);
  // 'security analyst' — physical security roles are not infosec
  const isPhysicalSecurity = /\bphysical\b/i.test(title);
  // 'engineering intern' — mechanical/civil/chemical/electrical interns are hardware
  const isNonSwEngineeringIntern = /\b(semiconductor|mechanical|civil|chemical|electrical|environmental)\b/i.test(title);
  // TAG-13: 'simulation engineer' — structural/mechanical/thermal simulation is hardware
  const isHwSimulation = /\b(structural|mechanical|thermal|finite element)\b/i.test(title);
  const matchesSoftware = (text) =>
    softwareKeywords.some(kw => text.includes(kw)) || softwareShortKeywords.test(text);
  // Guard: block guarded keywords only when they are the sole match
  const isGuardedSwOnly = (text) => {
    const matched = softwareKeywords.filter(kw => text.includes(kw));
    if (matched.length !== 1) return false; // multiple matches or short-kw → not solely guarded
    const sole = matched[0];
    if (sole === 'automation engineer' && isNonSwAutomation) return true;
    if (sole === 'security analyst' && isPhysicalSecurity) return true;
    if (sole === 'engineering intern' && isNonSwEngineeringIntern) return true;
    if (sole === 'simulation engineer' && isHwSimulation) return true;
    return false;
  };
  // TAG-MISROUTE-1 Issue 3b (S229): software domain is now TITLE-ONLY.
  // Description fallback removed — company boilerplate ("full stack technology platform",
  // "alongside our software engineers") caused 1,774 non-tech jobs to be tagged software.
  // Same approach as AI domain (title-only since inception). Keyword list expanded above
  // to compensate for legitimate roles lost.
  if (!isSalesRole && !isRetailClerk && matchesSoftware(title) && !isGuardedSwOnly(title)) {
    pushTag('software', findMatch(softwareKeywords, title) || (softwareShortKeywords.test(title) ? 'swe/sre regex' : null), 'title');
  }

  // AI domain (title-only — prevents description contamination misrouting general jobs)
  // Keywords derived from S78 Auditor sample of 33 intercepted AI-title jobs (all_jobs.json 2026-02-25)
  // TAXONOMY-AUDIT-1: 'llm' and 'nlp' use word-boundary regex — includes() caused
  // "fulfillment" → "fuLLMent" false positive (186 Lowe's jobs tagged AI, S228 finding).
  const aiKeywords = [
    'machine learning', 'computer vision', 'deep learning',
    'applied ai', 'ai engineer', 'ai researcher',
    'natural language processing',
    'large language model', 'generative ai',
    // INTERN-1a Wave 2:
    'ai/ml', 'genai', 'prompt engineer', 'ai tools',
    // TAG-1 S233: 'ai engineer' misses 'artificial intelligence engineer' (full phrase)
    'artificial intelligence',      // 7 hits — Artificial Intelligence Engineer (Booz Allen, Northrop)
    // TAG-6 S233: data-driven keyword gaps
    'ai deployment',                // 21 hits — AI deployment strategist (Mistral AI, Booz Allen)
    // TAG-10 S237: Phase 6 exhaustive title classification
    'applied researcher',           // 4 gen — applied AI/ML research (Capital One)
    // TAG-11 S238: adaptive classifier cycle 5 (Booz Allen)
    'ai solution developer',        // 1 gen, 0 FP — AI solution development
    // TAG-11 S238: adaptive classifier cycle 14 (OpenAI) — desc-verified
    'research inference',           // 1 gen, 0 FP — ML inference research
    'loss of control',              // 1 gen, 0 FP — AI safety (loss of control)
    'simulation realism',           // 1 gen, 0 FP — robotics simulation realism
    'frontier biological',          // 1 gen, 0 FP — frontier bio/chem risk research
    'researcher, training',         // 1 gen, 0 FP — ML training researcher
    'researcher, alignment',        // 1 gen, 0 FP — AI alignment researcher
    'researcher, trustworthy',      // 1 gen, 0 FP — trustworthy AI researcher
    'researcher, safety',           // 1 gen, 0 FP — AI safety researcher
    'researcher, interpretability', // 1 gen, 0 FP — interpretability researcher
    'researcher, pretraining',      // 1 gen, 0 FP — pretraining safety researcher
  ];
  const aiShortKeywords = /\b(llm|nlp)\b/i;
  if (aiKeywords.some(kw => title.includes(kw)) || aiShortKeywords.test(job.title || '')) {
    pushTag('ai', findMatch(aiKeywords, title) || (aiShortKeywords.test(job.title || '') ? 'llm/nlp regex' : null), 'title');
  }

  // Data Science domain (title-only — description fallback removed S233)
  // DESC-MIGRATE-1 moved descriptions to sidecars; all_jobs.json description field is always empty.
  // Description fallback was producing 0 current matches and 1,038 ghost tags.
  const dataScienceKeywords = [
    'data scientist', 'data science', 'data engineer', 'data analyst',
    'machine learning', 'ml engineer', 'ai engineer',
    // INTERN-1a Wave 2:
    'data analytics', 'applied science', 'operations research',
    'algorithm engineering', 'decision science', 'quantitative research',
    'research analyst',
    // FRESHNESS-3: GH general-tagged misclassification fixes (S179 Auditor data audit)
    'research scientist',           // Anthropic, DeepMind — data_science domain (3 confirmed misses)
    // TAG-1 S233: defense/enterprise title gaps
    'databricks',                   // 4 hits — Databricks engineer/developer (data platform)
    // TAG-6 S233: promoted from O*NET
    'applied scientist',            // 62 hits — applied science/ML roles
    // TAG-8 S237: FP audit keyword expansion
    'intelligence analyst',         // 27 hits — business intelligence + defense intelligence analysts
    // TAG-9 S237: Phase 5 vocabulary extraction
    'quantum computing',            // 4 gen, 80% spec — quantum computing research/engineering
    'business intelligence',        // 3 gen — BI engineer/analyst (bare form)
    // TAG-10 S237: Phase 3 normalized title sweep
    'analytics engineer',           // 6 gen — analytics/data engineering
    // TAG-10 S237: Phase 6 exhaustive title classification
    'data visualization',           // 5 gen — data visualization analysts
    'bioinformatics',               // 3 gen — bioinformatics specialists
    'data quality',                 // 2 gen — data quality analysts
    // TAG-11 S238: adaptive classifier cycle 2
    'survey analyst',               // 1 gen, 0 FP — survey/employee listening analysis
    'causal inference',             // 1 gen, 0 FP — experimentation/causal inference
    // TAG-11 S238: adaptive classifier cycle 3
    'people analytics',             // 2 gen, 0 FP — people/HR analytics (NBCU)
    'subscriber forecasting',       // 1 gen, 0 FP — subscriber forecasting (NBCU)
    // TAG-11 S238: adaptive classifier cycle 12 (10-19 tier sample)
    'measurement science',          // 2 gen, 0 FP — measurement science
    // TAG-11 S238: adaptive classifier cycle 13 (DoorDash)
    'media analytics',              // 1 gen, 0 FP — media analytics
    // TAG-11 S238: adaptive classifier cycle 16 (S&P Global)
    'power modeling',                // 2 gen, 0 FP — power/energy modeling
    // TAG-11 S238: adaptive classifier cycle 18
    'content analyst',               // 1 gen, 0 FP — content analyst (Bloomberg)
    // TAG-11 S238: cycle 27
    'content analytics intern',      // 1 gen, 0 FP — content analytics intern (Bloomberg)

    // TAG-11 S238: adaptive classifier cycle 5 (Booz Allen)
    'elint',                        // 1 gen, 0 FP — electronic intelligence analysis
    'signals analyst',              // 1 gen, 0 FP — signals analysis (defense)
    'signals intelligence',         // 1 gen, 0 FP — SIGINT officer
    // TAG-11 S238: adaptive classifier cycle 6 (Leidos)
    'fisint',                       // 1 gen, 0 FP — foreign instrumentation signals
    'biometrics analyst',           // 1 gen, 0 FP — biometrics analysis
    'afsim analyst',                // 1 gen, 0 FP — AFSIM modeling/simulation
  ];
  if (dataScienceKeywords.some(kw => title.includes(kw))) {
    pushTag('data_science', findMatch(dataScienceKeywords, title), 'title');
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
    // INTERN-1a Wave 2:
    'analog', 'mixed-signal', 'ic design', 'dsp', 'power electronics',
    'thermal engineer', 'propulsion', 'turbomachinery', 'fluid component',
    'ground systems', 'radiation effects', 'harness manufacturing',
    'electrical integration', 'cad engineer', 'industrial engineering',
    'quality engineer', 'hardware development engineer', 'electrical design',
    'package engineering', 'signal integrity', 'asic',
    'process integration', 'process safety', 'optical engineer',
    'structural engineer', 'aerospace engineer', 'lidar engineer',
    'physical design', 'plasma etch', 'plasma deposition', 'plasma process', 'reliability engineer', 'equipment engineer',
    'biomedical engineer', 'chemical engineer', 'field applications engineer',
    'application engineer', 'gnc engineer', 'radar engineer',
    'performance engineering', 'wireless system',
    // TAG-OVERHAUL-A additions (verified safe by title + company context):
    'controls integration engineer',  // Amazon DC hardware
    'field service engineer',         // ASML/HP/Caterpillar equipment install
    'verification engineer',          // chip design: logic/timing/functional verification
    'dft engineer',                   // Design-for-Test, semiconductor
    'emulation engineer',             // pre-silicon hardware emulation
    'board validation engineer',      // PCB/hardware bring-up
    'ic verification engineer',       // IC-level verification
    'gpu design verification',        // GPU silicon verification
    'cpu verification',               // CPU silicon verification
    // TAG-CATEGORY-REDESIGN Option 2 (S207 Strategist vocabulary audit — ~71 general+US reclassifications)
    'distribution engineer',              // 15 hits — vehicle/electrical distribution
    'supplier development engineer',      // ~12 hits — electronics/hardware supply chain (SpaceX Starshield, etc.)
    'commissioning engineer',             // 12 hits — equipment bring-up (Amazon DC, data centers)
    'electronics engineer',               // 9 hits — hardware/electronics domain
    'maintenance engineer',               // 7 hits — equipment maintenance (SpaceX/Tesla factory floor)
    'power systems automation engineer',  // 3 hits — electrical grid automation
    'power systems protection engineer',  // 3 hits — electrical grid protection
    'substation protection',              // 3 hits — electrical infrastructure (NOT added: 'substation engineer' bare — too broad)
    'substation control engineer',        // 1 hit — electrical infrastructure
    'photonic packaging engineer',        // 1 hit — semiconductor optics (NOT added: 'packaging engineer' bare — mfg FP risk)
    // TAG-1 S233: G1 keyword expansion — 275 US general reclassifications
    'field service technician',           // 52 hits — equipment/field service (Leidos, Johnson Controls)
    'service technician',                 // 141 hits — HVAC/fire/equipment service (guard: not customer service)
    'installation technician',            // 13 hits — equipment installation
    'product development engineer',       // 19 hits — hardware R&D (SpaceX, Abbott)
    'field service representative',       // 50 hits — field equipment service reps
    // TAG-1 S233: defense/enterprise title gaps — 24 US reclassifications
    'rf engineer',                        // 15 hits — RF engineering (SpaceX, Leidos, CACI)
    'signal processing',                  // 9 hits — DSP/signal processing engineer
    // TAG-6 S233: promoted from O*NET
    'operations engineer',                // 57 hits — plant/process operations engineering
    'development engineer',               // 47 hits — R&D/product development engineering
    'industrial engineer',                // 25 hits — industrial/manufacturing engineering
    'test specialist',                    // 22 hits — hardware/equipment test
    'validation engineer',                // 19 hits — hardware/process validation
    // TAG-6 S233: data-driven keyword gaps
    'safety engineer',                    // 23 hits — fire/systems/aerospace safety (SOC 17)
    // TAG-8 S237: FP audit keyword expansion
    'electrician',                        // 29 hits — maintenance/industrial electricians (SpaceX, utilities)
    'hvac',                               // 37 hits — HVAC technician/programmer/controls (all hardware)
    // TAG-9 S237: Phase 1 keyword expansion (verified against full pool)
    'cad designer',                       // 5 hits — CAD/civil CAD design roles
    'lab engineer',                       // 4 hits — hardware lab engineers (Amazon, etc.)
    'fire alarm',                         // 1 hit — fire alarm designer/installer
    'fire protection',                    // 1 hit — fire protection EIT
    'geologist',                          // 1 hit — early career geologist
    // TAG-9 S237: Phase 3 keyword expansion (from live pipeline residual analysis)
    'field engineer',                     // 22 hits — field engineering roles (Johnson Controls, etc.)
    'compliance engineer',                // 8 hits — product/regulatory compliance (legal guard blocks legal tagging)
    'field specialist',                   // 14 hits — field service specialists
    // TAG-9 S237: Phase 4 keyword expansion (3,248 general jobs with role words)
    'production engineer',                // 4 hits — production/manufacturing engineering
    'facilities engineer',                // 3 hits — facilities/building engineering
    'applications engineer',              // 3 hits — field applications engineering
    'weld engineer',                      // 3 hits — welding engineering
    'electronic technician',              // 3 hits — electronics bench technicians
    'fire detection',                     // 3 hits — fire detection systems
    'data center operations',             // 3 hits — DC operations technician/engineer
    'diagnostic technician',              // 4 gen — diagnostic/test technicians (Jabil)
    'electrical installer',               // 3 gen — electrical installation (JCI)
    'biomedical equipment',               // 5 gen — biomedical equipment technicians
    'design release engineer',            // 5 gen — design release engineering (GM)
    'product review engineer',            // 3 gen — product review/liaison engineering
    'analysis engineer',                  // 12 gen — structural/thermal analysis engineering
    // TAG-10 S237: Layer 5 title classification sweep
    'naval architect',                    // 1 gen — naval architecture/marine design
    'production pilot',                   // 1 gen — production test pilots
    'radar operator',                     // 1 gen — radar test operations
    'piping design',                      // 2 gen — piping/process design
    'test planner',                       // 1 gen — test planning engineering
    // TAG-10 S237: Phase 6 exhaustive title classification
    'fire installer',                     // 3 gen — fire system installers
    'energy analyst',                     // 2 gen — energy systems analysis
    'nuclear',                            // 2 gen — nuclear engineering
    'journeyman',                         // 3 gen — journeyman tradespeople
    // TAG-10 S237: Phase 8 trigram analysis
    'automated logic',                    // 7 gen — building automation (Johnson Controls)
    // TAG-10 S237: Phase 9 random sample discovery
    'wireless engineer',                  // 3 gen — wireless/RF engineering
    'laser',                              // 1 gen — laser technician/engineer
    'servo',                              // 1 gen — servo control engineering
    'hydrodynamic',                       // 1 gen — hydrodynamic engineering
    'material scientist',                 // 1 gen — materials science
    // TAG-10 S237: Phase 10 random sample reading
    'hardware technician',                // 3 gen — hardware bench technicians
    'rf communications',                  // 1 gen — RF communications engineering
    'design for test',                    // 1 gen — DFT engineering
    // TAG-10 S237: Phase 11 random sample + plural fixes
    'electronics technician',             // 8 gen — plural form (had 'electronic technician')
    'solder technician',                  // 4 gen — soldering technicians
    'physicist',                          // 3 gen — physics/applied physics
    'circuit design',                     // 2 gen — circuit design (was desc phrase only)
    // TAG-10 S237: Phase 12 random sample
    'fire sprinkler',                     // 3 gen — fire sprinkler installers
    'electrical eit',                     // 1 gen — electrical EIT roles
    'sheet metal technician',             // 2 gen — sheet metal work
    'calibration',                        // 9 gen — calibration technicians/engineers
    // TAG-10 S237: Phase 13 varied sample
    'powertrain',                         // 4 gen — powertrain engineering
    'thin films',                         // 2 gen — thin film technicians
    'environmental scientist',            // 2 gen — environmental science
    // TAG-10 S237: Phase 14 varied sample
    'solar technician',                   // 1 gen — solar panel technicians
    'electrical technician',              // 4 gen — electrical techs (different from electronic)
    'frac technician',                    // 1 gen — hydraulic fracturing
    'power engineer',                     // 4 gen — power systems engineering (SEL)
    'transmission line',                  // 1 gen — transmission line engineering (SEL)
    // TAG-9 S237: Phase 5 vocabulary extraction
    'r&d engineer',                       // 17 gen, 100% spec — R&D engineering
    'service engineer',                   // 13 gen, 98% spec — field/service engineering
    'systems technician',                 // 11 gen, 75% spec — systems/electronics tech
    'controls systems',                   // 9 gen, 85% spec — controls/automation
    'engineering tech',                   // 6 gen, 80% spec — engineering technician (short form)
    // TAG-9 S237: Phase 6 keyword sweep
    'structural bim',                     // 4 gen — structural BIM technician
    'performance engineer',               // 4 gen — perf/thermal/systems engineering
    'upgrade install',                    // 5 gen — installation/relocation engineering
    // TAG-11 S238: adaptive classifier cycle 3
    'motorsports tire',                   // 2 gen, 0 FP — motorsports tire engineering (Oshkosh)
    'heavy duty ev',                      // 1 gen, 0 FP — heavy-duty EV technician (Oshkosh)
    // TAG-11 S238: adaptive classifier cycle 5 (Booz Allen)
    'microelectronics sme',               // 1 gen, 0 FP — radiation hardened microelectronics
    'combat systems integration',         // 1 gen, 0 FP — naval combat systems
    // TAG-11 S238: adaptive classifier cycle 6 (Leidos)
    'radar modeling',                     // 1 gen, 0 FP — radar modeling engineer
    'substation engineer',                // 1 gen, 0 FP — electrical substation engineer
  
    // TAG-11 S238: adaptive classifier cycle 8 (RTX + KBR)
    'metallurgical engineer',             // 2 gen, 0 FP — metallurgical engineering
    'platform cots',                      // 1 gen, 0 FP — COTS platform engineering
    'mrb engineer',                       // 1 gen, 0 FP — material review board engineering
    'nssms technician',                   // 1 gen, 0 FP — NATO SEASPARROW technician
    'field service supervisor',           // 1 gen, 0 FP — field service supervision
    'radar sme',                          // 1 gen, 0 FP — radar subject matter expert
    '3d reconstruction',                  // 1 gen, 0 FP — 3D reconstruction
    'digital modeling',                   // 1 gen, 0 FP — digital modeling engineer
    'lidar intern',                       // 1 gen, 0 FP — lidar internship
    'protected satcom',                   // 1 gen, 0 FP — protected SATCOM
    'pressure systems',                   // 1 gen, 0 FP — pressure systems specialist
    // TAG-11 S238: adaptive classifier cycle 9 (AbbVie)
    // TAG-11 S238: adaptive classifier cycle 10 (Bosch/Disney/GM/SpaceX/FLIR)
    'hydrogen electrolyzer',                // 1 gen, 0 FP — H2 electrolyzer simulation (Bosch)
    'biosensor intern',                     // 1 gen, 0 FP — biosensor internship (Bosch)
    'laboratory engineer',                  // 1 gen, 0 FP — laboratory engineering (Bosch)
    'media replay',                         // 2 gen, 0 FP — media replay operator (Disney)
    'motorsports aero',                     // 1 gen, 0 FP — motorsports aero data (GM)
    'motorsports vehicle dynamics',         // 1 gen, 0 FP — motorsports dynamics (GM)
    'ress process',                         // 2 gen, 0 FP — RESS process HV tech (GM)
    'creative seat designer',               // 1 gen, 0 FP — seat design (GM)
    'loads and dynamics',                   // 2 gen, 0 FP — loads/dynamics engineer (SpaceX)
    'recovery engineer',                    // 1 gen, 0 FP — recovery engineer (SpaceX)
    'mechanisms engineer',                  // 1 gen, 0 FP — mechanisms engineer (SpaceX)

    'chiller system',                     // 1 gen, 0 FP — chiller system technician
    // TAG-11 S238: adaptive classifier cycle 17
    'shoulder r&d',                       // 1 gen, 0 FP — shoulder R&D (J&J)
    'mechanical simulation',              // 3 gen, 0 FP — mechanical simulation (WD)
    'sot reader',                         // 1 gen, 0 FP — SOT reader film research (WD)
    'hdd testing',                        // 1 gen, 0 FP — HDD testing (WD)
    // TAG-11 S238: cycle 20
    'cmf designer',                       // 1 gen, 0 FP — CMF designer (Polaris)
    'field technician- water',            // 1 gen, 0 FP — water resources field tech (RE/SPEC)
    'land development',                   // 4 gen, 0 FP — land development (RE/SPEC)
    // TAG-11 S238: cycle 23
    'engine systems integration',         // 1 gen, 0 FP — engine systems integration
    // TAG-11 S238: cycle 24
    'robot optics',                       // 1 gen, 0 FP — robot optics (Neuralink)
    'neuroengineer',                      // 1 gen, 0 FP — neuroengineering (Neuralink)
    'engineer structural',                // 1 gen, 0 FP — structural engineering (Northrop)
    // TAG-11 S238: cycle 26
    'permeability modifier',              // 1 gen, 0 FP — permeability modifier (Baker Hughes)
    'battery responsible engineer',       // 1 gen, 0 FP — battery responsible eng (Blue Origin)
    // TAG-11 S238: cycle 28
    'av associate',                       // 1 gen, 0 FP — AV associate (Braze)
    // TAG-11 S238: cycle 30
    'yield enhancement',                  // 1 gen, 0 FP — yield enhancement engineer (Micron)
    // TAG-11 S238: cycle 21
    'healthcare spatial designer',        // 1 gen, 0 FP — healthcare spatial design (Philips)
    'drafter/ designer',                  // 1 gen, 0 FP — drafter/designer (SEL)
    'membrane r&d',                       // 1 gen, 0 FP — membrane R&D (Veolia)
    // TAG-11 S238: adaptive classifier cycle 18
    'cad technical designer',             // 1 gen, 0 FP — CAD technical designer (Blue Origin)
    'phase integrator',                   // 1 gen, 0 FP — phase integrator (Blue Origin)
    'materials and process',               // 2 gen, 0 FP — M&P engineer (Blue Origin)
    // TAG-11 S238: adaptive classifier cycle 11
    'implant account',                    // 1 gen, 0 FP — implant account technologist
    'architecture intern',                // 1 gen, 0 FP — chip architecture internship
    // TAG-11 S239 C34: Boeing aerospace hardware
    'cca design',                         // 1 gen, 0 FP — Digital CCA Design (circuit card assembly)
    'flight line',                        // 2 gen, 0 FP — F-15 Flight Line Technician (Boeing)
    'ordnance technician',                // 1 gen, 0 FP — F/A-18 Ordnance Technician (Boeing)
    'sustainment engineer',               // 1 gen, 0 FP — F-15EX/IA Sustainment Engineer (Boeing)
    'retrofit technical',                 // 1 gen, 0 FP — Retrofit Technical Specialist (Boeing)
    'mp&p engineer',                      // 1 gen, 0 real FP — MP&P = Materials Processes Physics
    'airworthiness',                      // 1 gen, 0 real FP — Airworthiness Support (pre-existing legal FP)
    'guidance navigation & control',      // 1 gen, 0 FP — GNC Engineer (avoids Anduril software FP)
    'system health engineer',             // 1 gen, 0 FP — Reliability & System Health Engineer (Boeing)
    'mass properties engineer',           // 1 gen, 0 FP — Weights & Mass Properties Engineer (Boeing)
    'training device technician',         // 1 gen, 0 FP — Training Device Technician Flight Sim (Boeing)
    'tech pubs',                          // 1 gen, 0 FP — Chinook Tech Pubs Author (Boeing)
    // TAG-11 S239 C35: RTX defense hardware
    'ltamds',                             // 1 gen, 0 FP — LTAMDS Program Integrator (RTX)
    'slcm-n',                             // 1 gen, 0 FP — SLCM-N Program Integrator (RTX)
    'coyote block',                       // 1 gen, 0 FP — Coyote Block 3 Chief Engineer (RTX)
    'patriot missile',                    // 1 gen, 0 FP — Technical Aide Patriot Missile (RTX)
    'javelin joint venture',              // 1 gen, 0 FP — Javelin JV Portfolio Chief Engineer (RTX)
    'f135 fse',                           // 1 gen, 0 FP — F135 FSE Cherry Point (RTX)
  ];
  // Guard: 'service technician' — exclude 'customer service technician' (not hardware)
  const matchesHardware = hardwareKeywords.some(kw => title.includes(kw));
  if (matchesHardware) {
    // Only block if the sole match is 'service technician' AND title contains 'customer service'
    const isOnlyServiceTech = title.includes('service technician') &&
      !hardwareKeywords.some(kw => kw !== 'service technician' && title.includes(kw));
    const isCustomerServiceTech = /\bcustomer service\b/i.test(title);
    // TAG-13: 'operations engineer' in cloud/devops/SRE context is software, not hardware
    const isCloudOpsEng = title.includes('operations engineer') &&
      /\b(cloud|devops|site reliability|platform)\b/i.test(title) &&
      !hardwareKeywords.some(kw => kw !== 'operations engineer' && title.includes(kw));
    if (!(isOnlyServiceTech && isCustomerServiceTech) && !isCloudOpsEng) {
      pushTag('hardware', findMatch(hardwareKeywords, title), 'title');
    }
  }

  // Healthcare domain (title-only — short credentials use word-boundary regex)
  // Previously named 'nursing' — renamed TAG-OVERHAUL-B to reflect actual coverage (PT, pharmacist, etc.)
  const healthcareExact = [
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
    // TAG-OVERHAUL-B additions (492 additional clinical jobs in 'general'):
    'anesthetist', 'anesthesia technician',
    'mri technologist', 'echocardiography technologist', 'echo technician',
    'ekg technician', 'ekg tech',
    'radiation therapist',
    'endoscopy technician',
    'clinical research coordinator',
    'patient service representative', 'patient service specialist',
    'patient access rep',
    'patient transporter',
    'medical office specialist',
    'lab support technician', 'laboratory assistant',
    'behavioral health',
    'histotechnologist',
    'prior authorization specialist',
    'child life specialist',
    'exercise physiologist',
    'medical technologist',
    'medical interpreter',
    // GENERAL-CLASSIFICATION additions (S223 — +376 verified from live pool):
    'physician',                // PRN Emergency Medicine Physician, Faculty Physician
    'pharmacy intern',          // pharmacy intern roles not caught by 'pharmacy tech' / 'pharmacist'
    'clinical technician',      // clinical lab/hospital techs
    'clinical specialist',      // clinical device/product specialists
    'clinical associate',       // clinical support roles
    'medical screener',         // intake/screening roles
    'medical scribe',           // documentation support
    'radiology tech',           // shorthand caught by 'radiology technologist' longer form too
    'dental assistant',         // dental clinic support
    'dental hygienist',         // dental clinical
    'veterinary',               // vet tech, veterinary assistant
    'ophthalmic',               // ophthalmic tech, ophthalmic assistant
    'cardiac tech',             // cardiac monitoring/telemetry
    'health educator',          // public health education roles
    'public health',            // public health analyst/coordinator
    // TAG-1 S233: G1 keyword expansion — 197 US general reclassifications
    'plasma center technician',     // 35 hits — Takeda/BioLife plasma donation techs
    'laboratory technician',        // 18 hits — clinical/hospital lab techs
    'lab technician',               // 18 hits — shortened form
    'oncology',                     // 54 hits — oncology specialist/rep (medical device/pharma)
    'clinical territory',           // 17 hits — clinical territory associate/manager (medical device)
    'spine specialist',             // 25 hits — associate spine specialist (Medtronic/Stryker)
    'interventional specialist',    // 14 hits — interventional cardiology/radiology (Medtronic)
    'phlebotom',                    // 16 hits — phlebotomist/phlebotomy (prefix match)
    // TAG-1 S233: SR general rate investigation — 43 US reclassifications
    'cardiovascular',               // 30 hits — cardiovascular nurse/consultant/hospitalist (AbbVie, Medtronic)
    'endoluminal',                  // 6 hits — endoluminal territory associate (medical device)
    'health services',              // 7 hits — health services coding/admin
    // TAG-1 S233: deep-dive residual gaps
    'patient account',              // 19 hits — patient account representative (hospital billing)
    'clinical psychologist',        // 3 hits — clinical psych roles (defense/VA)
    // TAG-6 S233: data-driven keyword gaps
    'surgical consultant',          // 7 hits — medical device surgical consulting
    'clinical account',             // 18 hits — clinical account specialist (med device/pharma)
    'neurophysiologist',            // 25 hits — neuromonitoring roles
    // TAG-8 S237: FP audit keyword expansion
    'psychiatrist',                 // 9 hits — psychiatrist roles (Talkiatry, defense/VA)
    'counselor',                    // 9 hits — military family life counselors, mental health counselors
    // TAG-9 S237: Phase 1 keyword expansion
    'veterinarian',                 // 3 hits — professional services veterinarians
    'microbiologist',               // 1 hit — microbiology/sterilization roles
    'chemist',                      // 11 hits — analytical/QC/synthetic chemists
    // TAG-9 S237: Phase 5 vocabulary extraction
    'research associate',           // 15 gen, 89% spec — clinical/medical research associates
    // 'mental health' moved to regex guard below — 'environmental' contains 'mental' substring (TAG-13 S238)
    'medical laboratory',           // 6 gen, 100% spec — medical lab technologists
    // TAG-9 S237: Phase 6 keyword sweep
    'clinical quality',             // 4 gen — clinical quality assurance
    'clinical trial',               // 4 gen — clinical trial statistics/management
    // TAG-10 S237: Phase 4 bigram sweep
    'associate scientist',          // 9 gen — biotech/pharma research scientists
    // TAG-10 S237: Layer 5 title classification sweep
    'medical coding',               // 1 gen — medical coding/billing
    'lab analyst',                  // 2 gen — laboratory analysts
    // TAG-10 S237: Phase 6 exhaustive title classification
    'clinical integration',         // 2 gen — clinical integration team leads
    'formulation scientist',        // 3 gen — pharmaceutical formulation
    // TAG-10 S237: Phase 8 trigram analysis
    'clinical consultant',          // 4 gen — clinical consulting roles
    // TAG-10 S237: Phase 9 random sample discovery
    'dental',                       // 3 gen — dental field roles (bare form)
    // TAG-10 S237: Phase 12 random sample
    'medical biller',               // 3 gen — medical billing
    'proteomics',                   // 1 gen — proteomics research
    // TAG-10 S238: title keyword gap analysis
    'clinical lab',                 // 4 gen, 2 FP — clinical laboratory roles
    // TAG-11 S238: adaptive classifier cycle 1
    'inpatient coding',             // 1 gen, 0 FP — medical coding
    'patient access',               // 1 gen, 0 FP — patient registration/access
    // TAG-11 S238: adaptive classifier cycle 6 (Leidos)
    'industrial hygiene',           // 1 gen, 0 FP — industrial hygiene technician
    // TAG-11 S238: adaptive classifier cycle 7 (Guidehouse)
    'him coding',                   // 1 gen, 0 FP — health info management coding
    'payer enrollment',             // 1 gen, 0 FP — healthcare payer enrollment
    'release of information',       // 1 gen, 0 FP — medical records release
    'admitting representative',     // 3 gen, 0 FP — hospital admitting
    'patient relations',            // 1 gen, 0 FP — patient relations
    'clinical documentation improvement', // 1 gen, 0 FP — CDI specialist
    'credit balance specialist',    // 1 gen, 0 FP — healthcare credit balance
    'cash poster',                  // 1 gen, 0 FP — healthcare payment posting
    'birth clerk',                  // 1 gen, 0 FP — birth records clerk
    'electron microscopy',          // 1 gen, 0 FP — EM laboratory
  
    // TAG-11 S238: adaptive classifier cycle 8 (KBR)
    'licensed psychologist',         // 1 gen, 0 FP — licensed psychologist
    'immunologist',                  // 1 gen, 0 FP — immunology
    'strength and conditioning',     // 1 gen, 0 FP — S&C specialist
    // TAG-11 S238: adaptive classifier cycle 9 (AbbVie)
    // TAG-11 S238: adaptive classifier cycle 12
    'molecular geneticist',          // 1 gen, 0 FP — molecular geneticist
    // TAG-11 S238: adaptive classifier cycle 15 (Biogen)
    'pharmacovigilance',             // 1 gen, 0 FP — pharmacovigilance scientist
    'regulatory cmc',                // 1 gen, 0 FP — regulatory CMC lead
    // TAG-11 S238: adaptive classifier cycle 17
    'lab technologist',              // 1 gen, 0 FP — laboratory technologist (Moog)
    'msl head',                      // 1 gen, 0 FP — MSL head (J&J)
    'hcp engagements',               // 1 gen, 0 FP — HCP engagements analyst (J&J)
    // TAG-11 S238: cycle 19
    'pcr assay',                     // 1 gen, 0 FP — PCR assay development (IDEXX)
    'clinical pathology',            // 1 gen, 0 FP — clinical pathology (IDEXX)
    // TAG-11 S238: cycle 21
    'upstream qbd',                  // 1 gen, 0 FP — upstream QbD development (Elanco)
    // TAG-11 S238: cycle 27
    'biologist',                     // 1 gen, 0 FP — biologist (Guidehouse)
    // TAG-11 S238: cycle 31
    'comparative medicine',          // 1 gen, 0 FP — comparative medicine (Intuitive)
    'health solution specialist',    // 2 gen, 0 FP — health solution specialist (USAA)
    // TAG-11 S238: cycle 23
    'revenue cycle coordinator',     // 2 gen, 0 FP — revenue cycle coordinator
    // TAG-11 S238: cycle 26
    'revenue cycle case',            // 1 gen, 0 FP — revenue cycle case mgmt (athenahealth)
    'patient experience specialist', // 1 gen, 0 FP — patient experience

    // TAG-11 S238: adaptive classifier cycle 10 (GM)
    'ergonomist',                   // 1 gen, 0 FP — ergonomist

    'purification development',      // 1 gen, 0 FP — protein purification R&D
    'scientific compliance',         // 1 gen, 0 FP — scientific compliance
    'biologics drug substance',      // 1 gen, 0 FP — biologics drug substance
    'peptide synthesis',             // 1 gen, 0 FP — peptide synthesis
    'translational precision medicine', // 1 gen, 0 FP — translational precision medicine
    // TAG-11 S239 C33: Guidehouse healthcare roles
    'hematopathologist',            // 1 gen, 0 FP — Hematopathologist (Guidehouse)
    'ip quality reviewer',          // 1 gen, 0 FP — Remote IP Quality Reviewer (Guidehouse HIM)
    'hospital admissions rep',      // 2 gen, 0 real FP — fixes misclassified ops→healthcare (Guidehouse)
  ];
  // \bnurse\b catches bare 'nurse' titles (charge nurse, nurse educator, etc.)
  // without matching 'nursery'. Short credentials use word-boundary to avoid false positives.
  // AEMT (Advanced EMT) added as word-boundary credential.
  const healthcareCredentials = /\b(nurse|rn|lpn|cna|crna|np|aemt|emt)\b/i;
  // 'social worker' only in hospital context — title-match is sufficient since hospital Workday tenants
  // won't title non-clinical social work roles as 'social worker' without qualification
  const healthcareOther = ['social worker', 'medical social worker', 'clinical social worker'];
  // TAG-13: 'mental health' uses word-boundary regex — 'environmental' contains 'mental' substring
  const mentalHealthRegex = /\bmental health\b/i;
  if (
    healthcareExact.some(kw => title.includes(kw)) ||
    healthcareCredentials.test(title) ||
    healthcareOther.some(kw => title.includes(kw)) ||
    mentalHealthRegex.test(title)
  ) {
    const hcMatch = findMatch(healthcareExact, title) || (healthcareCredentials.test(title) ? 'credential regex' : null) || findMatch(healthcareOther, title) || (mentalHealthRegex.test(title) ? 'mental health (regex)' : null);
    pushTag('healthcare', hcMatch, 'title');
  }

  // Finance / Quant domain (title-only — function-based, not employer-based)
  // Matches quant trading/research roles regardless of which firm posts them.
  // GENERAL-CLASSIFICATION expansion: added banking/accounting roles (S223).
  // Guard: SWE roles at trading firms stay tagged 'software' — function matters, not employer.
  const financeKeywords = [
    'quantitative trader', 'quantitative researcher', 'quantitative developer',
    'quantitative analyst', 'quant trader', 'quant researcher', 'quant developer',
    'quant strategist', 'quant analyst', 'trading engineer', 'trading strategist',
    'broker trader', 'floor trader', 'options trader', 'derivatives trader',
    'algorithmic trader', 'algo trader', 'market maker', 'execution trader',
    'investment analyst', 'portfolio analyst', 'risk analyst',
    // GENERAL-CLASSIFICATION additions (S223 — +1,859 verified from live pool):
    'financial analyst', 'financial advisor', 'financial consultant',
    'financial counselor', 'financial representative', 'financial service',
    'loan officer', 'credit analyst',
    'teller',                   // bank teller — #1 hit (1,400+ jobs from WF/BofA/Chase/PNC)
    'accountant',               // accountant — (bare 'accounting' NOT added: 'Accounting Technology Consultant' FP)
    'tax analyst', 'payroll',
    'treasury analyst',
    'actuary', 'actuarial',
    'underwriter',
    'personal banker', 'universal banker', 'banker', // retail banking roles
    // TAG-1 S233: G1 keyword expansion — 62 US general reclassifications
    'property adjuster',            // 35 hits — property/auto claims adjusters (insurance)
    'branch ambassador',            // 27 hits — bank branch ambassadors (Capital One, Chase)
    // TAG-6 S233: promoted from O*NET
    'finance analyst',              // 19 hits — financial analysis roles
    // TAG-6 S233: data-driven keyword gaps
    'investment consultant',        // 14 hits — wealth management consulting
    'cost control analyst',         // 12 hits — defense program cost analysis
    'client relationship',          // 21 hits — Morgan Stanley/WF client relationship analyst
    // TAG-8 S237: FP audit keyword expansion
    'private wealth',               // 11 hits — Morgan Stanley/Goldman private wealth associate/officer
    'client service associate',     // 84 hits — Morgan Stanley/Ameriprise FINRA-licensed wealth mgmt
    'finance intern',               // 9 hits — finance internship roles
    // TAG-9 S237: Phase 1 keyword expansion
    'claims adjuster',              // 5 hits — property/commercial/marine insurance adjusters
    'claims examiner',              // 4 hits — disability/accident/federal claims examiners
    'injury adjuster',              // 3 hits — personal injury insurance adjusters
    // TAG-9 S237: Phase 3 keyword expansion
    'accounting intern',            // 5 hits — accounting internship roles
    // TAG-9 S237: Phase 4 keyword expansion
    'pricing analyst',              // 4 hits — pricing/revenue analysis
    'fp&a',                         // 3 hits — financial planning & analysis
    // TAG-9 S237: Phase 6 keyword sweep
    'client service excellence',    // 8 gen — Morgan Stanley FINRA-licensed reps
    'client service specialist',    // 6 gen — Morgan Stanley client service
    // TAG-10 S237: Claude-classified per-company keywords
    'planning consultant',          // 48 gen — Fidelity financial planning consultants
    'retirement income',            // 6 gen — USAA retirement income advisors
    'insurance professional',       // 5 gen — USAA insurance sales
    'wealth management associate',  // 3 gen — Morgan Stanley wealth advisory
    'risk officer',                 // 3 gen — Morgan Stanley risk/compliance
    'auto adjuster',                // 6 gen — auto insurance adjusters (USAA)
    'auto service representative',  // 1 gen — auto insurance service (Hartford)
    // TAG-10 S237: Phase 4 bigram sweep
    'life solutions',               // 12 gen — USAA life insurance specialists
    'corporate development',        // 10 gen — M&A/corporate strategy
    // TAG-10 S237: Phase 6 exhaustive title classification
    'ultra high net worth',         // 3 gen — UHNW client service (Vanguard)
    'risk strategist',              // 2 gen — risk strategy roles
    'cost analyst',                 // 7 gen — cost analysis roles
    'underwriting',                 // 7 gen — insurance underwriting
    // TAG-10 S237: Phase 9 random sample discovery
    'fraud',                        // 6 gen — fraud investigation/analysis
    'controllership',               // 1 gen — financial controllership
    'compliance aml',               // 2 gen — AML compliance
    // TAG-10 S237: Phase 10 random sample reading
    'originations',                 // 5 gen — loan/mortgage originations
    'economist',                    // 3 gen — research economists
    'quantitative modeler',         // 1 gen — quant modeling
    'quantitative trading',         // 1 gen — quant trading (had 'trader' not 'trading')
    'loan servicing',               // 1 gen — loan servicing roles
    'budget analyst',               // 1 gen — budget analysis
    'cost and schedule',            // 3 gen — program cost/schedule control
    // TAG-10 S237: Phase 12 random sample
    'workers compensation',         // 1 gen — workers comp claims
    'reinsurance',                  // 1 gen — reinsurance analysis
    'remittance processing',        // 6 gen — payment processing
    'business service officer',     // 5 gen — financial services officers
    'fund accounting',              // 4 gen — fund accounting/administration
    'private equity',               // 4 gen — PE roles
    'private credit',               // 4 gen — credit fund roles
    // TAG-11 S238: adaptive classifier cycle 1
    'risk engineer',                // 6 gen, 0 FP — insurance risk engineering (AIG, Hartford)
    'client case representative',   // 3 gen, 0 FP — financial client case management
    'retirement education',         // 2 gen, 0 FP — retirement planning education
    'claim representative',         // 1 gen, 0 FP — insurance claims
    'countrywide coverage',         // 1 gen, 0 FP — insurance underwriting coverage
    'absence management',           // 1 gen, 0 FP — insurance absence/disability mgmt
    'sovereign analyst',            // 1 gen, 0 FP — sovereign debt analysis
    // TAG-11 S238: adaptive classifier cycle 2
    'finance & strategy',           // 4 gen, 0 FP — finance & strategy roles (Netflix)
    'partnerships finance',         // 2 gen, 0 FP — partnerships finance (Netflix)
    'analyst pricing',              // 1 gen, 0 FP — pricing analysis
    // TAG-11 S238: adaptive classifier cycle 5 (Booz Allen)
    'foreign military sales',       // 1 gen, 0 FP — FMS analyst (defense)
    'pcard analyst',                // 1 gen, 0 FP — PCard/travel expense analyst
    // TAG-11 S238: adaptive classifier cycle 7 (Guidehouse)
    'transaction monitoring',       // 2 gen, 0 FP — AML transaction monitoring
    'loan reconciliation',          // 1 gen, 0 FP — loan reconciliation
    'financial operations consultant', // 1 gen, 0 FP — financial ops consulting
    'financial intelligence',       // 1 gen, 0 FP — financial intelligence/AML
  
    // TAG-11 S238: adaptive classifier cycle 8 (RTX + KBR)
    'order administrator',           // 1 gen, 0 FP — order administration
    'proposal analyst',              // 1 gen, 0 FP — proposal analysis
    'program cost controls',         // 1 gen, 0 FP — program cost controls
    'financial associate',           // 1 gen, 0 FP — financial associate
    'cost recovery',                 // 1 gen, 0 FP — cost recovery advisor
    'risk management assurance',     // 1 gen, 0 FP — risk management assurance
    'price to win',                  // 1 gen, 0 FP — price-to-win analysis
    'fms analyst',                   // 1 gen, 0 FP — foreign military sales analyst
    // TAG-11 S238: adaptive classifier cycle 9 (AbbVie)
    'global financial audit',        // 1 gen, 0 FP — global financial audit
    'customs valuation',             // 1 gen, 0 FP — customs valuation compliance
    'tariff classification',         // 1 gen, 0 FP — tariff classification
    // TAG-11 S238: adaptive classifier cycle 11
    'insurance claims',              // 1 gen, 0 FP — insurance claims specialist
    // TAG-11 S238: adaptive classifier cycle 12
    'commercial loan',               // 1 gen, 0 FP — commercial loan operations
    // TAG-11 S238: adaptive classifier cycle 13 (DoorDash)
    'financial products',            // 1 gen, 0 FP — financial products strategy
    // TAG-11 S238: adaptive classifier cycle 15 (Point72/Biogen)
    'broker data',                   // 1 gen, 0 FP — broker data associate
    'broker relations',              // 1 gen, 0 FP — broker relations analyst
    'fund flow',                     // 2 gen, 0 FP — fund flow analyst/strategist
    'quantitative strategist',       // 4 gen, 0 FP — quantitative strategist
    'global pricing',                // 1 gen, 0 FP — global pricing & access
    // TAG-11 S238: adaptive classifier cycle 16 (AES/S&P Global)
    'corporate tax',                 // 3 gen, 0 FP — corporate tax
    'rating analyst',                // 1 gen, 0 FP — credit rating analyst
    'tax compliance',                // 1 gen, 0 FP — tax compliance
    'agent services',                // 1 gen, 0 FP — agent services (syndicated loans)
    // TAG-11 S238: adaptive classifier cycle 17
    'finance rotational',            // 1 gen, 0 FP — finance rotational program (WD)
    // TAG-11 S238: cycle 25
    'tax & treasury',                // 1 gen, 0 FP — tax & treasury (Dropbox)
    // TAG-11 S238: cycle 26
    'junior valuation',              // 1 gen, 0 FP — valuation analyst
    // TAG-11 S238: cycle 27
    'portfolio management',          // 1 gen, 0 FP — portfolio management (AmEx)
    'compliance high-risk',          // 1 gen, 0 FP — compliance high-risk due diligence (AmEx)
    // TAG-11 S238: cycle 28
    'investment associate',          // 2 gen, 0 FP — investment associate (Wintermute)
    // TAG-11 S238: cycle 29
    'paraplanner',                   // 1 gen, 0 FP — paraplanner (Ameriprise)
    // TAG-11 S238: cycle 31
    'private debt',                  // 1 gen, 0 FP — private debt (Audax Group)
    // TAG-11 S238: cycle 32
    'crypto researcher',             // 2 gen, 0 FP — crypto researcher (Jump Trading)
    // TAG-11 S238: cycle 19
    'transfer agency',               // 2 gen, 0 FP — transfer agency (State Street)
    'annuities',                     // 2 gen, 0 FP — annuities (Prudential)
    'ltd claims',                    // 1 gen, 0 FP — LTD claims (Prudential)
    // TAG-11 S238: cycle 20
    'edgar filing',                  // 1 gen, 0 FP — EDGAR filing (Broadridge)
    'recovery specialist',           // 1 gen, 0 FP — loss recovery (AIG)
    'policy wording',                // 1 gen, 0 FP — policy wording (AIG)
    'uw specialist',                 // 1 gen, 0 FP — underwriting specialist (AIG)
    // TAG-11 S238: cycle 22
    'aml special investigations',    // 1 gen, 0 FP — AML investigations (Capital One)
    'anti-money laundering',         // 1 gen, 0 FP — AML data analysis (Capital One)
    // TAG-12 S238: moved from operations (CACI Job Category = Finance and Accounting)
    'governance documentation',      // 1 gen — governance documentation specialist
    'governance framework',          // 1 gen — governance framework analyst
    // TAG-11 S239 C35: RTX finance
    'associate finance director',    // 1 gen, 0 FP — Associate Finance Director ESSM (RTX)
  ];
  if (financeKeywords.some(kw => title.includes(kw))) {
    pushTag('finance', findMatch(financeKeywords, title), 'title');
  }

  // Sales domain (title-only — description contamination risk high)
  // Guard: DO NOT add bare 'sales engineer' or 'solutions engineer' — those are tech-adjacent
  const salesKeywords = [
    'retail sales consultant', 'field sales representative',
    'sales development representative', 'account executive',
    'business development representative', 'b2b sales',
    'sales consultant', 'sales associate',
    'outside sales representative', 'inside sales',
    'sales account executive', 'enterprise account executive',
    'commercial account executive', 'sales specialist',
    // GENERAL-CLASSIFICATION additions (S223 — +377 verified from live pool):
    'sales representative',  // field/territory/medical/pharma sales reps
    'sales trainee',         // training programs at pharma/medical device companies
    'sales executive',       // entry-level sales exec titles
    // TAG-1 G1 expansion (S229): consulting/solution sales
    'solution consultant',   // 65 hits — advisory/consulting sales (Deloitte, etc.)
    // TAG-1 S233: SR general rate investigation
    'sales trainer',         // 10 hits — pharma/medical device sales trainers (AbbVie, Abbott)
    // TAG-9 S237: Phase 3 keyword expansion
    'account development',   // 7 hits — account development representatives
    // TAG-9 S237: Phase 5 vocabulary extraction
    'solutions consultant',  // 8 gen, 100% spec — pre-sales/advisory consulting
    // TAG-10 S237: Claude-classified per-company keywords
    'area access executive', // 8 gen — AbbVie pharma field sales
    'field sales rep',       // 5 gen — territory field sales reps (JCI)
    'presales engineer',     // 2 gen — pre-sales engineering (Motorola)
    // TAG-10 S237: Phase 4 bigram sweep
    'solutions specialist',  // 19 gen — solutions/pre-sales specialists
    'account specialist',    // 13 gen — account management specialists
    // TAG-10 S237: Phase 6 exhaustive title classification
    'client partner',        // 7 gen — client partnership/sales roles
    'market development',    // 5 gen — market development representatives
    'sales support',         // 5 gen — sales support roles
    // TAG-10 S238: title keyword gap analysis
    'sales intern',          // 6 gen, 0 FP — sales internships
    'sales admin',           // 4 gen, 1 FP — sales administration roles
    'sales coordinator',     // 1 gen, 0 FP — sales coordination
    'sales excellence',      // 1 gen, 0 FP — sales enablement/excellence
    // TAG-11 S238: adaptive classifier cycle 1
    'advisor consultant',    // 5 gen, 0 FP — insurance retail sales advisors
    'advisor support',       // 1 gen, 0 FP — sales support advisors
    // TAG-11 S238: adaptive classifier cycle 2
    'provider specialist',   // 2 gen, 0 FP — pro customer sales (Lowe's)
    'central selling',       // 1 gen, 0 FP — central selling supervisor
    // TAG-11 S238: adaptive classifier cycle 3
    'digital sales planner', // 2 gen, 0 FP — programmatic/digital ad sales (NBCU)
    'proposal specialist',   // 1 gen, 0 FP — proposal/bid writing (Oshkosh)
    // TAG-11 S238: adaptive classifier cycle 9 (AbbVie)
    // TAG-11 S238: adaptive classifier cycle 10 (Bosch)
    'sales controlling',            // 2 gen, 0 FP — sales controlling analyst

    'hospital surgical rep', // 2 gen, 0 FP — hospital surgical sales rep
    'virtual sales rep',     // 1 gen, 0 FP — virtual sales representative
    // TAG-11 S238: adaptive classifier cycle 12
    'ciso solutions',        // 1 gen, 0 FP — CISO solutions GTM
    // TAG-11 S238: adaptive classifier cycle 13 (DoorDash)
    'ad sales intelligence', // 1 gen, 0 FP — enterprise ad sales intelligence
    // TAG-11 S238: adaptive classifier cycle 16 (Baker Hughes/S&P/CrowdStrike)
    'wellbore intervention', // 1 gen, 0 FP — wellbore intervention sales
    'refinery account',      // 1 gen, 0 FP — refinery account rep
    'enterprise renewals',   // 1 gen, 0 FP — enterprise renewals specialist
    'growth development representative', // 1 gen, 0 FP — growth dev rep
    // TAG-11 S238: adaptive classifier cycle 17
    'fire service sales',       // 2 gen, 0 FP — fire service sales (JCI)
    'commercial security services', // 1 gen, 0 FP — commercial security renewals (JCI)
    'new technology specialist', // 1 gen, 0 FP — new technology specialist (J&J)
    'sales partnerships',       // 1 gen, 0 FP — sales partnerships enablement
    // TAG-11 S238: adaptive classifier cycle 18
    'client service partner',    // 2 gen, 0 FP — client service partner (Bloomberg)
    'relationship partner',      // 2 gen, 0 FP — relationship partner
    'sales development supervisor', // 1 gen, 0 FP — sales dev supervisor
    // TAG-11 S238: cycle 22
    'aftermarket solutions',    // 1 gen, 0 FP — aftermarket solutions (Caterpillar)
    // TAG-11 S238: cycle 26
    'clean energy solution',    // 1 gen, 0 FP — clean energy solution specialist (Generac)
    // TAG-11 S238: cycle 32
    'emergency medicine executive', // 1 gen, 0 FP — emergency medicine executive (Abbott)
    // TAG-11 S238: cycle 19
    'partner solution specialist', // 2 gen, 0 FP — partner solution specialist (Autodesk)
    'renewals representative',   // 4 gen, 0 FP — renewals rep (Autodesk)
    'expansion account',         // 1 gen, 0 FP — expansion account rep
    'technical adoption',        // 1 gen, 0 FP — technical adoption specialist
    // TAG-11 S239 C36: Disney sales
    'vacation club',             // 1 gen, 0 FP — Disney Vacation Club Preview Center Assistant
  ];
  const isSalesEngineer = /\b(sales engineer|solutions engineer|pre-sales engineer)\b/i.test(title);
  if (!isSalesEngineer && salesKeywords.some(kw => title.includes(kw))) {
    pushTag('sales', findMatch(salesKeywords, title), 'title');
  }

  // Marketing domain (title-only)
  const marketingKeywords = [
    'marketing manager', 'marketing coordinator', 'marketing analyst',
    'digital marketing', 'growth marketing', 'brand manager',
    'content marketing', 'product marketing', 'social media manager',
    'marketing associate', 'marketing specialist', 'email marketing',
    'marketing intern', 'seo specialist',
    // GENERAL-CLASSIFICATION additions (S223 — +129 verified from live pool):
    'student marketeer',    // Red Bull campus ambassador program — 129 hits, all legitimate
    // TAG-9 S237: Phase 1 keyword expansion
    'copywriter',            // 3 hits — advertising/creative copywriters
    'photographer',          // 4 hits — news/marketing photographers
    'publicist',             // 1 hit — PR/publicity roles
    // TAG-9 S237: Phase 5 vocabulary extraction
    'social media',          // 9 gen, 75% spec — social media coordinator/manager
    // TAG-10 S237: Phase 3 normalized title sweep
    'café ambassador', 'cafe ambassador', // 6 gen — Capital One café retail roles
    // TAG-10 S237: Phase 8 — 'back end clerk' MOVED to retail (TAG-12 audit: Lowe's customer service/stocking)
    // TAG-10 S237: Layer 5 title classification sweep
    'thought leader',            // 3 gen — thought leader liaison (pharma marketing)
    'account supervisor',        // 2 gen — agency account supervisors
    'communications coordinator',// 4 gen — corporate communications
    'community engagement',      // 3 gen — community relations/outreach
    'proposal content',          // 1 gen — proposal content development
    // TAG-10 S237: Phase 9 random sample discovery
    'media specialist',          // 1 gen — media/social media specialists
    // TAG-10 S238: title keyword gap analysis
    'communications intern',     // 6 gen, 1 FP — corporate communications internships
    'brand marketing',           // 2 gen, 0 FP — brand marketing roles
    // TAG-11 S238: adaptive classifier cycle 1
    'internal communications',   // 2 gen, 0 FP — corporate internal comms
    'marketing attribution',     // 1 gen, 0 FP — marketing measurement/attribution
    // TAG-11 S238: adaptive classifier cycle 2
    'screenings researcher',     // 1 gen, 0 FP — content research (Netflix)
    'ads marketing operations',  // 1 gen, 0 FP — ads marketing ops
    // TAG-11 S238: adaptive classifier cycle 3
    'assignment desk',           // 4 gen, 0 FP — news assignment desk (NBCU)
    'global publicity',          // 2 gen, 0 FP — global publicity/PR (NBCU)
    'casting coordinator',       // 2 gen, 0 FP — casting/talent coordination (NBCU)
    'trade marketing',           // 1 gen, 0 FP — trade/channel marketing
    '360 designer',              // 1 gen, 0 FP — 360/multiplatform design (NBCU)
    // TAG-11 S238: adaptive classifier cycle 9 (AbbVie)
    // TAG-11 S238: adaptive classifier cycle 12
    'creative director',             // 2 gen, 0 FP — creative director
    // TAG-11 S238: adaptive classifier cycle 13 (DoorDash)
    'rx ads',                        // 1 gen, 0 FP — Rx ads & promotions
    // TAG-11 S238: adaptive classifier cycle 15 (Biogen)
    'omnichannel',                   // 1 gen, 0 FP — omnichannel/digital operations
    // TAG-11 S238: adaptive classifier cycle 18
    'newsletter editor',             // 3 gen, 0 FP — newsletter editing (Bloomberg)
    // TAG-11 S238: cycle 19
    'demand gen specialist',         // 1 gen, 0 FP — demand gen (SharkNinja)
    'consumer insights',             // 1 gen, 0 FP — consumer insights (SharkNinja)
    // TAG-11 S238: cycle 20-22 (MOVED from sales array — script insertion error)
    'localization specialist',       // 1 gen, 0 FP — localization (Life.Church)
    'b2b digital strategy',          // 1 gen, 0 FP — B2B digital strategy (Elanco)
    'content programmer',            // 2 gen, 0 FP — content programming (WBD)
    'video and audio editor',        // 1 gen, 0 FP — video/audio editing (WBD/CNN)
    'editor-writer',                 // 1 gen, 0 FP — editor-writer (WBD/CNN)
    'tiktok social programming',     // 1 gen, 0 FP — TikTok social (WBD/BR)
    // TAG-11 S238: cycle 25
    'multi-media journalist',        // 1 gen, 0 FP — multimedia journalist (NBCU)
    // TAG-11 S238: cycle 26
    'youth programs marketing',      // 1 gen, 0 FP — youth programs marketing (Red Bull)
    // TAG-11 S238: cycle 29
    'editor, politics',              // 1 gen, 0 FP — politics editor (WBD)
    // TAG-11 S238: cycle 32
    'founding marketer',             // 1 gen, 0 FP — founding marketer (Gimlet Labs)

    // TAG-11 S238: adaptive classifier cycle 10
    'consumer intelligence',        // 1 gen, 0 FP — consumer intelligence research (GM)
    'spaceport designer',           // 1 gen, 0 FP — spaceport interior design (SpaceX)

    'hcp marketing',             // 1 gen, 0 FP — HCP marketing
    'professional marketing',    // 3 gen, 0 FP — professional/OTC marketing
    'copy supervisor',           // 1 gen, 0 FP — copy supervisor (creative)
    'digital lab banner',        // 1 gen, 0 FP — digital lab banner ads
    // TAG-11 S239 C33: NBCUniversal media/broadcast marketing
    'avod',                      // 1 gen, 0 FP — AVOD Growth & Digital Dist. (NBCUniversal)
    'nbc sports digital',        // 1 gen, 0 FP — NBC Sports Digital Programming (NBCUniversal)
    'global platform partnerships', // 2 gen, 0 FP — Global Platform Partnerships (NBCUniversal)
    'audience acquisition',      // 1 gen, 0 FP — Audience Acquisition & Growth (NBCUniversal)
    'partner marketing',         // 1 gen, 0 FP — Partner Marketing Manager (NBCUniversal)
    'digital communications',    // 1 gen, 0 FP — Digital Comms Specialist (NBCUniversal)
    // TAG-11 S239 C36: Disney marketing
    'seo intern',                // 1 gen, 0 FP — ABC News SEO Intern (Disney)
  ];
  // TAG-9: 'producer' and 'reporter' added as guarded keywords for media/content roles
  const isInsuranceProducer = /\b(licensed|insurance|enrollment)\b/i.test(title);
  const isNonMediaReporter = /\b(litigation|analyst|legal)\b/i.test(title);
  const producerReporterMatch = (!isInsuranceProducer && title.includes('producer')) ||
    (!isNonMediaReporter && title.includes('reporter'));
  if (marketingKeywords.some(kw => title.includes(kw)) || producerReporterMatch) {
    const mktMatch = findMatch(marketingKeywords, title) ||
      (title.includes('producer') ? 'producer' : null) ||
      (title.includes('reporter') ? 'reporter' : null);
    pushTag('marketing', mktMatch, 'title');
  }

  // Operations domain (title-only — narrow terms only, avoid broad 'analyst' standalone)
  const operationsKeywords = [
    'operations analyst', 'operations associate', 'operations coordinator',
    'supply chain analyst', 'logistics analyst', 'program analyst',
    'project analyst', 'business operations', 'strategy analyst',
    'strategy associate', 'operations specialist',
    // TAG-1 G1 expansion (S229): supervisor + inventory roles
    'shift supervisor',          // 171 hits — CVS/retail/manufacturing floor supervisors
    'operations supervisor',     // 48 hits
    'inventory specialist',      // 73 hits — auto auction/warehouse inventory
    // TAG-6 S233: promoted from O*NET
    'fulfillment associate',     // 304 hits — retail/warehouse fulfillment (Lowe's, Walmart)
    'customer service representative', // 65 hits — CSR roles
    'management analyst',        // 31 hits — management consulting/analysis
    'support analyst',           // 23 hits — operations support analysis
    // TAG-8 S237: FP audit keyword expansion
    'buyer',                     // 33 hits — procurement/purchasing buyer roles
    'business analyst',          // 63 hits — business analysis across industries
    // TAG-9 S237: Phase 3 keyword expansion
    'fulfillment team lead',     // 10 hits — warehouse/fulfillment team leads
    'procurement specialist',    // 4 hits — procurement roles
    'project coordinator',       // 16 hits — project coordination roles
    'service coordinator',       // 3 hits — service coordination roles
    'operations asm',            // 4 hits — assistant store manager (operations)
    // TAG-9 S237: Phase 4 keyword expansion
    'procurement analyst',       // 3 hits — procurement analysis
    'operations support',        // 3 hits — operations support specialist/analyst
    // TAG-9 S237: Phase 5 vocabulary extraction (comprehensive domain bigram analysis)
    'supply chain',              // 101 gen — broader form (had only 'supply chain specialist/coordinator')
    'customer service',          // 68 gen — broader form (had only 'customer service representative')
    'operations technician',     // 23 gen — operations/facilities technicians
    'support associate',         // 10 gen — operations support roles
    'technical consultant',      // 12 gen — consulting/advisory roles
    'sourcing specialist',       // 7 gen — procurement sourcing
    'production operations',     // 9 gen — production operations roles
    // TAG-9 S237: Phase 6 keyword sweep
    'scheduling staffing',       // 10 gen — scheduling/staffing admin roles
    'site manager',              // 8 gen — assistant site managers
    'customs specialist',        // 6 gen — customs/trade compliance
    'executive protection',      // 3 gen — corporate security/protection
    'workplace coordinator',     // 3 gen — facilities/workplace coordination
    'production and inventory',  // 3 gen — production/inventory coordination
    // TAG-10 S237: Claude-classified per-company keywords
    'yard supervisor',           // 2 gen — yard/lot management (Copart)
    'program controls',          // 2 gen — program controls analysis (Moog defense)
    // TAG-10 S237: Phase 3 normalized title sweep
    'customer support agent',    // 4 gen — customer support roles
    'physical security',         // 11 gen — physical security officers/investigators
    'console operator',          // 9 gen — security console operators
    'background investigator',   // 10 gen — federal background investigators (CACI)
    // TAG-10 S237: Phase 4 bigram sweep
    'security officer',          // 9 gen — physical security officers (USAA, Hermeus)
    // TAG-10 S237: Layer 5 title classification sweep
    'customer care',             // 8 gen — customer care representatives/advocates
    'master scheduler',          // 4 gen — program/master schedulers
    'close protection',          // 3 gen — executive protection officers
    'baggage handling',          // 2 gen — airport baggage operations
    'motor transport',           // 3 gen — military motor transport (KBR)
    // TAG-10 S237: Phase 6 exhaustive title classification
    'industrial security',       // 6 gen — industrial security specialists
    'assistant general manager', // 3 gen — facility/store AGMs
    'import/export',             // 2 gen — trade compliance analysts
    'custodian',                 // 4 gen — custodial/janitorial
    'targeter',                  // 2 gen — intelligence targeting (Booz Allen)
    'surveillance analyst',      // 3 gen — surveillance/monitoring analysts
    'sous chef',                 // 3 gen — kitchen sous chefs (SpaceX)
    'janitor',                   // 5 gen — janitorial roles
    'food service',              // 4 gen — food service specialists
    // TAG-10 S237: Phase 8 trigram analysis
    'subject matter expert',     // 8 gen — defense/consulting SMEs
    'planning and scheduling',   // 5 gen — program planning/scheduling
    'player tracking',           // 4 gen — sports tracking systems (Zebra)
    'military fellowship',       // 5 gen — military SkillBridge fellowships
    'professional services consultant', // 5 gen — PS consulting
    'scheduling analyst',        // 5 gen — scheduling/planning analysts
    'business transformation',   // 8 gen — transformation program roles
    // TAG-10 S237: Phase 9 random sample discovery
    'inventory control',         // 1 gen — inventory control roles
    'protection specialist',     // 1 gen — asset/account protection
    'protection integrator',     // 1 gen — security integration
    // TAG-10 S237: Phase 10 random sample reading
    'customer success',          // 12 gen — customer success advisors/managers
    'line cook',                 // 4 gen — kitchen line cooks
    // TAG-10 S237: Phase 13 varied sample
    'imagery analyst',           // 1 gen — intelligence imagery analysis
    'receptionist',              // 4 gen — front desk reception
    // TAG-10 S237: Phase 14 varied sample
    'trust and safety',          // 2 gen — trust & safety operations
    // TAG-10 S238: title keyword gap analysis
    'fulfillment associate',     // 14 gen, 0 FP — warehouse/store fulfillment
    'fulfillment team',          // 6 gen, 0 FP — fulfillment team leads
    // TAG-11 S238: adaptive classifier cycle 1
    'operational language analyst', // 12 gen, 0 FP — military linguist/translator roles (CACI)
    'parts planner',             // 3 gen, 0 FP — material/parts planning
    'blucar support specialist', // 3 gen, 0 FP — Copart vehicle support
    'linguist interpreter',      // 2 gen, 0 FP — military interpreter roles
    'targeting officer',         // 2 gen, 0 FP — intelligence targeting roles
    'order entry',               // 2 gen, 0 FP — order entry/processing
    'construction superintendent', // 1 gen, 0 FP — construction site management
    'lab clerk',                 // 1 gen, 0 FP — laboratory clerk roles
    'materials analyst',         // 1 gen, 0 FP — materials/inventory analysis
    'strategic sourcing intern', // 1 gen, 0 FP — procurement internships
    'vehicle detailer',          // 1 gen, 0 FP — vehicle detailing/prep
    // TAG-11 S238: adaptive classifier cycle 2
    'sc security specialist',    // 3 gen, 0 FP — supply chain security (Lowe's)
    'helix data creator',        // 3 gen, 0 FP — data creation ops
    'corporate department assistant', // 1 gen, 0 FP — corporate admin
    'district support coordinator', // 1 gen, 0 FP — district operations
    'receiving support specialist', // 1 gen, 0 FP — warehouse receiving
    // TAG-11 S238: adaptive classifier cycle 3
    'assistant manager attractions', // 2 gen, 0 FP — theme park attractions (NBCU)
    'work order coordinator',    // 2 gen, 0 FP — facility work orders (Oshkosh)
    'summer help',               // 2 gen, 0 FP — seasonal help roles (Oshkosh)
    'assistant manager show',    // 1 gen, 0 FP — show quality management (NBCU)
    'culinary internship',       // 1 gen, 0 FP — food service internship (NBCU)
    'site supervisor',           // 1 gen, 0 FP — site operations supervision
    'facility support',          // 1 gen, 0 FP — facility support roles
    // TAG-11 S238: adaptive classifier cycle 4 (CACI)
    'intel analyst',             // 1 gen, 0 FP — intelligence analyst
    'operations integrator',     // 1 gen, 0 FP — military operations integrator
    'sensitive activities',      // 1 gen, 0 FP — sensitive activities advisor
    'procurement administrator', // 1 gen, 0 FP — procurement admin
    // 'governance documentation' MOVED to finance (TAG-12 audit: CACI Job Category = Finance and Accounting)
    // 'governance framework' MOVED to finance (TAG-12 audit: CACI Job Category = Finance and Accounting)
    // 'interface sustainment' MOVED to software (TAG-12 audit: CACI Job Category = Information Technology)
    'cryptologic language',      // 1 gen, 0 FP — cryptologic language analyst
    'fielding/training',         // 1 gen, 0 FP — equipment fielding/training
    // TAG-11 S238: adaptive classifier cycle 5 (Booz Allen)
    'security cooperation',      // 3 gen, 0 FP — security cooperation specialist
    'operations warfighting',    // 2 gen, 0 FP — warfighting analyst
    'hicom',                     // 3 gen, 0 FP — HICOM integrator roles
    'fuops planner',             // 1 gen, 0 FP — future operations planner
    'foreign disclosure',        // 1 gen, 0 FP — foreign disclosure rep
    'naval experiment',          // 1 gen, 0 FP — naval experiment planner
    'joint effects',             // 1 gen, 0 FP — joint effects integrator
    'requirements integration',  // 1 gen, 0 FP — requirements integration officer
    'protocol officer',          // 1 gen, 0 FP — protocol officer
    'fires curriculum',          // 1 gen, 0 FP — fires curriculum developer
    'fires simulation',          // 1 gen, 0 FP — fires simulation operator
    'c-uas training',            // 1 gen, 0 FP — counter-UAS training
    'military capabilities',     // 1 gen, 0 FP — military capabilities analyst
    'defense mission',           // 1 gen, 0 FP — defense mission analyst
    'supplier onboarding',       // 1 gen, 0 FP — supplier onboarding specialist
    // TAG-11 S238: adaptive classifier cycle 6 (Leidos)
    'exercise planning',         // 1 gen, 0 FP — exercise planning specialist
    'intelligence exercise',     // 1 gen, 0 FP — intelligence exercise planner
    // (Guidehouse ops keywords interspersed below)
    'operations advisor',        // 2 gen, 0 FP — operations advisor
    'deckhand',                  // 1 gen, 0 FP — maritime deckhand
    'jassm targeting',           // 1 gen, 0 FP — JASSM targeting analyst
    'triage examiner',           // 1 gen, 0 FP — triage examiners (linguist)
    'korean linguist',           // 1 gen, 0 FP — Korean linguist/translator
    'arabic linguist',           // 2 gen, 0 FP — Arabic linguist
    'bilingual linguist',        // 1 gen, 0 FP — bilingual linguist
    'weather forecaster',        // 1 gen, 0 FP — aviation weather forecaster
    'energy advisor',            // 1 gen, 0 FP — energy efficiency advisor
    'material control',          // 2 gen, 0 FP — material control stockroom
    'visual charting',           // 1 gen, 0 FP — visual charting specialist
    'documentation specialist',  // 3 gen, 0 FP — documentation specialist
    // TAG-11 S238: adaptive classifier cycle 7 (Guidehouse)
    'call center',               // 1 gen, 0 FP — call center rep
    'process improvement managing', // 1 gen, 0 FP — process improvement consultant
  
    // TAG-11 S238: adaptive classifier cycle 8 (RTX + KBR)
    'commodity supplier',            // 1 gen, 0 FP — commodity supplier assurance
    'combat systems planning',       // 1 gen, 0 FP — combat systems planning
    'customs operations',            // 1 gen, 0 FP — customs operations import
    'supplier commodity',            // 1 gen, 0 FP — supplier commodity assurance
    'small business advocate',       // 1 gen, 0 FP — small business advocacy
    'oem support',                   // 1 gen, 0 FP — OEM support specialist
    'campaign planner',              // 1 gen, 0 FP — strategy/campaign planner
    'force operations planner',      // 1 gen, 0 FP — joint force ops planner
    'manpower analyst',              // 1 gen, 0 FP — manpower analysis
    'technical author',              // 1 gen, 0 FP — technical authoring
    'contracts support',             // 1 gen, 0 FP — contracts support SME
    'human systems integration',     // 1 gen, 0 FP — HSI specialist
    'weapon system contract',        // 1 gen, 0 FP — weapon system contract eval
    // TAG-11 S238: adaptive classifier cycle 9 (AbbVie + Boeing)
    // TAG-11 S238: adaptive classifier cycle 12
    'career exploration',            // 1 gen, 0 FP — career exploration program
    'safety management system',      // 1 gen, 0 FP — SMS engineer
    'team lead - deicer',            // 1 gen, 0 FP — deicer team lead
    'technical documentation illustrator', // 2 gen, 0 FP — tech doc illustrator
    'business unit intern',          // 1 gen, 0 FP — business unit internship

    // TAG-11 S238: adaptive classifier cycle 10
    'purchasing quality',           // 1 gen, 0 FP — purchasing quality (Bosch)
    'fire captain',                 // 1 gen, 0 FP — fire captain (Disney)
    'hospitality specialist',       // 2 gen, 0 FP — hospitality specialist (SpaceX)
    'mixologist',                   // 1 gen, 0 FP — mixologist (SpaceX)
    'spaceport experience',         // 2 gen, 0 FP — spaceport experience (SpaceX)
    'gsoc operator',                // 1 gen, 0 FP — GSOC operator (SpaceX)
    'pilot in command',             // 1 gen, 0 FP — pilot in command (SpaceX)
    'payload rack officer',         // 2 gen, 0 FP — payload rack officer (FLIR)
    'field services coordinator',   // 1 gen, 0 FP — field services coord (FLIR)
    'supplier quality coordinator', // 1 gen, 0 FP — supplier quality coord (FLIR)
    'customer delivery readiness',  // 1 gen, 0 FP — customer delivery readiness (FLIR)
    'poi specialist',               // 1 gen, 0 FP — POI specialist (FLIR)

    'category management',          // 2 gen, 0 FP — category management
    'corporate catering',           // 1 gen, 0 FP — corporate catering
    'procurement agent',            // 3 gen, 0 FP — procurement agent
    'fleet monitoring',             // 1 gen, 0 FP — fleet monitoring engineer
    // TAG-11 S238: adaptive classifier cycle 11
    'customer support specialist',  // 4 gen, 0 FP — customer support specialist
    'account administrator',        // 2 gen, 0 FP — account admin
    'workplace strategy',           // 1 gen, 0 FP — workplace strategy
    // TAG-11 S238: adaptive classifier cycle 13 (DoorDash)
    'voice ordering',               // 1 gen, 0 FP — voice ordering accessibility
    'quality strategy',             // 1 gen, 0 FP — quality strategy & operations
    'proactive outreach',           // 1 gen, 0 FP — proactive outreach specialist
    'premium resolution',           // 1 gen, 0 FP — premium resolution partner
    'merchant sentiment',           // 1 gen, 0 FP — merchant sentiment specialist
    // TAG-11 S238: adaptive classifier cycle 14 (OpenAI)
    'revenue operations business partner', // 1 gen, 0 FP — revenue ops business partner
    // TAG-11 S238: adaptive classifier cycle 15 (Cloudflare/Point72/Biogen)
    'customer advocacy',            // 2 gen, 0 FP — customer advocacy
    'webcast',                      // 1 gen, 0 FP — webcast/AV specialist
    // TAG-11 S238: adaptive classifier cycle 16 (Baker Hughes/AES/CrowdStrike)
    'contact center trainer',       // 1 gen, 0 FP — contact center training
    // TAG-11 S238: adaptive classifier cycle 17
    'construction equipment services', // 3 gen, 0 FP — construction equipment (JCI)
    'global business process owner', // 2 gen, 0 FP — GBPO (Moog)
    'skip tracer',                  // 1 gen, 0 FP — skip tracing (Motorola)
    'office stock assistant',       // 1 gen, 0 FP — office stock (Motorola)
    // TAG-11 S238: adaptive classifier cycle 18
    'supplier technologist',        // 1 gen, 0 FP — supplier technologist (Applied Materials)
    // TAG-11 S238: cycle 19
    'loading dock',                 // 1 gen, 0 FP — loading dock specialist
    'fixed wing captain',           // 1 gen, 0 FP — fixed wing pilot
    // TAG-11 S238: cycle 20
    'central planner',              // 1 gen, 0 FP — central planner (Polaris)
    'mailroom facilities',          // 1 gen, 0 FP — mailroom facilities (Broadridge)
    'sustainability analyst',       // 1 gen, 0 FP — sustainability analyst
    'volunteer experience',         // 1 gen, 0 FP — volunteer experience (Life.Church)
    'rfc coordinator',              // 1 gen, 0 FP — RFC coordinator (Jabil)
    // TAG-11 S238: cycle 21
    'contract lifecycle',           // 1 gen, 0 FP — contract lifecycle mgmt (Philips)
    'property maintenance',         // 1 gen, 0 FP — property maintenance (SEL)
    'technical customer advisor',   // 1 gen, 0 FP — technical customer advisor (Veolia)
    'yard attendant',               // 1 gen, 0 FP — yard attendant (Copart)
    // TAG-11 S238: cycle 24
    'tamashek linguist',            // 1 gen, 0 FP — Tamashek linguist (CACI)
    'service dispatch',             // 1 gen, 0 FP — service dispatch supervisor
    'intel ops controller',         // 1 gen, 0 FP — intel ops controller (CACI)
    // TAG-11 S238: cycle 25
    'russian kazak',                // 1 gen, 0 FP — Russian/Kazak linguist (CACI)
    'administrative operations assistant', // 1 gen, 0 FP — admin ops assistant
    // TAG-11 S238: cycle 26
    'fleet & safety',               // 1 gen, 0 FP — fleet & safety (Allegion)
    // TAG-11 S238: cycle 27
    'bag jam clearer',              // 3 gen, 0 FP — bag jam clearer (Oshkosh airports)
    'transportation strategy',      // 1 gen, 0 FP — transportation strategy (Point72)
    // TAG-11 S238: cycle 28
    'mission operator',             // 1 gen, 0 FP — mission operator (Latitude AI)
    'engineering projects administrator', // 1 gen, 0 FP — eng projects admin (Curtiss-Wright)
    'procurement support',          // 1 gen, 0 FP — procurement support (Guidehouse)
    // TAG-11 S238: cycle 29
    'human evaluator',              // 2 gen, 0 FP — human evaluator (Roblox)
    'french /hausa',                // 1 gen, 0 FP — French/Hausa linguist (Leidos)
    'energy efficiency programs',   // 1 gen, 0 FP — energy efficiency programs (Leidos)
    // TAG-11 S238: cycle 30
    'orders and demand',            // 1 gen, 0 FP — orders & demand consultant (Caterpillar)
    // TAG-11 S238: cycle 31
    'dispatch operations',          // 1 gen, 0 FP — dispatch operations (Voltus)
    // TAG-11 S238: cycle 32
    'intelligence planner',         // 1 gen, 0 FP — intelligence planner (Booz Allen)
    'intelligence management specialist', // 1 gen, 0 FP — intel mgmt specialist (CACI)
    // TAG-11 S239 C34: Boeing operations/maintenance
    'contract management specialist', // 2 gen, 0 FP — Contract Management Specialist (Boeing)
    'maintenance controller',        // 1 gen, 0 FP — Maintenance Controller F-15SA (Boeing)
    'learning strategist',           // 1 gen, 0 real FP — Associate Learning Strategist (pre-existing mfg FP)
    'material review board',         // 1 gen, 0 FP — Quality Production Spclst MRB (Boeing)
    'tech pubs author',              // 1 gen, 0 FP — Chinook Tech Pubs Author (Boeing, ops domain)
    'procurement field',             // 1 gen, 0 FP — Procurement Field Rep (Boeing)
    'database content developer',    // 1 gen, 0 FP — Database Content Developer (Boeing visual systems)
    'image process specialist',      // 1 gen, 0 FP — Associate Image Process Specialist (Boeing)
    'logistics representative',      // 2 gen, 0 FP — C-32/C-40 Logistics Representative (Boeing)
    'quality workplace coach',       // 1 gen, 0 FP — Quality Workplace Coach (Boeing manufacturing floor)
    // TAG-11 S238: cycle 22
    'centurion lounge',             // 5 gen, 0 FP — Centurion Lounge (AmEx)
    'technical service trainer',    // 2 gen, 0 FP — technical service training (Generac)
    // TAG-11 S239 C33: CACI (Intelligence) + NBCUniversal broadcast ops
    'cuas osint',                   // 1 gen, 0 FP — CUAS OSINT Analyst (CACI Intelligence)
    'sof operations',               // 1 gen, 0 FP — DTRA SOF Operations Planner (CACI Intel)
    'dtra',                         // 1 gen, 0 FP — DTRA SOF Operations Planner (CACI)
    'federal financial management', // 1 gen, 0 FP — Federal Financial Mgmt Consultant (Guidehouse)
    'future plans analyst',         // 1 gen, 0 FP — Future Plans Analyst (Guidehouse ops)
    'energy markets',               // 3 gen, 0 FP — Managing Consultant-Energy Markets (Guidehouse)
    'broadcast engineer',           // 1 gen, 0 FP — Production/Broadcast Engineer (NBCUniversal)
    'photo coordinator',            // 1 gen, 0 FP — Photo Coordinator (NBCUniversal)
    'digital scheduling',           // 1 gen, 0 FP — Digital Scheduling Supervisor (NBC Sports)
    'citywalk',                     // 2 gen, 0 FP — CityWalk Projects/Entertainment (NBCUniversal)
    'entertainment coordinator',    // 2 gen, 0 FP — Entertainment Coordinator (NBCUniversal)
    // TAG-11 S239 C35: RTX operations/program management
    'life cycle engineering',       // 1 gen, 0 FP — Life Cycle Engineering Cross Product Team Lead (RTX)
    'advanced technology program management', // 1 gen, 0 FP — Intern Advanced Tech Program Mgmt (RTX)
    'product lifecycle services',   // 1 gen, 0 FP — Intern Product Lifecycle Services (RTX)
    'technical coordinator',        // 1 gen, 0 FP — Technical Coordinator (RTX)
    'program quality & mission',    // 1 gen, 0 FP — Program Quality & Mission Assurance Associate (RTX)
    // TAG-11 S239 C36: Disney operations/media
    'master control operator',      // 1 gen, 0 FP — Network Origination/Master Control Operator (Disney)
    'content planning',             // 1 gen, 0 FP — Content Planning Associate (Disney DTC)
    'audio operator',               // 1 gen, 0 FP — Audio Operator REMI A2 (ESPN/Disney)
    'export analyst',               // 1 gen, 0 FP — Export Analyst (Disney global trade)
    'podcast production',           // 1 gen, 0 FP — ABC News Podcast Production Intern (Disney)
    'dtc strategy',                 // 1 gen, 0 FP — Analyst DTC Strategy (Disney+/Hulu)
    'digital video content',        // 1 gen, 0 FP — Digital Video Content Associate (ESPN Disney+)
    'rockwork designer',            // 1 gen, 0 FP — Rockwork Designer (Walt Disney Imagineering)
    'network origination',          // 1 gen, 0 FP — Network Origination Operator (Disney broadcast)
    'franchise planning',           // 1 gen, 0 FP — WDI Franchise Planning Intern (Disney)
    'preditor',                     // 1 gen, 0 FP — Preditor producer/editor hybrid (Disney)
    'construction associate',       // 1 gen, 0 FP — Construction Associate Project Manager (Disney)
  ];
  if (operationsKeywords.some(kw => title.includes(kw))) {
    pushTag('operations', findMatch(operationsKeywords, title), 'title');
  }

  // Legal domain (title-only)
  // Guard: isComplianceEngineer blocks 'Compliance Engineer', 'NERC Compliance Engineer',
  // 'Air Quality & Compliance Engineer', etc. — those are hardware/software, not legal.
  const legalKeywords = [
    'paralegal', 'legal counsel', 'commercial counsel', 'corporate counsel',
    'litigation counsel', 'regulatory counsel', 'privacy counsel',
    'compliance analyst', 'legal analyst', 'litigation paralegal',
    'contracts counsel', 'employment counsel',
    // GENERAL-CLASSIFICATION additions (S223 — +62 verified from live pool):
    'attorney',              // trial attorney, corporate attorney, etc.
    'compliance officer',    // compliance officer roles (4 hits — all legitimate)
    'compliance specialist', // compliance specialist roles (10 hits — all legitimate)
    'regulatory affairs',    // regulatory affairs specialist (9 hits — safe phrase)
    'regulatory specialist', // regulatory specialist titles
    'legal assistant',       // legal support roles
    'contracts specialist',  // contract management roles
    // TAG-1 S233: deep-dive residual gaps
    'contracts administrator',  // 7 hits — contract admin roles (defense, enterprise)
    'contract administrator',   // 10 hits — singular form
    // TAG-6 S233: promoted from O*NET
    'general counsel',          // 30 hits — in-house legal counsel
    // TAG-8 S237: FP audit — prevents O*NET 'product specialist' from capturing legal roles
    'legal engineer',           // 4 hits — legal/product specialist roles (Thomson Reuters)
    // TAG-9 S237: Phase 4 keyword expansion
    'contracts analyst',        // 2 hits — contract analysis/management
    // TAG-9 S237: Phase 6 keyword sweep
    'legal intern',             // 4 gen — legal internship roles
    // TAG-10 S237: Phase 12 random sample
    'contract specialist',      // 1 gen — contract management specialists
    // TAG-10 S237: Phase 13 varied sample
    'contracts coordinator',    // 1 gen — contract coordination
    'government affairs',       // 4 gen — government affairs/relations
    // TAG-10 S237: Claude-classified per-company keywords
    'law clerk',                // 2 gen — legal clerks (CACI defense)
    // TAG-11 S238: adaptive classifier cycle 2
    'content policy',           // 1 gen, 0 FP — content policy/moderation (Netflix)
    // TAG-11 S238: adaptive classifier cycle 4
    'case reviewer',            // 1 gen, 0 FP — case review (CACI defense)
    // TAG-11 S238: adaptive classifier cycle 13 (DoorDash)
    'federal affairs',          // 1 gen, 0 FP — government/federal affairs
    // TAG-11 S238: adaptive classifier cycle 15 (Cloudflare)
    'grc team',                 // 2 gen, 0 FP — governance risk compliance
    // TAG-11 S238: adaptive classifier cycle 16 (CrowdStrike)
    'patent agent',             // 1 gen, 0 FP — patent agent
    // TAG-11 S238: adaptive classifier cycle 18
    'tax litigation',            // 1 gen, 0 FP — tax litigation reporter
    'legal reporter',            // 1 gen, 0 FP — legal reporter
    'tax law analyst',           // 1 gen, 0 FP — tax law analyst
    // TAG-11 S238: cycle 20
    'claims law firm',          // 1 gen, 0 FP — claims law firm analyst (AIG)
    // TAG-11 S238: cycle 26
    'regulatory policy',        // 1 gen, 0 FP — regulatory policy (Coinbase)
    // TAG-11 S238: cycle 27
    'license compliance',       // 1 gen, 0 FP — license compliance (Autodesk)
    // TAG-11 S238: adaptive classifier cycle 8 (RTX)
    'federal defense lobbyist',      // 1 gen, 0 FP — defense lobbying
    // TAG-11 S239 C36: Disney legal
    'business affairs',             // 1 gen, 0 FP — Business Affairs Analyst (Disney media)
    'rights management',            // 1 gen, 0 FP — Analyst Rights Management (Disney DTC)
  ];
  // TAG-9: bare 'counsel' uses word-boundary — 'counselor' is a healthcare keyword,
  // includes('counsel') would match it. \bcounsel\b does not match 'counselor'.
  const counselRegex = /\bcounsel\b/i;
  const isComplianceEngineer = /\b(compliance engineer|compliance engineering)\b/i.test(title);
  if (!isComplianceEngineer && (legalKeywords.some(kw => title.includes(kw)) || counselRegex.test(job.title || ''))) {
    const legalMatch = findMatch(legalKeywords, title) || (counselRegex.test(job.title || '') ? 'counsel regex' : null);
    pushTag('legal', legalMatch, 'title');
  }

  // HR domain (title-only)
  const hrKeywords = [
    'recruiting coordinator', 'hr coordinator', 'hr analyst',
    'people operations', 'talent acquisition', 'human resources coordinator',
    'hr business partner', 'hris analyst',
    // GENERAL-CLASSIFICATION additions (S223 — +125 verified from live pool):
    'human resources',       // human resources specialist/generalist/manager
    'recruiter',             // technical recruiter, recruiter, founding recruiter
    'talent specialist',     // talent management specialist
    'staffing coordinator',  // staffing/scheduling coordinator
    // TAG-1 G1 expansion (S229): admin support roles
    'executive assistant',   // 99 hits — EA roles across industries
    'administrative assistant', // 58 hits — admin support
    // TAG-6 S233: data-driven keyword gaps
    'instructional designer',// 11 hits — L&D/training design (HR function)
    // TAG-9 S237: Phase 5 vocabulary extraction
    'hr business partner',   // HR-specific form (bare 'business partner' FPs on 'Finance Business Partner')
    // TAG-10 S237: Phase 4 bigram sweep
    'training specialist',   // 10 gen — L&D/corporate training
    // TAG-10 S237: Phase 6 exhaustive title classification
    'early childhood',       // 2 gen — early childhood education teachers
    // TAG-10 S237: Phase 7 niche terms
    'training coordinator',  // 2 gen — training coordination
    // TAG-10 S237: Phase 12 random sample
    'learning & development', 'learning and development', // 3 gen — L&D partners
    // TAG-11 S238: adaptive classifier cycle 1
    'talent attraction',     // 1 gen, 0 FP — talent sourcing/attraction
    'hr technology',         // 1 gen, 0 FP — HR tech/HRIS roles
    // TAG-11 S238: adaptive classifier cycle 2
    'accommodations consultant', // 1 gen, 0 FP — ADA/disability accommodations
    // TAG-11 S238: adaptive classifier cycle 5 (Booz Allen)
    'cyber human capital',       // 1 gen, 0 FP — cyber workforce HR strategy
    'disability support',        // 1 gen, 0 FP — disability support specialist
    // TAG-11 S238: adaptive classifier cycle 6 (Leidos)
    'hr assistant',              // 1 gen, 0 FP — HR assistant
  
    // TAG-11 S238: adaptive classifier cycle 8 (RTX)
    'team effectiveness',            // 1 gen, 0 FP — team effectiveness solutions
    // TAG-11 S238: adaptive classifier cycle 10 (Bosch) — FIXED: was in legal array by mistake
    'hr partner',                    // 1 gen, 0 FP — HR partner
    // TAG-11 S238: cycle 22
    'associate relations investigator', // 1 gen, 0 FP — associate relations (Capital One)
    // TAG-11 S238: adaptive classifier cycle 11
    'hr generalist',                 // 2 gen, 0 FP — HR generalist
    // TAG-11 S238: cycle 23
    'leave specialist',              // 2 gen, 0 FP — leave of absence specialist
    // TAG-11 S239 C36: Disney HR
    'talent strategy',              // 1 gen, 0 FP — ABC News Talent Strategy & Dev Intern (Disney)
    'recruitment coordinator',      // 1 gen, 0 FP — Recruitment Coordinator Disney Cruise Line
    'restrictions & accommodations', // 1 gen, 0 FP — Case Advocate Restrictions & Accommodations (Disney)
  ];
  if (hrKeywords.some(kw => title.includes(kw))) {
    pushTag('hr', findMatch(hrKeywords, title), 'title');
  }

  // Product domain
  const productKeywords = [
    'product manager', 'product designer', 'ux designer',
    'ui designer', 'user experience', 'product owner', 'product marketing',
    // INTERN-1a Wave 2:
    'ux design', 'ux research', 'ux researcher', 'ui/ux',
    'industrial design', 'content design', 'experience design',
    'web experience design', 'product analytics', 'technical ux', 'game design',
    // TAG-8 S237: FP audit keyword expansion
    'product design intern',     // 7 hits — product design internship roles
    // TAG-9 S237: Phase 5 vocabulary extraction
    'digital product',           // 8 gen, 71% spec — digital product management
    'technical product',         // 5 gen, 86% spec — technical product management
    // TAG-10 S237: Claude-classified per-company keywords
    'animator',                  // 5 gen — animation roles (DreamWorks/NBCUniversal)
    // TAG-10 S237: Phase 10 random sample reading
    'lighting artist',           // 1 gen — VFX/game lighting artists
    'compositor',                // 1 gen — VFX compositing artists
    // TAG-10 S237: Phase 4 bigram sweep
    'product management',        // 20 gen — product management roles
    // TAG-11 S238: adaptive classifier cycle 11
    'product coordinator',       // 1 gen, 0 FP — product coordinator
    // TAG-11 S238: adaptive classifier cycle 18
    'cx researcher',             // 1 gen, 0 FP — CX research & info design (Trimble)
  ];
  if (productKeywords.some(kw => title.includes(kw))) {
    pushTag('product', findMatch(productKeywords, title), 'title');
  }

  // Retail domain (title-only — GENERAL-CLASSIFICATION new domain, S223)
  // ~1,241 US+general jobs verified from live pool.
  // 'team member' is very broad but in-scope: Walmart/Target/DashMart crew roles are correctly retail.
  // 'seasonal:' with colon catches Target "Seasonal: General Merchandise (Stocking)" format.
  // Guard: isRetailBanking excludes "Retail Personal Banker", "Retail Loan Originator" — those are finance.
  const retailKeywords = [
    'cashier',               // #1 retail job title (~300+ hits)
    'store associate',       // big box retail associate
    'retail',                // retail specialist, retail sales, retail associate
    'merchandis',            // merchandiser, merchandising (prefix match)
    'stocker',               // grocery/retail stocker
    'loader',                // Lowe's/HD loader/cart associate
    'cart associate',        // cart retrieval crew
    'stocking',              // overnight stocking, inbound stocking
    'crew member',           // fast food/restaurant crew
    'team member',           // Walmart/Target/Sam's Club team member
    'barista',               // Starbucks/coffee shop
    'seasonal:',             // Target seasonal format "Seasonal: [role] (Stocking)"
    'backroom associate',    // Target/Walmart backroom
    'overnight inbound',     // Target overnight inbound freight
    // TAG-1 G1 expansion (S229): 347+90 T-Mobile retail roles
    'mobile associate',      // T-Mobile in-store retail (347 hits)
    'specialty representative', // T-Mobile in-store specialty (90 hits)
    // TAG-1 S233: G1 keyword expansion — 52 US general reclassifications
    'personal shopper',      // 22 hits — Walmart/Target personal shopper
    'member specialist',     // 30 hits — Sam's Club/Walmart member specialist
    // TAG-6 S233: data-driven keyword gaps
    'sales floor',           // 43 hits — Lowe's department supervisors
    'asset protection',      // 17 hits — Lowe's/Walmart loss prevention
    // TAG-11 S238: adaptive classifier cycle 2
    'back-end dept supervisor', // 2 gen, 0 FP — store department supervision (Lowe's)
    // TAG-11 S238: cycle 30
    'seasonal summer hiring',   // 1 gen, 0 FP — seasonal retail hiring (WBD Harry Potter)
    // TAG-12 S238: moved from marketing (TAG-12 audit: Lowe's customer service/stocking)
    'back end clerk',            // 4 gen — Lowe's back-end store clerks
    // TAG-11 S239 C33: NBCUniversal retail (theme park/hospitality)
    'margaritaville',            // 1 gen, 0 FP — Assistant GM - Margaritaville (NBCUniversal)
  ];
  const isRetailBanking = /\b(banker|banking|loan originator|mortgage|lender)\b/i.test(title);
  if (!isRetailBanking && retailKeywords.some(kw => title.includes(kw))) {
    pushTag('retail', findMatch(retailKeywords, title), 'title');
  }

  // Manufacturing domain (title-only — GENERAL-CLASSIFICATION new domain, S223)
  // ~1,004 US+general jobs verified from live pool.
  // 'manufacturing engineer' already covered by hardwareKeywords — these are production-floor roles.
  // 'assembly' is safe: all hits are assembly tech/technician/operator titles, no legislative false positives.
  const manufacturingKeywords = [
    'machine operator',          // CNC/machine operator
    'production operator',       // production floor operator
    'assembler',                 // assembly line worker
    'assembly',                  // assembly technician, electronics assembly
    'welder',                    // welding/weld technician
    'machinist',                 // CNC machinist
    'production associate',      // production floor associate
    'production technician',     // production tech
    'material handler',          // materials/warehouse handling on production floor
    'maintenance technician',    // TAXONOMY-AUDIT-1: 203 jobs in general (S225)
    // TAG-1 G1 expansion (S229): test/engineering technician roles on production floor
    'test technician',           // 68 hits — RF/optical/production test (FLIR, RTX, GE)
    'engineering technician',    // 47 hits — manufacturing/production engineering
    // TAG-1 S233: G1 keyword expansion — 123 US general reclassifications
    'manufacturing operator',    // 35 hits — factory floor operators
    'manufacturing technician',  // 50 hits — manufacturing production techs
    'fabricat',                  // 38 hits — fabricator/fabrication (prefix match)
    // TAG-1 S233: SR general rate investigation
    'wastewater',                // 20 hits — wastewater operator/technician (Veolia, SpaceX)
    // TAG-6 S233: promoted from O*NET
    'manufacturing supervisor',  // 16 hits — production floor supervisors
    // TAG-8 S237: FP audit keyword expansion
    'production supervisor',     // 43 hits — production floor supervisors
    'painter',                   // 18 hits — industrial/automotive/facility painters
    'production planner',        // 10 hits — production planning/scheduling
    // TAG-9 S237: Phase 1 keyword expansion
    'cnc programmer',            // 5 hits — CNC machine programming
    'mold designer',             // 1 hit — injection mold design
    'metrologist',               // 2 hits — precision measurement roles
    'industrial maintenance',    // 3 hits — industrial maintenance technicians
    // TAG-9 S237: Phase 3 keyword expansion
    'cycle counter',             // 3 hits — inventory cycle counting (manufacturing floor)
    // TAG-9 S237: Phase 4 keyword expansion
    'quality technician',        // 5 hits — QC/QA floor technicians
    'production specialist',     // 4 hits — production floor specialists
    // TAG-9 S237: Phase 6 keyword sweep
    'maintenance mechanic',      // 4 gen — compound form safe (bare 'mechanic' rejected Phase 1)
    'maintenance supervisor',    // 5 gen — maintenance floor supervisors
    'cnc operator',              // 4 gen — CNC machine operators
    'materials planner',         // 4 gen — materials/production planning
    'product acceptance',        // 4 gen — product acceptance/QA
    'material support',          // 4 gen — material handling support
    'peripheral operator',       // 5 gen — peripheral/auxiliary equipment operators
    // TAG-10 S237: Claude-classified per-company keywords
    'paint prep',                // 3 gen — paint preparation (Oshkosh)
    'paint tech',                // 3 gen — paint technician
    'industrial hygienist',      // 2 gen — workplace safety/hygiene
    'production coach',          // 2 gen — production floor supervisors (Moog)
    'production equipment',      // 8 gen — production equipment technicians (Broadridge)
    'quality assurance',         // 12 gen — QA supervisors/reviewers (Abbott, Biogen)
    'mechanical repair',         // 2 gen — mechanical repair technicians
    // TAG-10 S237: Phase 6 exhaustive title classification
    'deburr',                    // 6 gen — deburring technicians (Jabil)
    'iron technician',           // 2 gen — iron/metalwork technicians
    'generator tester',          // 2 gen — generator testing
    'apprentice',                // 11 gen — trade apprenticeships
    // TAG-10 S237: Phase 9 random sample discovery
    'finisher',                  // 2 gen — manufacturing finishers
    'ndt technician',            // 4 gen — non-destructive testing techs (was desc phrase only)
    // TAG-10 S237: Phase 11 random sample
    'tool & die', 'tool and die', // 2 gen — tool & die engineering/making
    // TAG-10 S237: Phase 12 random sample
    'ndt tech',                  // 1 gen — short form of NDT technician
    'nc programmer',             // 1 gen — NC machine programming
    'smt technician',            // 3 gen — surface mount technology
    // TAG-10 S237: Phase 13 varied sample
    'insulator',                 // 1 gen — insulation installers
    'production support',        // 2 gen — production support technicians
    // TAG-10 S237: Phase 3 normalized title sweep
    'production coordinator',    // 6 gen — production coordination
    'maintenance tech',          // 6 gen — short form of maintenance technician
    'automotive detailer',       // 12 gen — vehicle detailing (Copart)
    'mechanical associate',      // 12 gen — mechanical repair associates (Copart)
    // TAG-11 S238: adaptive classifier cycle 1
    'modification mechanic',     // 3 gen, 0 FP — aircraft modification mechanics (Boeing)
    'wrapper',                   // 2 gen, 0 FP — packaging/wrapping roles (JCI)
    'glass seal plater',         // 1 gen, 0 FP — glass seal plating (FLIR)
    'launch pad technician',     // 1 gen, 0 FP — launch pad ground ops (SpaceX)
    // TAG-11 S238: adaptive classifier cycle 2
    'tester i',                  // 3 gen, 0 FP — manufacturing tester level I
    // TAG-11 S238: adaptive classifier cycle 3
    'plumber',                   // 2 gen, 0 FP — plumbing roles (Oshkosh airports)
    'jetway laborer',            // 1 gen, 0 FP — airport jetway labor (Oshkosh)
    'bag jammer',                // 1 gen, 0 FP — airport baggage handling (Oshkosh)
    'paint touch',               // 1 gen, 0 FP — paint touch-up/detailing
    'graphics application',      // 1 gen, 0 FP — vehicle graphics application
    // TAG-11 S238: adaptive classifier cycle 8 (RTX + KBR)
    'machine tool services',     // 1 gen, 0 FP — machine tool services supervisor
    'production worker',         // 1 gen, 0 FP — production worker
    'facilities operator',       // 2 gen, 0 FP — facilities operator
    'brake component',           // 1 gen, 0 FP — brake component operator
    'production integration',    // 1 gen, 0 FP — production integration specialist
    'special process auditor',   // 1 gen, 0 FP — special process auditing
    'supervisor, installations', // 1 gen, 0 FP — installations supervisor
    // TAG-11 S238: adaptive classifier cycle 9 (Boeing)
    // TAG-11 S238: adaptive classifier cycle 10
    'honing set-up',                // 1 gen, 0 FP — honing setup (Bosch)
    'electrical journeyperson',     // 2 gen, 0 FP — electrical journeyperson (GM)
    'mechanical journeyperson',     // 1 gen, 0 FP — millwright journeyperson (GM)
    'metrology specialist',         // 1 gen, 0 FP — metrology specialist (SpaceX)
    'pipefitter',                   // 1 gen, 0 FP — pipefitter (FLIR)
    'component inspection',         // 1 gen, 0 FP — component inspection (FLIR)
    'lab equipment control',        // 1 gen, 0 FP — lab equipment diagnostics (FLIR)
    'in house service',             // 1 gen, 0 FP — in-house service/repair (FLIR)
    'manufacturing program',        // 1 gen, 0 FP — manufacturing program mgr (FLIR)

    'composite rework',          // 1 gen, 0 FP — composite rework/repair
    'product repair',            // 2 gen, 0 FP — product repair/modification
    'flight operations mechanic', // 2 gen, 0 FP — flight ops mechanic
    'numerical control programmer', // 1 gen, 0 FP — NC programming
    'munitions mechanic',        // 1 gen, 0 FP — munitions mechanic
    'plating line',              // 1 gen, 0 FP — plating line technician
    // TAG-11 S238: adaptive classifier cycle 15 (Biogen)
    'antisense',                 // 1 gen, 0 FP — antisense oligonucleotide manufacturing
    // TAG-11 S238: adaptive classifier cycle 16 (Baker Hughes)
    'maintenance operator',      // 1 gen, 0 FP — maintenance operator
    // TAG-11 S238: adaptive classifier cycle 17
    'pyrometry technician',      // 1 gen, 0 FP — pyrometry (Moog)
    // TAG-11 S238: cycle 25
    'mfg maint tech',            // 2 gen, 0 FP — mfg maintenance technician
    'multilayer',                // 1 gen, 0 FP — multilayer process specialist (Northrop)
    // TAG-11 S238: cycle 26
    'manufacturing operations trainer', // 1 gen, 0 FP — mfg ops trainer (Generac)
    // TAG-11 S238: cycle 27
    'automotive offline',            // 2 gen, 0 FP — automotive offline technician (Oshkosh)
    // TAG-11 S238: cycle 20
    'clutch balancer',           // 1 gen, 0 FP — clutch balancer tech (Polaris)
    'manufacturing excellence',  // 1 gen, 0 FP — manufacturing excellence program
    // TAG-11 S238: cycle 21
    'recon mechanic',            // 1 gen, 0 FP — recon mechanic (Copart)
    // TAG-11 S238: cycle 22
    'paint hanger',              // 2 gen, 0 FP — paint hanger (Generac)
    'patternmaker',              // 1 gen, 0 FP — patternmaker (Caterpillar)
    // TAG-11 S239 C34: Boeing manufacturing
    'material review',           // 1 gen, 0 FP — Quality Production Spclst MRB (Boeing)
    'quality production spclst', // 1 gen, 0 FP — Quality Production Specialist (Boeing)
    'support integration specialist', // 1 gen, 0 FP — Support Integration Specialist (Boeing)
    // TAG-11 S239 C35: RTX manufacturing
    'supv manufacturing',            // 1 gen, 0 FP — Supv Manufacturing (RTX, abbreviated supervisor)
  ];
  // EHS uses word-boundary regex — 'ehs' substring appears in 'FranceHS', 'EHSS'
  const ehsRegex = /\behs\b/i;
  if (manufacturingKeywords.some(kw => title.includes(kw)) || ehsRegex.test(job.title || '')) {
    const mfgMatch = findMatch(manufacturingKeywords, title) || (ehsRegex.test(job.title || '') ? 'ehs regex' : null);
    pushTag('manufacturing', mfgMatch, 'title');
  }

  // Logistics domain (title-only — GENERAL-CLASSIFICATION new domain, S223)
  // ~426 US+general jobs verified from live pool (409 core + 17 'distribution center' phrase).
  // NOTE: bare 'distribution' NOT added — "Distribution Engineer" (utility/electrical) is hardware domain.
  // NOTE: bare 'shipping' NOT added — "Shipping Coordinator" is already ops-adjacent and low volume.
  // 'logistics' kept here because 'logistics analyst' is already captured by operations domain keywords —
  //   remaining hits are warehouse/supply-chain workers, not analyst roles.
  const logisticsKeywords = [
    'warehouse',             // warehouse worker/associate/supervisor
    'forklift',              // forklift operator/driver
    'cdl',                   // CDL driver (commercial driver's license)
    'delivery driver',       // last-mile delivery
    'freight',               // freight handler/clerk
    'logistics coordinator', 'logistics specialist', 'logistics clerk',  // specific logistics roles
    'logistics associate', 'logistics supervisor', 'logistics technician', // (bare 'logistics' NOT added —
    // 'Logistics Engineer' and 'Logistics Automation Engineer' are hardware/software, not logistics)
    'truck driver',          // OTR/regional truck driver
    'distribution center',   // distribution center worker/supervisor (phrase — safe, no hw FP)
    // TAG-1 G1 expansion (S229): supply chain specialist/coordinator
    'supply chain specialist',   // supply chain roles not caught by operations 'supply chain analyst'
    'supply chain coordinator',  // coordination roles
    // TAG-6 S233: promoted from O*NET
    'inventory associate',       // 17 hits — inventory/warehouse associate
    // TAG-8 S237: FP audit keyword expansion
    'dispatcher',                // 8 hits — logistics/fleet dispatch roles
    // TAG-9 S237: Phase 3 keyword expansion
    'distribution specialist',   // 2 hits — distribution/logistics specialists
    // TAG-10 S237: Phase 9 random sample discovery
    'shipping clerk',            // 1 gen — shipping/receiving clerks
    'loadmaster',                // 1 gen — aircraft loadmasters
    // TAG-10 S237: Phase 11 plural fix
    'logistic coordinator',      // 1 gen — singular form (had 'logistics coordinator')
    // TAG-10 S237: Phase 13 varied sample
    'shipping associate',        // 5 gen — shipping/receiving associates
    // TAG-10 S237: Phase 14 varied sample
    'shuttle driver',            // 2 gen — shuttle/transport drivers
  
    // TAG-11 S238: adaptive classifier cycle 8 (RTX + KBR)
    'dispatching clerk',             // 1 gen, 0 FP — dispatching clerk
    'logistics administration',      // 1 gen, 0 FP — logistics administration
    // TAG-11 S238: adaptive classifier cycle 9 (Boeing)
    // TAG-11 S238: adaptive classifier cycle 10 (SpaceX)
    'material transfer driver',     // 1 gen, 0 FP — material transfer driver

    'packaging & shipping',          // 1 gen, 0 FP — packaging/shipping planner
    // TAG-11 S238: cycle 28
    'logistics integration cell',    // 1 gen, 0 FP — logistics integration cell (RTX)
  ];
  if (logisticsKeywords.some(kw => title.includes(kw))) {
    pushTag('logistics', findMatch(logisticsKeywords, title), 'title');
  }

  // TAG-7: Description fallback for general-tagged jobs.
  // WD/SR descriptions injected by aggregator Step 4c (from enrichment sidecar).
  // GH/Lever/Ashby have inline descriptions from their API responses.
  // Only fires when: (1) no title keyword/O*NET match, (2) description non-empty.
  // TAG-10 S238: 2-tier threshold system based on measured phrase precision.
  // Tier 1 (highPrecision): phrases with >80% precision — 1 match suffices.
  // Tier 2 (standard): phrases with <80% precision — 2+ matches required.
  // Precision = % of US classified jobs containing the phrase that are in the intended domain.
  // Measured across 22,513 US jobs with descriptions (S238 analysis).
  if (tags.length === 0 && description.length > 100) {
    const cleanDesc = description.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').toLowerCase();

    // Tier 1: High-precision phrases (>80% precision). 1 match = classify.
    const highPrecision = [
      { domain: 'hardware', phrases: ['thermal design', 'circuit design', 'fpga', 'pcb', 'signal integrity', 'oscilloscope', 'mechanical design'] },
      { domain: 'software', phrases: ['code review', 'ci/cd', 'api design', 'microservice', 'deployment pipeline', 'kubernetes', 'docker', 'terraform', 'containerization', 'pull request', 'load balancer', 'codebase', 'automated testing', 'encryption'] },
      { domain: 'data_science', phrases: ['feature engineering'] },
      { domain: 'finance', phrases: ['financial statements', 'fund administration', 'gaap', 'ifrs', 'general ledger', 'journal entry', 'month-end close', 'fund accounting', 'balance sheet', 'income statement', 'wealth management'] },
      { domain: 'healthcare', phrases: ['drug safety', 'vital signs', 'informed consent', 'blood draw', 'nursing assessment', 'clinical operations', 'medical affairs'] },
      { domain: 'manufacturing', phrases: ['machine operation'] },
      { domain: 'sales', phrases: ['sales quota', 'sales pipeline', 'revenue target'] },
      { domain: 'legal', phrases: ['bar admission', 'legal counsel'] },
      { domain: 'retail', phrases: ['store operations'] },
    ];

    // Tier 2: Standard phrases (<80% precision). 2+ matches required.
    const standardPhrases = [
      { domain: 'hardware', phrases: ['simulation', 'commissioning', 'equipment calibration', 'test systems', 'embedded system', 'power supply', 'schematic',
        'solidworks', 'autocad', 'electrical engineering', 'failure analysis', 'bill of materials', 'prototyping', 'wiring diagram',
        'semiconductor', 'wafer', 'silicon', 'plc'] },
      { domain: 'software', phrases: ['source code', 'database design', 'incident response', 'version control', 'agile development', 'sprint planning', 'unit test',
        'programming language', 'technical debt',
        'endpoint', 'virtualization', 'firewall', 'test automation', 'regression test', 'dns'] },
      { domain: 'data_science', phrases: ['machine learning', 'statistical model', 'data pipeline', 'model training', 'a/b test', 'data warehouse', 'etl process', 'predictive model'] },
      { domain: 'finance', phrases: ['treasury', 'portfolio management', 'credit risk', 'financial reporting',
        'reconciliation', 'accounts payable', 'accounts receivable', 'internal controls',
        'investment management', 'asset management', 'fixed income', 'capital markets',
        'real estate', 'shareholder', 'budgeting', 'money laundering'] },
      { domain: 'healthcare', phrases: ['patient care', 'clinical trial', 'hipaa', 'therapeutic area', 'medical device', 'pharma', 'clinical research', 'fda', 'healthcare provider',
        'triage', 'infection control', 'sterile', 'specimen', 'inpatient', 'outpatient',
        'patient outcomes', 'regulatory affairs', 'drug development', 'therapeutics'] },
      { domain: 'manufacturing', phrases: ['production floor', 'assembly line', 'quality control', 'manufacturing process', 'cnc', 'lean manufacturing', 'production schedule', 'material handling',
        'work instruction', 'tooling', 'fixtures', 'preventive maintenance', 'iso 9001',
        'production line', 'clean room', 'gmp', 'good manufacturing',
        'cleanroom', 'machining', 'ndt', 'defect analysis'] },
      { domain: 'operations', phrases: ['project management', 'inventory management', 'operational efficiency', 'process improvement', 'vendor management', 'supply chain', 'fulfillment', 'service level',
        'facility security', 'classified information', 'industrial security',
        'procurement', 'property management', 'compliance program'] },
      { domain: 'sales', phrases: ['territory management', 'customer acquisition', 'business development', 'account management', 'product demonstration',
        'field-based'] },
      { domain: 'hr', phrases: ['employee relations', 'talent management', 'onboarding', 'performance review', 'compensation and benefits', 'workforce planning', 'learning and development'] },
      { domain: 'legal', phrases: ['litigation', 'regulatory compliance', 'contract negotiation', 'intellectual property', 'corporate governance'] },
      { domain: 'marketing', phrases: ['brand strategy', 'content marketing', 'digital marketing', 'market research', 'campaign management', 'social media strategy', 'marketing analytics'] },
      { domain: 'retail', phrases: ['merchandising', 'product categories', 'store manager'] },
    ];

    // Tier 1: single high-precision match
    for (const { domain, phrases } of highPrecision) {
      const match = phrases.find(p => cleanDesc.includes(p));
      if (match) {
        pushTag(domain, '(desc-hp: ' + match + ')', 'description-fallback');
        break;
      }
    }

    // Tier 2: 2+ standard phrase matches (only if Tier 1 didn't match)
    if (tags.length === 0) {
      for (const { domain, phrases } of standardPhrases) {
        const matches = phrases.filter(p => cleanDesc.includes(p));
        if (matches.length >= 2) {
          pushTag(domain, '(desc: ' + matches.slice(0, 2).join(' + ') + ')', 'description-fallback');
          break;
        }
      }
    }
  }

  // O*NET taxonomy fallback (unified): 28,486 title variants from O*NET v29.1.
  // 3+ word titles: substring matching (safe — long titles have few collisions).
  // 2-word titles: word-boundary regex (prevents "air technician" ← "Repair Technician").
  // Both word-indexed for fast candidate filtering.
  // Source: O*NET v29.1 (public domain, CC BY 4.0). See TAG_CLASSIFICATION_RESEARCH_S233.md.
  if (tags.length === 0) {
    const titleWords = title.split(/\s+/).filter(w => w.length >= 4);

    // Pass 1: 3+ word substring matches (longest-first, pre-sorted)
    if (ONET.substringEntries.length > 0) {
      const candidates = new Set();
      for (const word of titleWords) {
        const indices = ONET.substringWordIndex.get(word);
        if (indices) indices.forEach(i => candidates.add(i));
      }
      for (const idx of [...candidates].sort((a, b) => a - b)) {
        const [onetTitle, domain] = ONET.substringEntries[idx];
        if (title.includes(onetTitle)) {
          pushTag(domain, '(onet: ' + onetTitle + ')', 'onet-fallback');
          break;
        }
      }
    }

    // Pass 2: 2-word regex matches (only if pass 1 didn't match)
    if (tags.length === 0 && ONET.regexEntries.length > 0) {
      for (const word of titleWords) {
        const indices = ONET.regexWordIndex.get(word);
        if (!indices) continue;
        for (const idx of indices) {
          const entry = ONET.regexEntries[idx];
          if (entry.re.test(title)) {
            pushTag(entry.domain, '(onet: ' + entry.title + ')', 'onet-fallback');
            break;
          }
        }
        if (tags.length > 0) break;
      }
    }
  }

  // Layer 5: Tenant-context fallback (TAG-10 S237)
  // Claude-researched per-tenant defaults for verified single-domain companies.
  // Only fires when ALL other layers (dept, keywords, O*NET, desc-fallback) produce no match.
  if (tags.length === 0 && TENANT_DEFAULTS.size > 0) {
    const slug = (job.company_slug || '').toLowerCase();
    const defaultDomain = TENANT_DEFAULTS.get(slug);
    if (defaultDomain) {
      pushTag(defaultDomain, '(tenant: ' + slug + ')', 'tenant-context');
    }
  }

  // Default to general if still no matches
  if (tags.length === 0) {
    pushTag('general', null, null);
  }

  // Deduplicate domains — a job can match the same domain from multiple layers
  // (e.g., department rule + title keyword both → software). Debug matches
  // retain all records for traceability; only the domain array is deduped.
  const uniqueTags = [...new Set(tags)];

  if (debug) return { domains: uniqueTags, matches };
  return uniqueTags;
}

/**
 * US-only company slugs for Layer 2b location fallback.
 * Applied when no us tag yet AND job is not explicitly non-US.
 * NO bare-string restriction — fires for any location string (facility names, campus names, etc.).
 * ONLY slugs with ZERO confirmed non-US offices. NON_US blocklist still runs first.
 * Do NOT add any company with offices outside the US — use US_HQ_SLUGS instead.
 */
const US_HQ_ONLY_SLUGS = new Set([
  'wvu-medicine',            // WV health system — all WV/adjacent US facilities
  'banner-health',           // AZ health system — US-only
  'geisinger-health',        // PA health system — US-only
  "nationwide-children's",   // OH children's hospital — US-only
]);

/**
 * US-headquartered company slugs used for Layer 2 location fallback.
 * Only applied when Layer 1 (explicit location string) returns no US signal AND
 * the location string is an ambiguous bare value ('In-Office', 'Remote', 'N Locations').
 * These are companies where ANY office posting is plausibly US — US-only or near-US-only footprint.
 * Do NOT add multinational companies whose non-US offices post with bare location strings.
 */
const US_HQ_SLUGS = new Set([
  // Original entries
  'cloudflare',        // In-Office (37 interns, US-only HQ pattern)
  'geisinger-health',  // Work from Home (9 interns, US healthcare system)
  'caci',              // Remote (2 interns, US defense contractor)
  'voltus',            // Remote (2 interns, US energy startup)
  'supabase',          // Remote (1 intern, US startup)
  'safariai',          // Remote (1 intern, US startup)
  'f5',                // N Locations (4 interns, US networking company)
  'leidos',            // Remote/Teleworker US (5 interns, US defense contractor)
  // LOC-AUDIT-1 additions (2026-03-15 S177) — verified US-only N-Location posters
  'wvu-medicine',           // N Locations — US health system (West Virginia)
  'banner-health',          // N Locations — US health system (Arizona)
  'pnc-financial',          // N Locations — US bank (Pittsburgh-HQ)
  'fidelity-investments',   // N Locations — US financial services
  'allstate',               // N Locations — US insurer (Northbrook IL)
  'general-motors',         // N Locations — US automaker (Detroit)
  'snap',                   // N Locations — US tech (Santa Monica)
  'ncino',                  // N Locations — US fintech (Wilmington NC)
  'workiva',                // N Locations — US SaaS (Ames IA)
  "nationwide-children's",  // N Locations — US children's hospital (Columbus OH)
  'elevance-health',        // N Locations — US health insurer (Indianapolis)
  'northrop-grumman',       // N Locations — US defense (Falls Church VA)
  'coreweave',              // N Locations — US cloud (Roseland NJ)
  'at&t',                   // N Locations — US telecom (Dallas)
  'draftkings',             // N Locations — US sports betting (Boston)
  'boeing',                 // N Locations — US aerospace (Arlington VA)
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
  'budapest', 'debrecen', // Hungary
  'haifa', 'tel aviv', 'jerusalem', // Israel (tel aviv already above, kept for clarity)
  'beijing', 'shanghai', 'shenzhen', 'guangzhou', 'chengdu', 'hangzhou', // China
  'dubai', 'abu dhabi', // UAE
  'moscow', 'saint petersburg', // Russia
  'cairo', // Egypt
  'nairobi', // Kenya
  'lagos', // Nigeria
  'johannesburg', 'cape town', // South Africa
  'bogota', // Colombia
  'lima', // Peru
  'santiago', // Chile
  'buenos aires', // Argentina
  'ho chi minh', 'hanoi', // Vietnam
  'jakarta', // Indonesia
  'bangkok', // Thailand
  'kuala lumpur', // Malaysia
  'manila', // Philippines
  'athens', // Greece
  'rome', 'milan', // Italy
  'brussels', 'antwerp', // Belgium
  'vienna', 'graz', // Austria
  'oslo', // Norway
  'helsinki', // Finland
  'copenhagen', // Denmark
  'tijuana', 'baja california', // Mexico (prevents 'california' usKeyword false match)
];

/**
 * Tag locations (multi-select)
 * Handles both JSearch format (job.is_us_only, job.is_remote)
 * and ATS format (job.location as string, no job_country field)
 */
function tagLocations(job) {
  const tags = [];

  // ATS-provided workplace type (Lever: workplaceType, Ashby: is_remote).
  // More reliable than inferring from location string.
  const workplaceType = (job.workplace_type || '').toLowerCase();
  if (workplaceType === 'remote') tags.push('remote');
  else if (workplaceType === 'hybrid') tags.push('hybrid');

  // Combine all location fields for checking.
  // Normalize en-dash (–) and em-dash (—) to hyphen for consistent keyword matching.
  const locationStr = (
    job.location || job.job_city || job.job_location || job.job_country || ''
  ).toLowerCase().replace(/[\u2013\u2014]/g, '-');

  // is_us_only takes priority over all location string analysis.
  // Must be checked FIRST — hospital campus names like "Indian River Hospital" contain
  // NON_US_LOCATIONS substrings ("india") that would otherwise falsely block the us tag.
  const hasNonUS = job.is_us_only !== true &&
    NON_US_LOCATIONS.some(place => locationStr.includes(place));

  if (job.is_us_only === true) {
    tags.push('us');
  } else if (locationStr) {
    // AGG-8: Check US indicators BEFORE applying non-US blocklist.
    // Multi-country listings ("Canada; United States", "Remote (Canada / USA)")
    // contain both non-US and US signals. Previous logic blocked US detection
    // if ANY non-US location was present. Now: US signal wins over non-US blocklist,
    // because the job IS available in the US regardless of other countries.
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
      // AGG-8: patterns missed by S230 audit (Mozilla "Remote US", DataCamp multi-country, etc.)
      'remote us',       // "Remote US" — no prefix before "us"
      '/ usa',           // "Remote (Canada / USA)" — slash-separated
      '/ us',            // alternative slash format
    ];
    // All 50 state abbreviations: match after comma only (comma-delimited, e.g. "Boise, ID").
    // Previous regex matched after space/pipe too — caused "Vaci ut 47" to match 'ut' as Utah.
    // Comma-only is stricter and matches the "City, ST" convention used by all major ATS systems.
    const US_STATE_ABBR = new Set([
      'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
      'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
      'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
      'va','wa','wv','wi','wy','dc'
    ]);
    const stateAbbrRe = /,\s*([a-z]{2})\b/g;
    let stateAbbrM;
    let hasStateAbbr = false;
    while ((stateAbbrM = stateAbbrRe.exec(locationStr)) !== null) {
      if (US_STATE_ABBR.has(stateAbbrM[1])) { hasStateAbbr = true; break; }
    }

    // TAG-1 S233: \busa\b catches space-delimited "City ST USA" (GE Vernova, GE Aerospace)
    // that aren't caught by delimiter-prefixed patterns ('- usa', ', usa')
    const hasUsaWord = /\busa\b/i.test(locationStr);
    const hasUsKeyword = usKeywords.some(s => locationStr.includes(s)) || hasStateAbbr || hasUsaWord;

    if (hasUsKeyword) {
      // TAG-1 S233: If both US and non-US signals present, check if the non-US
      // signal is a real country match or just a substring collision.
      // "Indianapolis, IN" contains "india" (substring). "Cambridge, United Kingdom"
      // contains "cambridge" (US city). The non-US signal is reliable only when
      // it's a full country/city name NOT embedded in a US place name.
      if (hasNonUS) {
        // Explicit non-US country that can't be a US substring
        // Mexico needs special handling: "New Mexico" is a US state, but bare "Mexico" is non-US
        const hasMexico = /\bmexico\b/i.test(locationStr) && !/\bnew mexico\b/i.test(locationStr);
        const hasRealNonUSCountry = hasMexico || /\bunited kingdom\b|\baustralia\b|\bgermany\b|\bfrance\b|\bjapan\b|\bswitzerland\b|\bsweden\b|\bnetherlands\b|\bireland\b|\bsingapore\b|\bbrazil\b|\bcanada\b|\bcolombia\b|\bspain\b|\bisrael\b|\bsouth korea\b|\bnew zealand\b|\bsouth africa\b|\bpoland\b|\bczech\b|\bdenmark\b|\bnorway\b|\bfinland\b|\bbelgium\b|\baustria\b|\bitaly\b|\bportugal\b|\bhungary\b|\bromania\b|\bturkey\b|\btaiwan\b/i.test(locationStr);
        // Non-US countries whose names collide with US places — only block if NOT in a US context
        // 'india' → "Indianapolis, IN" is US. "Bangalore, India" is not.
        // 'mexico' → "New Mexico" is US. "Mexico City" is not.
        // 'canada' → "Remote US & Canada" is multi-country.
        // 'georgia' → US state. "Georgia (country)" would need explicit signal.
        const hasCollisionNonUS = !hasRealNonUSCountry && hasNonUS;

        if (hasRealNonUSCountry) {
          // Real non-US country present. Only tag US if explicit US country signal too (multi-country).
          const hasExplicitUSCountry = /\bunited states\b|\busa\b|\bus\s*[&;\/]|\b(?:remote|hybrid)\s+us\b|,\s*us\b/i.test(locationStr);
          if (hasExplicitUSCountry) {
            tags.push('us'); // Multi-country
          }
          // else: non-US country wins over city/state match
        } else {
          // Non-US signal is a substring collision (india/mexico/canada/georgia) —
          // US keyword is more specific, tag US
          tags.push('us');
        }
      } else {
        tags.push('us');
      }
    } else if (hasNonUS) {
      // Non-US location detected and NO US signal found — skip US tag.
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

    // Layer 2b: US-only health systems — post with facility names as location strings.
    // No bare-string restriction. NON_US blocklist ran first (hasNonUS check above).
    // Only slugs with ZERO confirmed non-US offices — see US_HQ_ONLY_SLUGS definition.
    if (!tags.includes('us') && !hasNonUS && US_HQ_ONLY_SLUGS.has(job.company_slug)) {
      tags.push('us');
    }

    // Layer 3: explicit US pattern strings not caught by Layer 1 keywords.
    // 'USA - Remote', 'USA Remote' — reversed order vs '- usa' keyword.
    // 'US-XX-...' — Workday dash-separated site codes (US-CT-EAST HARTFORD-...).
    // 'US XX City' — Workday space-separated site codes (US VA Sterling, US NC Cary).
    // 'US - Remote', 'US - CO, Westminster' — Workday US-dash format (LOC-AUDIT-2).
    // 'XX - City' — Workday ST-City format (LOC-AUDIT-2): CT - Hartford, FL - Miami.
    if (!tags.includes('us')) {
      if (/^usa[\s\-:]/i.test(locationStr) ||
          /^us-[a-z]{2}-/i.test(locationStr) ||
          /^us [a-z]{2} /i.test(locationStr) ||
          /^us\s*-\s*/i.test(locationStr)) {
        tags.push('us');
      }
    }

    // ST-City format: 'XX - CityName' used by PNC, Travelers, SoFi, etc.
    // Only match codes that are unambiguously US state abbreviations.
    // Excluded: IN (India collision), CA (Canada collision), and all ISO country codes.
    // LOC-AUDIT-2 data (2026-03-15): 286 recoverable jobs across FL/PA/NJ/DE/OH/TX/IL/CT etc.
    if (!tags.includes('us')) {
      const ST_CITY_US_CODES = new Set([
        'al','ak','az','ar','co','ct','de','fl','ga','hi','id','il','ia',
        'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
        'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
        'va','wa','wv','wi','wy','dc'
        // 'in' excluded — collides with India (Stripe: 'IN - Bengaluru')
        // 'ca' excluded — collides with Canada (RTX: 'CA-QC-LONGUEUIL')
      ]);
      const stCityM = locationStr.match(/^([a-z]{2})\s*-\s*\S/i);
      // TAG-1 S233: guard against ISO country code collision (DE=Delaware/Deutschland)
      if (stCityM && ST_CITY_US_CODES.has(stCityM[1].toLowerCase()) && !hasNonUS) {
        tags.push('us');
      }
    }

    // If location exists but doesn't match US or non-US list, don't assume US
  }

  // Check for remote (deduplicate — workplace_type may have already added it)
  if (!tags.includes('remote')) {
    if (job.is_remote === true) {
      tags.push('remote');
    } else if (locationStr.includes('remote') && !hasNonUS) {
      tags.push('remote');
    }
  }

  // Check for hybrid (deduplicate)
  if (!tags.includes('hybrid') && locationStr.includes('hybrid')) {
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
 * NOTE: No downstream consumer currently reads tags.special for routing or filtering.
 * These tags are informational only — used for potential future features (search filters, badges).
 * Lists are representative, not comprehensive.
 */
function tagSpecial(job) {
  const tags = [];
  const companyName = (job.company_name || '').toLowerCase();

  // FAANG+ (Big Tech companies with high applicant interest)
  const faangCompanies = [
    'meta', 'amazon', 'apple', 'netflix', 'google',
    'alphabet', 'microsoft', 'nvidia'
  ];
  if (faangCompanies.some(company => companyName.includes(company))) {
    tags.push('faang');
  }

  // Unicorn startups (private companies valued >$1B, high applicant interest)
  const unicornCompanies = [
    'stripe', 'plaid', 'databricks', 'snowflake', 'airbnb',
    'robinhood', 'doordash', 'instacart', 'coinbase',
    'chime', 'rippling', 'epic games',
  ];
  if (unicornCompanies.some(company => companyName.includes(company))) {
    tags.push('unicorn');
  }

  // Fortune 500 (representative subset — not comprehensive)
  const fortune500Companies = [
    'walmart', 'amazon', 'apple', 'cvs health', 'unitedhealth',
    'mckesson', 'cardinal health', 'exxon', 'at&t', 'costco'
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
