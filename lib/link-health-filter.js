const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const TIMEOUT_MS = 12000;
const RETRY_COUNT = 1;
const DEFAULT_CONCURRENCY = 20;

const DEAD_KEYWORDS = [
  'page not found',
  'page you requested was not found',
  'this job is no longer available',
  'this job is no longer accepting applications',
  'this position has been filled',
  'this position is no longer available',
  'this posting has been closed',
  'this posting is no longer accepting applications',
  'job not found',
  'job has been removed',
  'no longer open',
  'expired',
  'the job you are looking for is no longer open',
  'this role has been closed',
  'this opportunity is no longer available',
  'job posting has expired',
  'this requisition is no longer active',
  'we couldn\'t find the page',
  'sorry, we couldn\'t find that page',
  'this job has expired',
  'position closed',
  'this job has been closed',
  'the page you\'re looking for doesn\'t exist',
];

function getPaths(baseDir) {
  const internalDir = path.join(baseDir, '.github', '.internal', 'link-health');
  return {
    internalDir,
    blockedFile: path.join(internalDir, 'blocked_urls.json'),
    pendingFile: path.join(internalDir, 'pending_dead_urls.json'),
    reportFile: path.join(internalDir, 'link_check_report.json'),
  };
}

function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes('greenhouse.io')) return 'greenhouse';
    if (hostname.includes('ashbyhq.com')) return 'ashby';
    if (hostname.includes('lever.co')) return 'lever';
    if (hostname.includes('myworkdayjobs.com') || hostname.includes('myworkdaysite.com')) return 'workday';
    if (hostname.includes('smartrecruiters.com')) return 'smartrecruiters';
    return 'other';
  } catch {
    return 'unknown';
  }
}

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function httpGet(url, options = {}) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      resolve({ status: 0, body: '', error: 'invalid_url', url });
      return;
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      timeout: options.timeout || TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/json,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {}),
      },
    }, (res) => {
      let body = '';
      let size = 0;
      const maxSize = 200 * 1024;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= maxSize) body += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body,
          url,
          redirectUrl: res.headers?.location || null,
        });
      });
    });

    req.on('error', (err) => resolve({ status: 0, body: '', error: err.message, url }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', error: 'timeout', url });
    });
  });
}

async function checkGreenhouse(url) {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    let company;
    let jobId;
    const jobsIdx = pathParts.indexOf('jobs');
    if (jobsIdx >= 1) {
      company = pathParts[jobsIdx - 1];
      jobId = pathParts[jobsIdx + 1];
    }
    if (!jobId) jobId = parsed.searchParams.get('gh_jid');
    if (!company || !jobId) return checkGeneric(url);

    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${jobId}`;
    const res = await httpGet(apiUrl);
    if (res.status === 404) return { dead: true, reason: 'Greenhouse API 404' };
    if (res.status === 200) return { dead: false, reason: 'Greenhouse API OK' };
    if (res.error) return { dead: null, reason: `Greenhouse API error: ${res.error}` };
    return checkGeneric(url);
  } catch {
    return checkGeneric(url);
  }
}

const ashbyBoardCache = new Map();
function fetchAshbyBoard(company) {
  if (ashbyBoardCache.has(company)) return Promise.resolve(ashbyBoardCache.get(company));
  return new Promise((resolve) => {
    https.get(`https://api.ashbyhq.com/posting-api/job-board/${company}`, {
      headers: { 'Accept': 'application/json' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const jobs = Array.isArray(data?.jobs) ? data.jobs : (Array.isArray(data) ? data : []);
          const ids = new Set();
          for (const job of jobs) if (job?.id) ids.add(String(job.id));
          ashbyBoardCache.set(company, ids);
          resolve(ids);
        } catch {
          ashbyBoardCache.set(company, null);
          resolve(null);
        }
      });
    }).on('error', () => {
      ashbyBoardCache.set(company, null);
      resolve(null);
    });
  });
}

async function checkAshby(url) {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length < 2) return checkGeneric(url);
    const company = pathParts[0];
    const postingId = pathParts[1];
    const activeIds = await fetchAshbyBoard(company);
    if (activeIds !== null) {
      if (activeIds.has(postingId)) return { dead: false, reason: 'Ashby board: posting active' };
      return { dead: true, reason: 'Ashby board: posting not in active list' };
    }
    return checkGeneric(url);
  } catch {
    return checkGeneric(url);
  }
}

