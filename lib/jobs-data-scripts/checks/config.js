/**
 * Pipeline Alert Configuration
 *
 * All thresholds and constants centralized here.
 * Checks import from this file — no hardcoded thresholds in check logic.
 */

const CONSUMER_REPOS = [
  'New-Grad-Jobs-2026',
  'Internships-2026',
  'New-Grad-Software-Engineering-Jobs-2026',
  'New-Grad-Data-Science-Jobs-2026',
  'New-Grad-Hardware-Engineering-Jobs-2026',
  'New-Grad-Healthcare-Jobs-2026',
];

const P2_REPOS = [
  'zapplyjobs/jobs-aggregator-private',
  'zapplyjobs/jobs-data-2026',
  'zapplyjobs/New-Grad-Jobs-2026',
  'zapplyjobs/Internships-2026',
  'zapplyjobs/New-Grad-Software-Engineering-Jobs-2026',
  'zapplyjobs/New-Grad-Data-Science-Jobs-2026',
  'zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2026',
  'zapplyjobs/New-Grad-Healthcare-Jobs-2026',
];

const CUSTOM_FETCHERS = ['apple', 'twosigma', 'amazon', 'netflix', 'google', 'uber', 'simplify', 'microsoft', 'oracle', 'amd'];
const KEY_DOMAINS = ['software', 'data_science', 'hardware', 'healthcare', 'ai'];
const TECH_DOMAINS = ['software', 'data_science', 'hardware', 'ai'];
const STRUCTURALLY_LOW_SKILLS = new Set(['simplify', 'apple', 'google', 'jsearch']);

module.exports = {
  CONSUMER_REPOS,
  P2_REPOS,
  CUSTOM_FETCHERS,
  KEY_DOMAINS,
  TECH_DOMAINS,
  STRUCTURALLY_LOW_SKILLS,

  thresholds: {
    staleRunMinutes: 30,
    jobDropPct: 0.60,           // Check 4: alert if pool < 60% of previous
    sourceDropPct: 0.40,        // Check 5: alert if source < 40% of previous
    healthcarePct: 0.30,        // Check 6: healthcare composition drift
    seniorFilterPct: 0.05,      // Check 10: senior filter bypass
    g1GeneralPct: 30,           // Check 11: G1 general rate (%)
    g1FallbackPct: 0.55,        // Check 11: legacy fallback
    enrichCoveragePct: 0.70,    // Check 12: enrichment fill rate
    enrichT3MinPct: 0.70,       // Check 15: T3 floor
    enrichT0MaxPct: 0.15,       // Check 15: T0 ceiling
    enrichSkillsMinPct: 0.50,   // Check 15: per-source skills floor
    runtimeExecutionMin: 20,    // Check 13: execution-only threshold
    runtimeWallMin: 30,         // Check 13: wall-time fallback threshold
    consumerStaleHours: 2,      // Check 18: consumer behind shared
    zeroYieldStreak: 3,         // Check 19: consecutive zero-yield runs
    patDaysLeft: 7,             // PAT expiry alert threshold
    bumpFailureWindowMin: 60,   // Check 17: only alert recent failures
    dedupeStoreMbWarning: 10,   // Check 21: warning at 10 MB
    dedupeStoreMbCatastrophic: 20, // Check 21: alert at 20 MB
  },

  // Warning tier — written to pipeline-alert.json (dashboard-visible), no Discord alert.
  // Fires at 2x current typical values. Catastrophic tier = thresholds above.
  warnings: {
    jobDropPct: 0.80,           // 20% drop (catastrophic: 40%)
    sourceDropPct: 0.70,        // 30% drop (catastrophic: 60%)
    healthcarePct: 0.20,        // 20% (catastrophic: 30%)
    seniorFilterPct: 0.03,      // 3% (catastrophic: 5%)
    g1GeneralPct: 25,           // 25% (catastrophic: 30%)
    enrichCoveragePct: 0.80,    // 80% (catastrophic: 70%)
    enrichT3MinPct: 0.80,       // 80% (catastrophic: 70%)
    runtimeExecutionMin: 12,    // 12 min (catastrophic: 20 min)
    runtimeWallMin: 20,         // 20 min (catastrophic: 30 min)
    consumerStaleHours: 1,      // 1 hour (catastrophic: 2 hours)
  },
};
