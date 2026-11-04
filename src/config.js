'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Baca file .env sederhana (untuk jalan lokal tanpa Docker). Di Docker, env diisi oleh docker compose.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

const env = process.env;
const bool = (v, def = false) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v));
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

module.exports = {
  port: int(env.PORT, 3000),
  storageDir: path.resolve(env.STORAGE_DIR || path.join(__dirname, '..', 'storage')),

  // Proteksi halaman (opsional tapi disarankan di VPS)
  appUsername: env.APP_USERNAME || '',
  appPassword: env.APP_PASSWORD || '',

  // Asta Document Services
  astaApiUrl: env.ASTA_API_URL || 'https://temp.astakorpora.com/api/v1/generate',
  astaTemplateId: env.ASTA_TEMPLATE_ID || '',
  astaAuthHeader: env.ASTA_AUTH_HEADER || 'Authorization',
  astaApiKey: env.ASTA_API_KEY || '',
  astaTimeoutMs: int(env.ASTA_TIMEOUT_MS, 60000),
  astaConcurrency: Math.max(1, int(env.ASTA_CONCURRENCY, 2)),
  // Kalau Asta mengembalikan URL file: unduh & simpan salinannya di server ini
  astaDownloadResult: bool(env.ASTA_DOWNLOAD_RESULT, true),

  // Callback (dipakai bila Asta memproses secara async lalu POST hasilnya balik)
  publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  astaCallbackField: env.ASTA_CALLBACK_FIELD || '',
  callbackSecret: env.CALLBACK_SECRET || '',

  jobRetentionDays: int(env.JOB_RETENTION_DAYS, 30),
};
