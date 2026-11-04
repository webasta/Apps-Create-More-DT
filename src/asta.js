'use strict';

/**
 * Integrasi ke Asta Document Services.
 *
 * Karena format response Asta bisa berbeda-beda, hasil dibaca secara fleksibel:
 *  1. Response berupa file (PDF/DOCX/octet-stream)   -> disimpan langsung
 *  2. JSON berisi URL file (url, file_url, download_url, ...) -> URL dicatat (dan diunduh bila ASTA_DOWNLOAD_RESULT=true)
 *  3. JSON berisi file base64 (file, content, base64, ...)   -> di-decode & disimpan
 *  4. JSON berisi job id + callback aktif -> status "waiting", hasil datang lewat /api/callback/:jobId
 * Fungsi interpretResult() yang sama dipakai untuk membaca body callback.
 */
const config = require('./config');
const store = require('./store');
const { buildAstaPayload } = require('./shared/dt-builder');

// urutan = prioritas: PDF dulu
const URL_KEYS = ['pdf_url', 'pdfUrl', 'pdf', 'file_url', 'download_url', 'downloadUrl', 'fileUrl', 'document_url', 'documentUrl', 'pdf_url', 'pdfUrl', 'url', 'link', 'href'];
const DOCX_KEYS = ['docx_url', 'docxUrl', 'docx', 'word_url', 'wordUrl'];
const B64_KEYS = ['file_base64', 'base64', 'file', 'content', 'document', 'pdf', 'data'];
// sub-objek yang bukan hasil (mis. info template) tidak ikut dicari
const SKIP_KEYS = new Set(['template', 'request', 'input', 'payload', 'meta']);
const JOBID_KEYS = ['job_id', 'jobId', 'request_id', 'requestId', 'task_id', 'taskId', 'id'];
const STATUS_ERROR = /^(error|failed|fail|gagal)$/i;

const MIME_EXT = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/html': 'html',
};

function extFromResponse(contentType, disposition, fallbackUrl) {
  const fn = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition || '');
  const fromName = fn && /\.([A-Za-z0-9]{2,5})$/.exec(decodeURIComponent(fn[1]));
  if (fromName) return fromName[1].toLowerCase();
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (MIME_EXT[ct]) return MIME_EXT[ct];
  const fromUrl = fallbackUrl && /\.([A-Za-z0-9]{2,5})(?:\?|#|$)/.exec(fallbackUrl);
  if (fromUrl) return fromUrl[1].toLowerCase();
  return 'pdf';
}

function isJsonType(ct) {
  return /json/i.test(ct || '');
}
function isTextType(ct) {
  return /^text\/(plain|xml)|json/i.test(ct || '');
}

