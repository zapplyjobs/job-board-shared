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
function tagDomains(job) {
  const title = (job.title || '').toLowerCase();
  const description = (job.description || '').toLowerCase();
  const tags = [];

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
  ];
  const isSalesRole = /\b(sales|account executive|pre-sales|presales)\b/i.test(title);
  // Guard: retail "Back End Clerk" is not a backend engineer (Lowe's — 6 FPs, S229)
  const isRetailClerk = /\b(clerk|stocker|cashier)\b/i.test(title);
  // TAG-MISROUTE-1 Issue 3a (S229): short keywords need word-boundary regex — includes() causes
  // "answer" → "anSWEr", "disrespect" → "diSREspect" false positives (509 + 151 FPs)
  const softwareShortKeywords = /\b(swe|sre)\b/i;
  const matchesSoftware = (text) =>
    softwareKeywords.some(kw => text.includes(kw)) || softwareShortKeywords.test(text);
  // TAG-MISROUTE-1 Issue 3b (S229): software domain is now TITLE-ONLY.
  // Description fallback removed — company boilerplate ("full stack technology platform",
  // "alongside our software engineers") caused 1,774 non-tech jobs to be tagged software.
  // Same approach as AI domain (title-only since inception). Keyword list expanded above
  // to compensate for legitimate roles lost.
  if (!isSalesRole && !isRetailClerk && matchesSoftware(title)) {
    tags.push('software');
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
  ];
  const aiShortKeywords = /\b(llm|nlp)\b/i;
  if (aiKeywords.some(kw => title.includes(kw)) || aiShortKeywords.test(job.title || '')) {
    tags.push('ai');
  }

  // Data Science domain (title-first, description fallback — specific keywords only)
  const dataScienceKeywords = [
    'data scientist', 'data science', 'data engineer', 'data analyst',
    'machine learning', 'ml engineer', 'ai engineer',
    // INTERN-1a Wave 2:
    'data analytics', 'applied science', 'operations research',
    'algorithm engineering', 'decision science', 'quantitative research',
    'research analyst',
    // FRESHNESS-3: GH general-tagged misclassification fixes (S179 Auditor data audit)
    'research scientist',           // Anthropic, DeepMind — data_science domain (3 confirmed misses)
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
  ];
  if (hardwareKeywords.some(kw => title.includes(kw))) {
    tags.push('hardware');
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
    tags.push('healthcare');
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
  ];
  if (financeKeywords.some(kw => title.includes(kw))) {
    tags.push('finance');
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
  ];
  const isSalesEngineer = /\b(sales engineer|solutions engineer|pre-sales engineer)\b/i.test(title);
  if (!isSalesEngineer && salesKeywords.some(kw => {
    const re = new RegExp(kw, 'i');
    return re.test(title);
  })) {
    tags.push('sales');
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
    tags.push('marketing');
  }

  // Operations domain (title-only — narrow terms only, avoid broad 'analyst' standalone)
  const operationsKeywords = [
    'operations analyst', 'operations associate', 'operations coordinator',
    'supply chain analyst', 'logistics analyst', 'program analyst',
    'project analyst', 'business operations', 'strategy analyst',
    'strategy associate', 'operations specialist',
  ];
  if (operationsKeywords.some(kw => title.includes(kw))) {
    tags.push('operations');
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
  ];
  const isComplianceEngineer = /\b(compliance engineer|compliance engineering)\b/i.test(title);
  if (!isComplianceEngineer && legalKeywords.some(kw => title.includes(kw))) {
    tags.push('legal');
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
  ];
  if (hrKeywords.some(kw => title.includes(kw))) {
    tags.push('hr');
  }

  // Product domain
  const productKeywords = [
    'product manager', 'product designer', 'ux designer',
    'ui designer', 'user experience', 'product owner', 'product marketing',
    // INTERN-1a Wave 2:
    'ux design', 'ux research', 'ux researcher', 'ui/ux',
    'industrial design', 'content design', 'experience design',
    'web experience design', 'product analytics', 'technical ux', 'game design',
  ];
  if (productKeywords.some(kw => title.includes(kw))) {
    tags.push('product');
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
  ];
  const isRetailBanking = /\b(banker|banking|loan originator|mortgage|lender)\b/i.test(title);
  if (!isRetailBanking && retailKeywords.some(kw => title.includes(kw))) {
    tags.push('retail');
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
  ];
  if (manufacturingKeywords.some(kw => title.includes(kw))) {
    tags.push('manufacturing');
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
  ];
  if (logisticsKeywords.some(kw => title.includes(kw))) {
    tags.push('logistics');
  }

  // Default to general if no matches
  if (tags.length === 0) {
    tags.push('general');
  }

  return tags;
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

    // Layer 2b: US-only health systems — post with facility names as location strings.
    // No bare-string restriction. NON_US blocklist ran first (isExplicitlyNonUS check above).
    // Only slugs with ZERO confirmed non-US offices — see US_HQ_ONLY_SLUGS definition.
    if (!tags.includes('us') && !isExplicitlyNonUS && US_HQ_ONLY_SLUGS.has(job.company_slug)) {
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
      if (stCityM && ST_CITY_US_CODES.has(stCityM[1].toLowerCase())) {
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
