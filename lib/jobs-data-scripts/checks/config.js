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
    jobDropPct: 0.60,
    sourceDropPct: 0.40,
    healthcarePct: 0.30,
    seniorFilterPct: 0.05,
    g1GeneralPct: 30,
    g1FallbackPct: 0.55,
    enrichCoveragePct: 0.70,
    enrichT3MinPct: 0.70,
    enrichT0MaxPct: 0.15,
    enrichSkillsMinPct: 0.50,
    runtimeExecutionMin: 20,
    runtimeWallMin: 30,
    consumerStaleHours: 2,
    zeroYieldStreak: 3,
    patDaysLeft: 7,
    bumpFailureWindowMin: 60,
    dedupeStoreMbWarning: 10,
    dedupeStoreMbCatastrophic: 20,
    r2StaleMinutes: 60,
  },

  warnings: {
    jobDropPct: 0.80,
    sourceDropPct: 0.70,
    healthcarePct: 0.20,
    seniorFilterPct: 0.03,
    g1GeneralPct: 25,
    enrichCoveragePct: 0.80,
    enrichT3MinPct: 0.80,
    runtimeExecutionMin: 12,
    runtimeWallMin: 20,
    consumerStaleHours: 1,
    r2StaleMinutes: 30,
  },
};
