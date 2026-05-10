/**
 * Check 23: Per-source description coverage
 *
 * Verifies sidecar files exist and are non-empty for each source that has
 * jobs in the pool. Catches silent description loss (Google dropped from
 * ~100% to 72% sidecar coverage over weeks with zero alerts).
 *
 * AGG-SELF-4 (Check A) — Origin: A46 design doc.
 */
const fs = require('fs');
const path = require('path');

// Sources that have inline descriptions (no sidecar files expected)
const INLINE_SOURCES = new Set(['greenhouse', 'lever', 'ashby', 'amazon', 'netflix']);

module.exports = {
  id: 23,
  name: 'description coverage',
  check(ctx) {
    if (!ctx.metadata || !ctx.dataDir) return null;

    const bySource = ctx.metadata.by_source || {};
    const alerts = [];

    for (const [source, count] of Object.entries(bySource)) {
      if (INLINE_SOURCES.has(source)) continue;
      if (count < 10) continue; // Skip tiny sources

      const sidecarPath = path.join(ctx.dataDir, `descriptions-${source}.jsonl`);
      if (!fs.existsSync(sidecarPath)) {
        alerts.push(`**Missing sidecar**: descriptions-${source}.jsonl (${count} pool jobs, no sidecar)`);
        continue;
      }

      try {
        const content = fs.readFileSync(sidecarPath, 'utf8').trim();
        const lineCount = content ? content.split('\n').filter(Boolean).length : 0;
        const ratio = lineCount / count;
        if (ratio < 0.20) {
          alerts.push(`**Low description coverage**: ${source} has ${lineCount} sidecar entries for ${count} pool jobs (${(ratio * 100).toFixed(1)}%)`);
        }
      } catch {
        alerts.push(`**Unreadable sidecar**: descriptions-${source}.jsonl`);
      }
    }

    return alerts.length > 0 ? alerts.join('\n') : null;
  },
};
