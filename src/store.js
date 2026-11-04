'use strict';

// Penyimpanan job sederhana: memori + file storage/jobs.json, file hasil di storage/files/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

const filesDir = path.join(config.storageDir, 'files');
const jobsFile = path.join(config.storageDir, 'jobs.json');
fs.mkdirSync(filesDir, { recursive: true });

let jobs = {};
try {
  jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
} catch {
  jobs = {};
}

let saveTimer = null;
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = jobsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 1));
  fs.renameSync(tmp, jobsFile);
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}
// simpan perubahan terakhir saat container dihentikan (docker stop / restart)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    if (saveTimer) flush();
    process.exit(0);
  });
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function create(fields) {
  const now = new Date().toISOString();
  const job = { id: newId(), status: 'processing', created_at: now, updated_at: now, ...fields };
  jobs[job.id] = job;
  persist();
  return job;
}

function update(id, fields) {
  if (!jobs[id]) return null;
  jobs[id] = { ...jobs[id], ...fields, updated_at: new Date().toISOString() };
  persist();
  return jobs[id];
}

function get(id) {
  return jobs[id] || null;
}

function list(limit = 200) {
  return Object.values(jobs)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit);
}

function safeName(name) {
  return String(name || 'dokumen').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'dokumen';
}

/** Simpan buffer hasil ke storage/files, kembalikan nama file tersimpan */
function saveFile(jobId, baseName, ext, buffer) {
  const name = `${jobId}__${safeName(baseName)}${ext ? '.' + ext.replace(/^\./, '') : ''}`;
  fs.writeFileSync(path.join(filesDir, name), buffer);
  return name;
}

function filePath(name) {
  const clean = path.basename(String(name));
  const full = path.join(filesDir, clean);
  return fs.existsSync(full) ? full : null;
}

const ACTIVE = new Set(['queued', 'processing']);

// Hapus satu job beserta semua file hasilnya (PDF, DOCX, ...)
function remove(id) {
  const job = jobs[id];
  if (!job) return false;
  for (const f of fs.readdirSync(filesDir)) {
    if (f.startsWith(`${id}__`)) fs.rmSync(path.join(filesDir, f), { force: true });
  }
  delete jobs[id];
  persist();
  return true;
}

/**
 * Hapus job yang lebih tua dari N hari (N = 0 -> semua).
 * Job yang sedang diproses tidak ikut dihapus.
 */
function removeOlderThan(days) {
  const cutoff = Date.now() - Math.max(0, days) * 86400000;
  let count = 0;
  for (const job of Object.values(jobs)) {
    if (ACTIVE.has(job.status)) continue;
    if (days === 0 || new Date(job.created_at).getTime() < cutoff) {
      remove(job.id);
      count++;
    }
  }
  return count;
}

// Hapus otomatis sesuai JOB_RETENTION_DAYS (0 = tidak pernah dihapus otomatis)
function cleanup() {
  if (config.jobRetentionDays > 0) removeOlderThan(config.jobRetentionDays);
}
cleanup();
setInterval(cleanup, 6 * 3600000).unref();

module.exports = { create, update, get, list, saveFile, filePath, safeName, remove, removeOlderThan, ACTIVE };