async function checkLever(url) {
  const res = await httpGet(url);
  if (res.status === 404 || res.status === 410) return { dead: true, reason: `Lever HTTP ${res.status}` };
  if (res.status >= 500) return { dead: null, reason: `Lever HTTP ${res.status}` };
  if (res.error) return { dead: null, reason: `Lever error: ${res.error}` };
  if (res.status === 200 || res.status === 301 || res.status === 302) {
    const body = res.body.toLowerCase();
    if (
      body.includes('this posting has been closed') ||
      body.includes('this posting is no longer accepting') ||
      body.includes('no longer available')
    ) {
      return { dead: true, reason: 'Lever: posting closed (content)' };
    }
    return { dead: false, reason: 'Lever reachable' };
  }
  return checkGeneric(url);
}

async function checkWorkday(url) {
  const res = await httpGet(url);
  if (res.status === 404 || res.status === 410) return { dead: true, reason: `Workday HTTP ${res.status}` };
  if (res.status >= 500) return { dead: null, reason: `Workday HTTP ${res.status}` };
  if (res.error) return { dead: null, reason: `Workday error: ${res.error}` };
  if (res.status === 301 || res.status === 302) {
    const location = (res.redirectUrl || '').toLowerCase();
    if (location.includes('error') || location.includes('not-found') || location.includes('404')) {
      return { dead: true, reason: 'Workday redirect to error' };
    }
  }
  if (res.status === 200) {
    const body = res.body.toLowerCase();
    for (const keyword of DEAD_KEYWORDS) {
      if (body.includes(keyword)) return { dead: true, reason: `Workday content match: "${keyword}"` };
    }
    return { dead: false, reason: 'Workday reachable' };
  }
  return { dead: null, reason: `Workday HTTP ${res.status}` };
}

async function checkSmartRecruiters(url) {
  const res = await httpGet(url);
  if (res.status === 404 || res.status === 410) return { dead: true, reason: `SmartRecruiters HTTP ${res.status}` };
  if (res.status === 403) return { dead: false, reason: 'SmartRecruiters blocked bot (403)' };
  if (res.status >= 500) return { dead: null, reason: `SmartRecruiters HTTP ${res.status}` };
  if (res.error) return { dead: null, reason: `SmartRecruiters error: ${res.error}` };
  if (res.status === 200) {
    const body = res.body.toLowerCase();
    for (const keyword of DEAD_KEYWORDS) {
      if (body.includes(keyword)) return { dead: true, reason: `SmartRecruiters content match: "${keyword}"` };
    }
    return { dead: false, reason: 'SmartRecruiters reachable' };
  }
  return checkGeneric(url);
}

async function checkGeneric(url) {
  const res = await httpGet(url);
  if (res.status === 404 || res.status === 410) return { dead: true, reason: `HTTP ${res.status}` };
  if (res.status === 403) return { dead: false, reason: 'HTTP 403 (likely bot blocked)' };
  if (res.status >= 500) return { dead: null, reason: `HTTP ${res.status}` };
  if (res.error) return { dead: null, reason: `Error: ${res.error}` };
  if (res.status === 301 || res.status === 302) {
    const location = res.redirectUrl || '';
    const low = location.toLowerCase();
    if (low.includes('error') || low.includes('not-found') || low.includes('404')) {
      return { dead: true, reason: 'Redirect to error page' };
    }
    if (location) {
      const followUrl = location.startsWith('http') ? location : new URL(location, url).href;
      const res2 = await httpGet(followUrl);
      if (res2.status === 404 || res2.status === 410) return { dead: true, reason: `Redirect -> HTTP ${res2.status}` };
      if (res2.status === 403) return { dead: false, reason: 'Redirect -> HTTP 403 (bot blocked)' };
      if (res2.status === 200) {
        const body = res2.body.toLowerCase();
        for (const keyword of DEAD_KEYWORDS) {
          if (body.includes(keyword)) return { dead: true, reason: `Redirect content match: "${keyword}"` };
        }
        return { dead: false, reason: 'Redirect target reachable' };
      }
    }
    return { dead: false, reason: `HTTP ${res.status} redirect` };
  }
  if (res.status === 200) {
    const body = res.body.toLowerCase();
    const title = (body.match(/<title[^>]*>(.*?)<\/title>/i) || ['', ''])[1].toLowerCase();
    if (
      title.includes('not found') ||
      title === '404' ||
      (title.includes('error') && !title.includes('engineer') && !title.includes('engineering'))
    ) {
      return { dead: true, reason: `Page title indicates error: "${title.slice(0, 60)}"` };
    }
    for (const keyword of DEAD_KEYWORDS) {
      if (body.includes(keyword)) return { dead: true, reason: `Content match: "${keyword}"` };
    }
    return { dead: false, reason: 'HTTP 200 OK' };
  }
  return { dead: null, reason: `HTTP ${res.status}` };
}

