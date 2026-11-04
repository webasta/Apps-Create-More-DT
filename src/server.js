'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./store');
const asta = require('./asta');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHARED_FILE = path.join(__dirname, 'shared', 'dt-builder.js');
const MAX_JSON = 5 * 1024 * 1024; // 5 MB
const MAX_CALLBACK = 50 * 1024 * 1024; // 50 MB
const MAX_DT_PER_REQUEST = 200;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const FILE_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.html': 'text/html; charset=utf-8',
};

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body terlalu besar'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('JSON tidak valid'), { status: 400 });
  }
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function checkBasicAuth(req) {
  if (!config.appUsername || !config.appPassword) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  return safeEqual(u, config.appUsername) && safeEqual(rest.join(':'), config.appPassword);
}
function publicJob(job) {
  if (!job) return null;
  const { id, no_dt, status, file_url, docx_url, file_name, error, warning, raw_response, created_at, updated_at, template_id } = job;
  return { id, no_dt, status, file_url, docx_url, file_name, error, warning, raw_response, created_at, updated_at, template_id };
}
function serveStatic(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Tidak ditemukan');
    send(res, 200, data, { 'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

// ---------- validasi DT dari client ----------
function validateDts(input) {
  if (!Array.isArray(input) || input.length === 0) throw Object.assign(new Error('Tidak ada DT yang dikirim.'), { status: 400 });
  if (input.length > MAX_DT_PER_REQUEST) throw Object.assign(new Error(`Maksimal ${MAX_DT_PER_REQUEST} DT per proses.`), { status: 400 });
  return input.map((dt, i) => {
    if (!dt || typeof dt !== 'object' || !dt.header || typeof dt.header !== 'object') {
      throw Object.assign(new Error(`DT ke-${i + 1} tidak valid.`), { status: 400 });
    }
    const no = String(dt.no_dt || dt.header.no_dt || '').trim();
    if (!no) throw Object.assign(new Error(`DT ke-${i + 1}: no_dt kosong.`), { status: 400 });
    if (!Array.isArray(dt.items) || dt.items.length === 0) throw Object.assign(new Error(`DT ${no}: tidak ada item.`), { status: 400 });
    return { no_dt: no, header: dt.header, items: dt.items, source: dt.source };
  });
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/healthz') return sendJson(res, 200, { ok: true });

  // Callback dari Asta: tidak pakai basic auth, diamankan dengan token
  const cb = /^\/api\/callback\/([a-f0-9]{16})$/.exec(p);
  if (cb && req.method === 'POST') {
    if (config.callbackSecret && !safeEqual(url.searchParams.get('token') || '', config.callbackSecret)) {
      return sendJson(res, 401, { ok: false, error: 'token tidak valid' });
    }
    const job = store.get(cb[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'job tidak ditemukan' });
    const body = await readBody(req, MAX_CALLBACK);
    const updated = await asta.interpretResult(
      job,
      { contentType: req.headers['content-type'], disposition: req.headers['content-disposition'], body },
      { allowWaiting: false }
    );
    console.log(`[callback] ${job.no_dt} -> ${updated.status}`);
    return sendJson(res, 200, { ok: true, status: updated.status });
  }

  if (!checkBasicAuth(req)) {
    return send(res, 401, 'Login diperlukan', { 'WWW-Authenticate': 'Basic realm="Create More DT", charset="UTF-8"' });
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  if (req.method === 'GET' && p === '/js/dt-builder.js') return serveStatic(res, SHARED_FILE);
  if (req.method === 'GET' && /^\/(css|js|img)\/[A-Za-z0-9._-]+$/.test(p)) return serveStatic(res, path.join(PUBLIC_DIR, p));

  if (req.method === 'GET' && p === '/api/config') {
    return sendJson(res, 200, {
      template_id: config.astaTemplateId,
      api_url: config.astaApiUrl,
      callback_enabled: asta.callbackEnabled(),
      max_dt: MAX_DT_PER_REQUEST,
      retention_days: config.jobRetentionDays,
    });
  }

  // Hapus riwayat: DELETE /api/jobs?older_than_days=N  (N=0 -> semua)
  if (req.method === 'DELETE' && p === '/api/jobs') {
    const days = parseInt(url.searchParams.get('older_than_days'), 10);
    if (!Number.isFinite(days) || days < 0) return sendJson(res, 400, { ok: false, error: 'older_than_days tidak valid.' });
    const deleted = store.removeOlderThan(days);
    console.log(`[hapus] ${deleted} riwayat (lebih lama dari ${days} hari)`);
    return sendJson(res, 200, { ok: true, deleted });
  }

  // Hapus satu riwayat: DELETE /api/jobs/:id
  const dm = /^\/api\/jobs\/([a-f0-9]{16})$/.exec(p);
  if (req.method === 'DELETE' && dm) {
    const job = store.get(dm[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Riwayat tidak ditemukan.' });
    if (store.ACTIVE.has(job.status)) return sendJson(res, 409, { ok: false, error: 'DT masih diproses, belum bisa dihapus.' });
    store.remove(job.id);
    return sendJson(res, 200, { ok: true, deleted: 1 });
  }

  // Generate: body { template_id, dts: [{ no_dt, header:{...}, items:[...] }] }
  if (req.method === 'POST' && p === '/api/generate') {
    const body = await readJson(req);
    const templateId = String(body.template_id || config.astaTemplateId || '').trim();
    if (!templateId) return sendJson(res, 400, { ok: false, error: 'template_id belum diisi.' });
    const dts = validateDts(body.dts);
    console.log(`[generate] ${dts.length} DT, template ${templateId}`);
    const jobs = asta.enqueueMany(dts, templateId);
    return sendJson(res, 202, { ok: true, jobs: jobs.map(publicJob) });
  }

  if (req.method === 'GET' && p === '/api/jobs') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
    const jobs = ids.length ? ids.map((id) => publicJob(store.get(id))).filter(Boolean) : store.list(500).map(publicJob);
    return sendJson(res, 200, { ok: true, jobs });
  }

  const fm = /^\/files\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && fm) {
    const name = decodeURIComponent(fm[1]);
    const full = store.filePath(name);
    if (!full) return send(res, 404, 'File tidak ditemukan');
    const ext = path.extname(full).toLowerCase();
    const downloadName = name.replace(/^[a-f0-9]{16}__/, '');
    const inline = url.searchParams.get('download') !== '1' && ext === '.pdf';
    res.writeHead(200, {
      'Content-Type': FILE_TYPES[ext] || 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${downloadName}"`,
      'Cache-Control': 'private, max-age=3600',
    });
    return fs.createReadStream(full).pipe(res);
  }

  sendJson(res, 404, { ok: false, error: 'Tidak ditemukan' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message || 'Terjadi kesalahan' });
    else res.end();
  });
});
// generate banyak DT bisa lama: jangan putus koneksi terlalu cepat
server.requestTimeout = 15 * 60 * 1000;

server.listen(config.port, () => {
  console.log(`Create More DT berjalan di port ${config.port}`);
  console.log(`  Asta API      : ${config.astaApiUrl}`);
  console.log(`  Template ID   : ${config.astaTemplateId || '(diisi dari halaman)'}`);
  console.log(`  Callback      : ${asta.callbackEnabled() ? config.publicBaseUrl + '/api/callback/:jobId' : 'nonaktif'}`);
  console.log(`  Basic auth    : ${config.appUsername ? 'aktif' : 'NONAKTIF (isi APP_USERNAME & APP_PASSWORD di .env)'}`);
  console.log(`  Simpan riwayat: ${config.jobRetentionDays > 0 ? config.jobRetentionDays + ' hari' : 'selamanya (hapus manual)'}`);
  asta.recoverStuckJobs().catch((err) => console.error('[recover]', err));
});

module.exports = server;
