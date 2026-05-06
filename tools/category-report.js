#!/usr/bin/env node

/**
 * Category Distribution Report — Finding #9 (D21)
 *
 * Simulates readme-generator's category matching against live all_jobs.json
 * for one or all consumer repos. Outputs per-repo category distribution with
 * "Other"/default percentages and sample titles for each category.
 *
 * Usage:
 *   node tools/category-report.js [repo-name] [path-to-all-jobs.json]
 *   node tools/category-report.js                  # all repos
 *   node tools/category-report.js NGJ              # New-Grad-Jobs only
 *   node tools/category-report.js SW ./jobs.json   # custom path
 *
 * Repo aliases: NGJ, INT, SW, DS, HW, HC
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_CONFIGS = {
  NGJ:  { dir: 'New-Grad-Jobs-2026', defaultCategory: 'other' },
  INT:  { dir: 'Internships-2026', defaultCategory: 'other_internships' },
  SW:   { dir: 'New-Grad-Software-Engineering-Jobs-2026', defaultCategory: 'backend' },
  DS:   { dir: 'New-Grad-Data-Science-Jobs-2026', defaultCategory: 'data_analyst' },
  HW:   { dir: 'New-Grad-Hardware-Engineering-Jobs-2026', defaultCategory: 'hardware_engineer' },
  HC:   { dir: 'New-Grad-Nursing-Jobs-2026', defaultCategory: 'general_healthcare' },
};

const allJobsPath = process.argv.find(a => a.endsWith('.json') && fs.existsSync(a)) ||
  path.resolve(__dirname, '..', '..', '..', '..', 'jobs-data-2026', '.github', 'data', 'all_jobs.json');

const repoArg = process.argv[2] && !process.argv[2].endsWith('.json') ? process.argv[2].toUpperCase() : null;

function loadCategories(repoKey) {
  const config = REPO_CONFIGS[repoKey];
  const catPath = path.resolve(__dirname, '..', '..', config.dir, '.github', 'scripts', 'job-fetcher', 'job_categories.json');
  if (!fs.existsSync(catPath)) {
    console.log(`  ⚠️  ${catPath} not found — skipping`);
    return null;
  }
  return JSON.parse(fs.readFileSync(catPath, 'utf8'));
}

function categorize(title, categories, defaultCategory) {
  const titleText = (title || '').toLowerCase();
  for (const [key, data] of Object.entries(categories)) {
    for (const keyword of data.keywords) {
      if (keyword.startsWith('~')) {
        const word = keyword.slice(1);
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp('(?<![a-z])' + escaped + '(?![a-z])', 'i');
        if (regex.test(titleText)) return key;
      } else if (titleText.includes(keyword.toLowerCase())) {
        return key;
      }
    }
  }
  return defaultCategory;
}

function reportForRepo(repoKey, allJobs) {
  const config = REPO_CONFIGS[repoKey];
  const categories = loadCategories(repoKey);
  if (!categories) return;

  const counts = {};
  const samples = {};
  for (const key of Object.keys(categories)) {
    counts[key] = 0;
    samples[key] = [];
  }
  if (!counts[config.defaultCategory]) {
    counts[config.defaultCategory] = 0;
    samples[config.defaultCategory] = [];
  }

  for (const job of allJobs) {
    const cat = categorize(job.job_title || job.title || '', categories, config.defaultCategory);
    counts[cat] = (counts[cat] || 0) + 1;
    if (!samples[cat]) samples[cat] = [];
    if (samples[cat].length < 3) {
      samples[cat].push(job.job_title || job.title || '(untitled)');
    }
  }

  const total = allJobs.length;
  const defaultCount = counts[config.defaultCategory] || 0;
  const defaultPct = (defaultCount / total * 100).toFixed(1);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${repoKey} (${config.dir}) — ${total} jobs`);
  console.log(`${'='.repeat(60)}`);

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [key, count] of sorted) {
    if (count === 0) continue;
    const pct = (count / total * 100).toFixed(1);
    const marker = key === config.defaultCategory ? ' ← default' : '';
    const catData = categories[key];
    const label = catData ? catData.title : key;
    console.log(`  ${label}${marker}: ${count} (${pct}%)`);
    if (samples[key]) {
      for (const s of samples[key]) {
        console.log(`    • ${s.slice(0, 70)}`);
      }
    }
  }

  if (defaultPct > 40) {
    console.log(`\n  ⚠️  Default category is ${defaultPct}% — consider adding keywords or categories`);
  }
}

// Main
if (!fs.existsSync(allJobsPath)) {
  console.error(`all_jobs.json not found at: ${allJobsPath}`);
  process.exit(1);
}

// Parse JSONL (one JSON per line) — all_jobs.json is JSONL, not a JSON array
const rawLines = fs.readFileSync(allJobsPath, 'utf8').trim().split('\n');
const allJobs = rawLines.filter(l => l.trim()).map(l => JSON.parse(l));
console.log(`Loaded ${allJobs.length} jobs from ${path.basename(allJobsPath)}`);

const repos = repoArg ? [repoArg] : Object.keys(REPO_CONFIGS);
for (const key of repos) {
  if (!REPO_CONFIGS[key]) {
    console.error(`Unknown repo: ${repoArg}. Valid: ${Object.keys(REPO_CONFIGS).join(', ')}`);
    process.exit(1);
  }
  reportForRepo(key, allJobs);
}