async function checkUrl(url, retries = RETRY_COUNT) {
  const platform = detectPlatform(url);
  let result;
  switch (platform) {
    case 'greenhouse':
      result = await checkGreenhouse(url);
      break;
    case 'ashby':
      result = await checkAshby(url);
      break;
    case 'lever':
      result = await checkLever(url);
      break;
    case 'workday':
      result = await checkWorkday(url);
      break;
    case 'smartrecruiters':
      result = await checkSmartRecruiters(url);
      break;
    default:
      result = await checkGeneric(url);
      break;
  }
  if (result.dead === null && retries > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return checkUrl(url, retries - 1);
  }
  return { ...result, url, platform };
}

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (true) {
      const i = index++;
      if (i >= tasks.length) break;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function computeLinkHealthState(results, previousBlocked, previousPending, currentUrls) {
  const alive = new Set();
  const dead = new Set();
  const uncertain = new Set();
  for (const result of results) {
    if (result.dead === true) dead.add(result.url);
    else if (result.dead === false) alive.add(result.url);
    else uncertain.add(result.url);
  }
  const nextBlocked = new Set([...previousBlocked].filter((url) => currentUrls.has(url)));
  const nextPending = new Set();
  for (const url of alive) nextBlocked.delete(url);
  for (const url of dead) {
    if (previousPending.has(url) || nextBlocked.has(url)) {
      nextBlocked.add(url);
      nextPending.delete(url);
    } else {
      nextPending.add(url);
    }
  }
  for (const url of uncertain) if (previousPending.has(url)) nextPending.add(url);
  return { alive, dead, uncertain, nextBlocked, nextPending };
}

async function filterJobsByLinkHealth(jobs, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const concurrency = Number(options.concurrency || DEFAULT_CONCURRENCY);
  const { internalDir, blockedFile, pendingFile, reportFile } = getPaths(baseDir);

  const urlMap = new Map();
  for (const job of jobs) {
    if (!job || typeof job.job_apply_link !== 'string') continue;
    if (!urlMap.has(job.job_apply_link)) urlMap.set(job.job_apply_link, job);
  }

  const uniqueUrls = Array.from(urlMap.keys());
  if (uniqueUrls.length === 0) {
    return {
      jobs,
      summary: {
        total_jobs_in: jobs.length,
        total_jobs_out: jobs.length,
        unique_urls_checked: 0,
        alive: 0,
        dead: 0,
        uncertain: 0,
        blocked_total: 0,
        blocked_newly_confirmed: 0,
        pending_first_strike: 0,
        removed_this_run: 0,
        internal_dir: path.relative(baseDir, internalDir),
      },
    };
  }

  const tasks = uniqueUrls.map((url) => () => checkUrl(url));
  const results = await runPool(tasks, concurrency);

  const previousBlocked = new Set(readJsonArray(blockedFile));
  const previousPending = new Set(readJsonArray(pendingFile));
  const currentUrls = new Set(uniqueUrls);

  const { alive, dead, uncertain, nextBlocked, nextPending } = computeLinkHealthState(
    results,
    previousBlocked,
    previousPending,
    currentUrls
  );

  const filteredJobs = jobs.filter((job) => !nextBlocked.has(job.job_apply_link));
  const newlyConfirmedBlocked = [...nextBlocked].filter((url) => !previousBlocked.has(url)).length;

  const reportPayload = {
    timestamp: new Date().toISOString(),
    summary: {
      total_jobs_in: jobs.length,
      total_jobs_out: filteredJobs.length,
      unique_urls_checked: uniqueUrls.length,
      alive: alive.size,
      dead: dead.size,
      uncertain: uncertain.size,
      blocked_total: nextBlocked.size,
      blocked_newly_confirmed: newlyConfirmedBlocked,
      pending_first_strike: nextPending.size,
      removed_this_run: jobs.length - filteredJobs.length,
    },
    blocked_urls: [...nextBlocked].sort(),
    pending_dead_urls: [...nextPending].sort(),
    dead_checks: results.filter((r) => r.dead === true),
    uncertain_checks: results.filter((r) => r.dead === null),
  };

  writeJson(blockedFile, reportPayload.blocked_urls);
  writeJson(pendingFile, reportPayload.pending_dead_urls);
  writeJson(reportFile, reportPayload);

  return {
    jobs: filteredJobs,
    summary: {
      ...reportPayload.summary,
      internal_dir: path.relative(baseDir, internalDir),
    },
  };
}

module.exports = {
  filterJobsByLinkHealth,
  detectPlatform,
};

