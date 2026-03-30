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
  const deptRaw = (job.team || job.department || (job.departments && job.departments[0]) || '').toLowerCase();
  if (deptRaw) {
    const DEPT_RULES = [
      [/\b(software|platform eng|web eng|mobile eng|data eng|backend|frontend|devops|sre|infra eng|security eng|it eng|product engineering|it)\b/i, 'software'],
      [/\b(machine learning|artificial intelligence|ai |data science|ml eng)\b/i, 'ai'],
      [/\b(data anal|business intel|analytics)\b/i, 'data_science'],
      [/\b(hardware|electrical|mechanical|embedded|firmware|test eng|systems eng|manufacturing eng|materials eng|materials engineering)\b/i, 'hardware'],
      [/\b(sales|business develop|account exec|revenue)\b/i, 'sales'],
      [/\b(marketing|brand|content|growth|creative|communications)\b/i, 'marketing'],
      [/\b(finance|accounting|treasury|tax |fp&a|financial|actuarial)\b/i, 'finance'],
      [/\b(legal|compliance|regulatory|counsel)\b/i, 'legal'],
      [/\b(human resource|people|talent|recruiting|hr )\b/i, 'hr'],
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
  ];
  // Guard: 'service technician' — exclude 'customer service technician' (not hardware)
  const matchesHardware = hardwareKeywords.some(kw => title.includes(kw));
  if (matchesHardware) {
    // Only block if the sole match is 'service technician' AND title contains 'customer service'
    const isOnlyServiceTech = title.includes('service technician') &&
      !hardwareKeywords.some(kw => kw !== 'service technician' && title.includes(kw));
    const isCustomerServiceTech = /\bcustomer service\b/i.test(title);
    if (!(isOnlyServiceTech && isCustomerServiceTech)) {
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
  ];
  // \bnurse\b catches bare 'nurse' titles (charge nurse, nurse educator, etc.)
  // without matching 'nursery'. Short credentials use word-boundary to avoid false positives.
  // AEMT (Advanced EMT) added as word-boundary credential.
  const healthcareCredentials = /\b(nurse|rn|lpn|cna|crna|np|aemt|emt)\b/i;
  // 'social worker' only in hospital context — title-match is sufficient since hospital Workday tenants
  // won't title non-clinical social work roles as 'social worker' without qualification
  const healthcareOther = ['social worker', 'medical social worker', 'clinical social worker'];
  if (
    healthcareExact.some(kw => title.includes(kw)) ||
    healthcareCredentials.test(title) ||
    healthcareOther.some(kw => title.includes(kw))
  ) {
    const hcMatch = findMatch(healthcareExact, title) || (healthcareCredentials.test(title) ? 'credential regex' : null) || findMatch(healthcareOther, title);
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
  ];
  const isSalesEngineer = /\b(sales engineer|solutions engineer|pre-sales engineer)\b/i.test(title);
  if (!isSalesEngineer && salesKeywords.some(kw => {
    const re = new RegExp(kw, 'i');
    return re.test(title);
  })) {
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
  ];
  if (marketingKeywords.some(kw => title.includes(kw))) {
    pushTag('marketing', findMatch(marketingKeywords, title), 'title');
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
  ];
  const isComplianceEngineer = /\b(compliance engineer|compliance engineering)\b/i.test(title);
  if (!isComplianceEngineer && legalKeywords.some(kw => title.includes(kw))) {
    pushTag('legal', findMatch(legalKeywords, title), 'title');
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
  ];
  if (logisticsKeywords.some(kw => title.includes(kw))) {
    pushTag('logistics', findMatch(logisticsKeywords, title), 'title');
  }

  // TAG-7: Description fallback for general-tagged jobs.
  // WD/SR descriptions injected by aggregator Step 4c (from enrichment sidecar).
  // GH/Lever/Ashby have inline descriptions from their API responses.
  // Only fires when: (1) no title keyword/O*NET match, (2) description non-empty,
  // (3) 2+ domain-specific phrases found (prevents boilerplate FPs).
  // Phrase lists derived from analysis of 20 WD general job descriptions (TAG7_DESCRIPTION_ANALYSIS_S233.md).
  if (tags.length === 0 && description.length > 100) {
    const cleanDesc = description.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').toLowerCase();

    const descDomains = [
      { domain: 'hardware', phrases: ['thermal design', 'circuit design', 'fpga', 'pcb', 'simulation', 'commissioning', 'equipment calibration', 'test systems', 'embedded system', 'signal integrity', 'power supply', 'schematic'] },
      { domain: 'software', phrases: ['source code', 'code review', 'ci/cd', 'api design', 'microservice', 'database design', 'incident response', 'deployment pipeline', 'version control', 'agile development', 'sprint planning', 'unit test'] },
      { domain: 'data_science', phrases: ['machine learning', 'statistical model', 'data pipeline', 'feature engineering', 'model training', 'a/b test', 'data warehouse', 'etl process', 'predictive model'] },
      { domain: 'finance', phrases: ['financial statements', 'treasury', 'risk management', 'fund administration', 'audit', 'gaap', 'ifrs', 'portfolio management', 'credit risk', 'financial reporting'] },
      { domain: 'healthcare', phrases: ['patient care', 'clinical trial', 'hipaa', 'therapeutic area', 'medical device', 'pharma', 'drug safety', 'clinical research', 'fda', 'healthcare provider'] },
      { domain: 'manufacturing', phrases: ['production floor', 'assembly line', 'quality control', 'manufacturing process', 'cnc', 'lean manufacturing', 'production schedule', 'machine operation', 'material handling'] },
      { domain: 'operations', phrases: ['project management', 'inventory management', 'operational efficiency', 'process improvement', 'vendor management', 'supply chain', 'fulfillment', 'service level'] },
      { domain: 'sales', phrases: ['sales quota', 'territory management', 'customer acquisition', 'sales pipeline', 'business development', 'account management', 'revenue target', 'product demonstration'] },
      { domain: 'hr', phrases: ['employee relations', 'talent management', 'onboarding', 'performance review', 'compensation and benefits', 'workforce planning', 'staffing', 'learning and development'] },
      { domain: 'legal', phrases: ['legal counsel', 'litigation', 'regulatory compliance', 'contract negotiation', 'intellectual property', 'corporate governance', 'bar admission'] },
      { domain: 'marketing', phrases: ['brand strategy', 'content marketing', 'digital marketing', 'market research', 'campaign management', 'social media strategy', 'seo', 'marketing analytics'] },
    ];

    for (const { domain, phrases } of descDomains) {
      const matches = phrases.filter(p => cleanDesc.includes(p));
      if (matches.length >= 2) {
        pushTag(domain, '(desc: ' + matches.slice(0, 2).join(' + ') + ')', 'description-fallback');
        break;
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
