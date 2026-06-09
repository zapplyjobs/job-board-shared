#!/usr/bin/env node
// r2-loader.js — Shared R2 data loader for local analysis tools
//
// When R2_ACCESS_KEY_ID is set in env, uses S3 client to read live data.
// Public R2 and raw GitHub fallbacks are intentionally disabled.
//
// Usage:
//   const { loadJsonFromR2 } = require('./r2-loader');
//   const data = await loadJsonFromR2('enriched_jobs.json', { prefix: 'data/' });
//
// Environment variables (set by setup-r2-local.sh):
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET_NAME

'use strict';

const https = require('https');
const zlib = require('zlib');

function hasS3Credentials() {
  return !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME);
}

async function loadViaS3(key) {
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    maxAttempts: 2,
  });
  const resp = await client.send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  }));
  const body = await resp.Body.transformToString();
  return body;
}

function fetchText(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'ZJP-Tools/1.0' },
      timeout: 120000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve);
      }
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve({ ok: res.statusCode === 200, text: Buffer.concat(chunks).toString('utf-8') }));
      stream.on('error', () => resolve({ ok: false, text: '' }));
    });
    req.setTimeout(120000, () => { req.destroy(); resolve({ ok: false, text: '' }); });
    req.on('error', () => resolve({ ok: false, text: '' }));
  });
}

function parseRecords(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed.jobs) return parsed.jobs;
    return parsed;
  } catch {}
  // Try JSONL
  const records = [];
  for (const line of text.trim().split('\n')) {
    if (line.trim()) try { records.push(JSON.parse(line)); } catch {}
  }
  return records.length ? records : null;
}

function hasParsedData(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'object' && Object.keys(value).length > 0;
}

function parsedSize(value) {
  return Array.isArray(value) ? value.length : Object.keys(value || {}).length;
}

/**
 * Load a JSON file from private R2.
 * Priority: S3 (live) only. Public R2 and raw GitHub fallback are intentionally disabled.
 * @param {string} filename - e.g. 'enriched_jobs.json'
 * @param {Object} [opts]
 * @param {string} [opts.prefix] - R2 key prefix, e.g. 'data/'
 * @param {boolean} [opts.quiet=false] - Suppress loader progress logs
 * @returns {Array|Object} parsed JSON or JSONL records
 */
async function loadJsonFromR2(filename, opts = {}) {
  const { prefix = 'data/' } = opts;
  const r2Key = `${prefix}${filename}`;

  // 1. S3 client (live data, requires env vars)
  if (hasS3Credentials()) {
    try {
      console.error(`  Loading ${filename} from R2 (S3, live)...`);
      const text = await loadViaS3(r2Key);
      const records = parseRecords(text);
      if (hasParsedData(records)) {
        console.error(`  Loaded ${parsedSize(records)} records from R2`);
        return records;
      }
    } catch (e) {
      console.error(`  R2 S3 failed: ${e.message}`);
    }
  }

  throw new Error(`Could not load ${filename} from private R2`);
}

/**
 * Check R2 connectivity and return bucket stats.
 */
async function checkR2Connection() {
  if (!hasS3Credentials()) {
    return { connected: false, error: 'R2 env vars not set. Run setup-r2-local.sh.' };
  }
  try {
    const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      MaxKeys: 1,
    }));
    return { connected: true, objectCount: resp.KeyCount, bucket: process.env.R2_BUCKET_NAME };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

module.exports = { loadJsonFromR2, checkR2Connection, hasS3Credentials };
