/**
 * Check 19: Per-company zero-yield streak tracking
 *
 * STATEFUL: Writes zero-yield-tracking.json to disk.
 * Tracks consecutive runs where a configured company returns 0 jobs.
 * Alerts at threshold (default 3) consecutive zero-yield runs.
 */
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 19,
  name: 'company zero-yield streak',
  check(ctx) {
    if (!ctx.metadata) return null;
    const trackingPath = path.join(ctx.dataDir, 'zero-yield-tracking.json');
    const threshold = ctx.config.thresholds.zeroYieldStreak;

    // Load configured company names
    const configuredCompanies = new Set();
    const companyListPath = path.join(__dirname, '..', '..', 'aggregator', 'fetchers', 'company-list.json');
    if (fs.existsSync(companyListPath)) {
      try {
        const cl = JSON.parse(fs.readFileSync(companyListPath, 'utf8'));
        for (const section of ['greenhouse', 'lever', 'ashby', 'workday', 'eightfold', 'smartrecruiters']) {
          if (cl[section]) {
            for (const entry of cl[section]) {
              if (entry.name) configuredCompanies.add(entry.name);
            }
          }
        }
      } catch { /* fall through */ }
    }
    // Custom fetcher companies
    for (const name of ['Apple', 'Google', 'Microsoft', 'Oracle', 'AMD', 'Uber', 'Two Sigma', 'Netflix', 'Amazon']) {
      configuredCompanies.add(name);
    }

    // Load previous state
    let prevState = {};
    if (fs.existsSync(trackingPath)) {
      try { prevState = JSON.parse(fs.readFileSync(trackingPath, 'utf8')); } catch { prevState = {}; }
    }

    // Build current yield map from allJobs (pre-loaded by runner)
    const companyYield = {};
    if (ctx.allJobs) {
      for (const job of ctx.allJobs) {
        const company = job.company_name;
        if (company) companyYield[company] = (companyYield[company] || 0) + 1;
      }
    }

    // Only track configured companies
    const allCompanies = new Set([...Object.keys(prevState), ...Object.keys(companyYield)]
      .filter(c => configuredCompanies.has(c)));

    const newState = {};
    const alerting = [];
    for (const company of allCompanies) {
      const yield_ = companyYield[company] || 0;
      if (yield_ > 0) {
        newState[company] = { streak: 0, last_seen: new Date().toISOString() };
      } else {
        const prev = prevState[company] || { streak: 0 };
        const newStreak = (prev.streak || 0) + 1;
        newState[company] = { streak: newStreak, last_zero: new Date().toISOString() };
        if (newStreak >= threshold) {
          alerting.push(`${company} (${newStreak} runs)`);
        }
      }
    }

    // Persist tracking state
    fs.writeFileSync(trackingPath, JSON.stringify(newState, null, 2), 'utf8');

    if (alerting.length > 0) {
      const shown = alerting.slice(0, 10);
      const suffix = alerting.length > 10 ? ` (+${alerting.length - 10} more)` : '';
      return `**Company zero-yield streak** (${threshold}+ runs): ${shown.join(', ')}${suffix} — fetcher or ATS URL may be broken`;
    }
    return null;
  },
};