// Cari nilai pada objek JSON (termasuk satu-dua level di dalam data/result/file)
function findIn(obj, keys, test, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return undefined;
  for (const k of keys) {
    if (k in obj && test(obj[k])) return obj[k];
  }
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP_KEYS.has(k)) continue;
    if (v && typeof v === 'object') {
      const found = findIn(v, keys, test, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const looksLikeUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
const looksLikeB64 = (v) => {
  if (typeof v !== 'string' || v.length < 200) return false;
  const s = v.replace(/^data:[^;]+;base64,/, '');
  return /^[A-Za-z0-9+/=\r\n]+$/.test(s.slice(0, 2000));
};
const looksLikeId = (v) => (typeof v === 'string' && v.length > 0 && v.length < 200) || typeof v === 'number';

function short(text, n = 4000) {
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
}

async function downloadUrl(url) {
  const headers = {};
  // kirim API key hanya bila URL berada di host yang sama dengan API Asta
  try {
    if (config.astaApiKey && new URL(url).host === new URL(config.astaApiUrl).host) {
      headers[config.astaAuthHeader] = config.astaApiKey;
    }
  } catch { /* abaikan */ }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(config.astaTimeoutMs) });
  if (!res.ok) throw new Error(`Gagal mengunduh file hasil (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, ext: extFromResponse(res.headers.get('content-type'), res.headers.get('content-disposition'), url) };
}

/**
 * Baca hasil (dari response generate atau body callback) lalu update job.
 * @param {object} job
 * @param {{contentType:string, disposition:string, body:Buffer}} raw
 * @param {{allowWaiting:boolean}} opts
 */
async function interpretResult(job, raw, opts = {}) {
  const ct = raw.contentType || '';
  const body = raw.body || Buffer.alloc(0);

  // 1. Response berupa file langsung
  if (!isTextType(ct) && !/text\/html/i.test(ct) && body.length > 0) {
    const ext = extFromResponse(ct, raw.disposition);
    const fileName = store.saveFile(job.id, job.no_dt, ext, body);
    return store.update(job.id, { status: 'done', file_name: fileName, file_url: `/files/${encodeURIComponent(fileName)}` });
  }

  const text = body.toString('utf8');
  let json = null;
  if (isJsonType(ct) || /^\s*[[{]/.test(text)) {
    try { json = JSON.parse(text); } catch { json = null; }
  }

  if (!json) {
    // teks biasa: mungkin langsung berupa URL
    const t = text.trim();
    if (looksLikeUrl(t)) return handleUrl(job, t);
    return store.update(job.id, { status: 'error', error: 'Response Asta tidak dikenali.', raw_response: short(text) });
  }

  const statusVal = findIn(json, ['status', 'state'], (v) => typeof v === 'string');
  const message = findIn(json, ['error', 'message', 'msg'], (v) => typeof v === 'string');
  if (json.success === false || (statusVal && STATUS_ERROR.test(statusVal))) {
    return store.update(job.id, { status: 'error', error: message || 'Asta mengembalikan status gagal.', raw_response: short(json) });
  }

  // 2. URL file (absolut, atau relatif seperti "/storage/xxx.pdf" -> digabung dengan host Asta)
  //    Asta: { document: { pdf: "https://...pdf", docx: "https://...docx" } }
  const docxUrl = findIn(json, DOCX_KEYS, looksLikeUrl);
  const url = findIn(json, URL_KEYS, looksLikeUrl) || docxUrl;
  if (url) return handleUrl(job, url, json, docxUrl && docxUrl !== url ? docxUrl : null);
  const relUrl = findIn(json, URL_KEYS.concat(['path', 'file_path', 'filePath']), (v) => typeof v === 'string' && /^\/[^/\s][^\s]*\.(pdf|docx?|xlsx|odt)(\?.*)?$/i.test(v));
  if (relUrl) return handleUrl(job, new URL(relUrl, config.astaApiUrl).href, json);

  // 3. base64
  const b64 = findIn(json, B64_KEYS, looksLikeB64);
  if (b64) {
    const mime = /^data:([^;]+);base64,/.exec(b64);
    const buf = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    const nameHint = findIn(json, ['filename', 'file_name', 'fileName', 'name'], (v) => typeof v === 'string');
    const ext = extFromResponse(mime ? mime[1] : findIn(json, ['mime_type', 'mimeType', 'content_type'], (v) => typeof v === 'string'), nameHint ? `filename="${nameHint}"` : '');
    const fileName = store.saveFile(job.id, job.no_dt, ext, buf);
    return store.update(job.id, { status: 'done', file_name: fileName, file_url: `/files/${encodeURIComponent(fileName)}` });
  }

  // 4. job id -> tunggu callback (hanya bila callback aktif; kalau tidak, jangan menggantung)
  const remoteId = findIn(json, JOBID_KEYS, looksLikeId);
  if (opts.allowWaiting && callbackEnabled()) {
    return store.update(job.id, {
      status: 'waiting',
      remote_id: remoteId !== undefined ? String(remoteId) : undefined,
      raw_response: short(json),
    });
  }
  if (remoteId !== undefined) {
    return store.update(job.id, {
      status: 'error',
      remote_id: String(remoteId),
      error: `Asta memproses secara async (id ${remoteId}), tetapi callback belum diaktifkan. Klik "Response" untuk melihat balasan Asta.`,
      raw_response: short(json),
    });
  }

  return store.update(job.id, {
    status: 'error',
    error: 'Response Asta tidak berisi file, URL, maupun job id yang dikenali.',
    raw_response: short(json),
  });
}

async function handleUrl(job, url, json, docxUrl) {
  if (!config.astaDownloadResult) {
    return store.update(job.id, { status: 'done', file_url: url, remote_url: url, docx_url: docxUrl || undefined });
  }
  // file pendamping (DOCX) — kalau gagal diunduh, pakai link asli Asta
  let docx;
  if (docxUrl) {
    try {
      const d = await downloadUrl(docxUrl);
      docx = `/files/${encodeURIComponent(store.saveFile(job.id, job.no_dt, d.ext, d.buf))}`;
    } catch {
      docx = docxUrl;
    }
  }
  try {
    const { buf, ext } = await downloadUrl(url);
    const fileName = store.saveFile(job.id, job.no_dt, ext, buf);
    return store.update(job.id, { status: 'done', file_name: fileName, file_url: `/files/${encodeURIComponent(fileName)}`, remote_url: url, docx_url: docx, error: undefined });
  } catch (err) {
    // tetap berikan link asli kalau unduh gagal
    return store.update(job.id, { status: 'done', file_url: url, remote_url: url, warning: err.message, raw_response: json ? short(json) : undefined });
  }
}

function callbackEnabled() {
  return Boolean(config.astaCallbackField && config.publicBaseUrl);
}

function callbackUrlFor(jobId) {
  const q = config.callbackSecret ? `?token=${encodeURIComponent(config.callbackSecret)}` : '';
  return `${config.publicBaseUrl}/api/callback/${jobId}${q}`;
}

/** Kirim satu DT ke Asta. Selalu mengembalikan job (status done/waiting/error). */
async function generateOne(dt, templateId, existingJob) {
  const payload = buildAstaPayload(templateId, dt);
  const job = existingJob
    ? store.update(existingJob.id, { status: 'processing' })
    : store.create({ no_dt: dt.no_dt, template_id: templateId, source: dt.source || 'excel' });
  if (callbackEnabled()) payload[config.astaCallbackField] = callbackUrlFor(job.id);

  const headers = { 'Content-Type': 'application/json', Accept: 'application/pdf, application/json, */*' };
  if (config.astaApiKey) headers[config.astaAuthHeader] = config.astaApiKey;

  try {
    const res = await fetch(config.astaApiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.astaTimeoutMs),
    });
    const body = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      let reason = '';
      try {
        const j = JSON.parse(body.toString('utf8'));
        reason = findIn(j, ['message', 'error', 'msg', 'detail'], (v) => typeof v === 'string') || '';
      } catch { /* bukan JSON */ }
      return store.update(job.id, {
        status: 'error',
        error: `Asta membalas HTTP ${res.status}${reason ? ': ' + reason : ''}`,
        raw_response: short(body.toString('utf8')),
      });
    }
    return await interpretResult(
      job,
      { contentType: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), body },
      { allowWaiting: true }
    );
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? `Timeout: Asta tidak membalas dalam ${config.astaTimeoutMs / 1000} detik` : `Gagal menghubungi Asta: ${err.message}`;
    return store.update(job.id, { status: 'error', error: msg });
  }
}

/**
 * Antrekan banyak DT: job dibuat langsung (status "queued") dan dikembalikan,
 * lalu diproses di background dengan batas paralel ASTA_CONCURRENCY.
 * Halaman web cukup polling /api/jobs?ids=... untuk melihat progres.
 */
function enqueueMany(dts, templateId) {
  const jobs = dts.map((dt) =>
    store.create({ no_dt: dt.no_dt, template_id: templateId, source: dt.source || 'excel', status: 'queued' })
  );
  let next = 0;
  async function worker() {
    while (next < dts.length) {
      const i = next++;
      try {
        await generateOne(dts[i], templateId, jobs[i]);
      } catch (err) {
        store.update(jobs[i].id, { status: 'error', error: err.message });
      }
    }
  }
  Array.from({ length: Math.min(config.astaConcurrency, dts.length) }, worker);
  return jobs;
}

/**
 * Saat server start: job yang tertahan di "waiting"/"processing" dibaca ulang dari response yang tersimpan
 * (mis. dari versi lama yang belum mengenali format response Asta).
 */
async function recoverStuckJobs() {
  for (const job of store.list(1000)) {
    if (!['waiting', 'processing', 'queued'].includes(job.status)) continue;
    if (job.raw_response && /^\s*\{/.test(job.raw_response)) {
      try {
        const updated = await interpretResult(
          job,
          { contentType: 'application/json', body: Buffer.from(job.raw_response) },
          { allowWaiting: callbackEnabled() }
        );
        console.log(`[recover] ${job.no_dt} -> ${updated.status}`);
      } catch (err) {
        store.update(job.id, { status: 'error', error: err.message });
      }
    } else if (job.status !== 'waiting' || !callbackEnabled()) {
      store.update(job.id, { status: 'error', error: 'Proses terhenti (server di-restart). Silakan cetak ulang.' });
    }
  }
}

module.exports = { generateOne, enqueueMany, interpretResult, callbackEnabled, recoverStuckJobs };
