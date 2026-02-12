/**
 * Pipeline Instrumentation Module
 *
 * Provides lightweight tracing for debugging data pipeline issues.
 * Only activates when DEBUG_MODE=true (zero overhead when disabled).
 *
 * Usage:
 *   const { PipelineTracer } = require('./instrumentation');
 *   const tracer = new PipelineTracer(process.env.DEBUG_MODE === 'true');
 *
 *   tracer.checkpoint('fetch_all_jobs', allJobs);
 *   tracer.checkpoint('after_filter', filteredJobs, { filtered_out: 100 });
 *   tracer.save();
 *
 * Output: .github/data/debug-trace.json
 *
 * Created: 2026-02-11
 */

const fs = require('fs');
const path = require('path');

class PipelineTracer {
    static instance = null;

    /**
     * Create or return singleton PipelineTracer instance
     * @param {boolean} enabled - Whether to enable tracing (default: false)
     */
    constructor(enabled = false) {
        // True singleton - always return existing instance if it exists
        if (PipelineTracer.instance) {
            return PipelineTracer.instance;
        }

        // First initialization only
        this.enabled = enabled;
        this.startTime = Date.now();

        if (enabled) {
            // Only allocate memory if enabled
            this.trace = {
                correlation_id: process.env.GITHUB_RUN_ID || 'local-' + Date.now(),
                run_url: process.env.GITHUB_RUN_ID
                    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
                    : 'local-run',
                started_at: new Date().toISOString(),
                workflow: process.env.GITHUB_WORKFLOW || 'unknown',
                repository: process.env.GITHUB_REPOSITORY || 'unknown',
                trigger: process.env.GITHUB_EVENT_NAME || 'unknown',
                branch: process.env.GITHUB_REF_NAME || 'unknown',
                checkpoints: []
            };

            console.log('\n🔍 Pipeline tracing ENABLED');
            console.log(`📊 Correlation ID: ${this.trace.correlation_id}`);
            console.log(`🔗 Run URL: ${this.trace.run_url}\n`);
        } else {
            // Null if disabled - zero memory footprint
            this.trace = null;
        }

        PipelineTracer.instance = this;
    }

    /**
     * Record a checkpoint in the pipeline
     * @param {string} stage - Stage name (e.g., 'fetch_all_jobs')
     * @param {Array} data - Array of job objects
     * @param {Object} metadata - Optional metadata about this stage
     */
    checkpoint(stage, data, metadata = {}) {
        // Zero-cost early return if disabled
        if (!this.enabled) return;

        // Validate input
        if (!Array.isArray(data)) {
            console.warn(`[TRACER WARNING] checkpoint('${stage}'): data is not an array`);
            data = [];
        }

        const counts = {
            total: data.length,
            by_source: this.groupBySource(data)
        };

        const checkpoint = {
            stage,
            timestamp: new Date().toISOString(),
            duration_ms: Date.now() - this.startTime,
            counts,
            metadata,
            sample_ids: data.slice(0, 3).map(j => j.id || j.job_id || 'no-id')
        };

        this.trace.checkpoints.push(checkpoint);

        // Also log to console for real-time visibility (structured format)
        console.log(`[PIPELINE] ${stage}`, JSON.stringify({
            total: counts.total,
            sources: Object.keys(counts.by_source).map(s => `${s}:${counts.by_source[s]}`).join(', '),
            duration: `${(checkpoint.duration_ms / 1000).toFixed(1)}s`
        }));
    }

    /**
     * Group job array by source field
     * @param {Array} data - Array of job objects
     * @returns {Object} - { source: count, ... }
     */
    groupBySource(data) {
        const grouped = {};

        data.forEach(job => {
            // Check multiple possible field names for source
            const source = job.source || job.job_source || job._source || 'unknown';
            grouped[source] = (grouped[source] || 0) + 1;
        });

        return grouped;
    }

    /**
     * Save trace to file and display summary
     */
    save() {
        if (!this.enabled) return;

        // Finalize trace
        this.trace.completed_at = new Date().toISOString();
        this.trace.total_duration_ms = Date.now() - this.startTime;

        // Ensure output directory exists
        const outputDir = path.join(process.cwd(), '.github/data');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const outputPath = path.join(outputDir, 'debug-trace.json');

        try {
            fs.writeFileSync(outputPath, JSON.stringify(this.trace, null, 2));

            console.log('\n' + '='.repeat(80));
            console.log('✅ Pipeline trace saved successfully');
            console.log('='.repeat(80));
            console.log(`📄 File: ${outputPath}`);
            console.log(`📏 Size: ${(JSON.stringify(this.trace).length / 1024).toFixed(2)} KB`);
            console.log(`⏱️  Total duration: ${(this.trace.total_duration_ms / 1000).toFixed(1)}s`);
            console.log(`🔗 Checkpoints: ${this.trace.checkpoints.length}`);
            console.log('='.repeat(80) + '\n');

            // Display quick summary
            this.displayQuickSummary();

        } catch (error) {
            console.error(`❌ Failed to save trace: ${error.message}`);
        }
    }

    /**
     * Display quick summary of trace for immediate visibility
     */
    displayQuickSummary() {
        if (!this.enabled || this.trace.checkpoints.length === 0) return;

        console.log('📊 Quick Summary:\n');

        this.trace.checkpoints.forEach((checkpoint, i) => {
            const arrow = i < this.trace.checkpoints.length - 1 ? '  ↓' : '';
            const sources = Object.entries(checkpoint.counts.by_source)
                .map(([s, c]) => `${s}:${c}`)
                .join(', ');

            console.log(`${checkpoint.stage}:`);
            console.log(`  Total: ${checkpoint.counts.total} jobs (${sources})`);

            // Detect drops
            if (i > 0) {
                const prev = this.trace.checkpoints[i-1];
                const dropped = prev.counts.total - checkpoint.counts.total;
                if (dropped > 0) {
                    const dropPercent = ((dropped / prev.counts.total) * 100).toFixed(1);
                    console.log(`  ⚠️  Dropped ${dropped} jobs (-${dropPercent}%)`);
                }
            }

            console.log(arrow);
        });

        console.log('\n💡 Run analyzer for detailed anomaly detection:');
        console.log('   node scripts/analyze-debug-trace.js .github/data/debug-trace.json\n');
    }

    /**
     * Get current trace data (for testing/inspection)
     * @returns {Object|null} - Trace object or null if disabled
     */
    getTrace() {
        return this.trace;
    }

    /**
     * Check if tracing is enabled
     * @returns {boolean}
     */
    isEnabled() {
        return this.enabled;
    }

    /**
     * Reset singleton instance (for testing)
     */
    static reset() {
        PipelineTracer.instance = null;
    }
}

module.exports = { PipelineTracer };
