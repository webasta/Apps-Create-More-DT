/* global XLSX, DTBuilder */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    dts: [],          // hasil DTBuilder.rowsToDts
    selected: new Set(),
    jobs: {},         // no_dt -> job terakhir
    expanded: new Set(),
    polling: null,
  };

  // ---------- util ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  let toastTimer;
  function toast(msg, ms = 3500) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------- template Excel ----------
  function downloadTemplate() {
    if (typeof XLSX === 'undefined') return toast('Library Excel belum termuat. Periksa koneksi internet lalu muat ulang halaman.');
    const header = [
      ['no_dt', 'tanggal', 'customer_name', 'pic', 'ref_so', 'lokasi_tujuan', 'alamat', 'penerima', 'telp_penerima', 'keterangan'],
      ['DT/2026/11/001', new Date(), 'PT. Nov Oilfield Service', 'Chofifah Wulandari', 'SO-00123', 'Site Balikpapan', 'Jl. Mulawarman No. 1, Balikpapan', 'Budi', '0812xxxx', ''],
      ['DT/2026/11/002', new Date(), 'PT. Nov Oilfield Service', 'Chofifah Wulandari', 'SO-00123', 'Site Duri', 'Jl. Hangtuah, Duri, Riau', 'Andi', '0813xxxx', ''],
    ];
    const items = [
      ['no_dt', 'description', 'aku', 'qty', 'satuan', 'keterangan', 'image'],
      ['DT/2026/11/001', 'GS ASTRA PREMIUM N150 150 Amper 12 Volt', '01-001-0000037', 4, 'Pcs', '', ''],
      ['DT/2026/11/001', 'Cable Lug M35x12', '15-033-0001983', 20, 'Pcs', '', ''],
      ['DT/2026/11/002', 'GS ASTRA PREMIUM N150 150 Amper 12 Volt', '01-001-0000037', 2, 'Pcs', '', ''],
    ];
    const guide = [
      ['PETUNJUK PENGISIAN'],
      [''],
      ['1. Sheet "Header": 1 baris = 1 DT (1 lokasi pengiriman). Kolom no_dt wajib & tidak boleh dobel.'],
      ['2. Sheet "Items": 1 baris = 1 barang dalam sebuah DT. Tulis no_dt yang sama dengan sheet Header.'],
      ['3. Barang yang sama dikirim ke beberapa lokasi = beberapa DT, masing-masing dengan baris item sendiri.'],
      ['4. Nama kolom = nama field di template Asta. Kolom baru boleh ditambahkan, otomatis ikut terkirim.'],
      ['5. item_order terisi otomatis (1, 2, 3, ...) bila tidak ada kolomnya.'],
      ['6. Jangan ubah nama sheet "Header" dan "Items".'],
    ];
    const wb = XLSX.utils.book_new();
    const wsH = XLSX.utils.aoa_to_sheet(header, { cellDates: true, dateNF: 'dd-mm-yyyy' });
    const wsI = XLSX.utils.aoa_to_sheet(items);
    const wsG = XLSX.utils.aoa_to_sheet(guide);
    wsH['!cols'] = [18, 12, 28, 20, 12, 20, 36, 14, 14, 20].map((w) => ({ wch: w }));
    wsI['!cols'] = [18, 44, 18, 8, 8, 20, 30].map((w) => ({ wch: w }));
    wsG['!cols'] = [{ wch: 100 }];
    XLSX.utils.book_append_sheet(wb, wsH, 'Header');
    XLSX.utils.book_append_sheet(wb, wsI, 'Items');
    XLSX.utils.book_append_sheet(wb, wsG, 'Petunjuk');
    XLSX.writeFile(wb, 'Template_DT.xlsx');
  }

  // ---------- baca Excel ----------
  function findSheet(wb, names, fallbackIndex) {
    const lower = wb.SheetNames.map((n) => n.trim().toLowerCase());
    for (const n of names) {
      const i = lower.indexOf(n);
      if (i >= 0) return wb.Sheets[wb.SheetNames[i]];
    }
    return wb.Sheets[wb.SheetNames[fallbackIndex]];
  }

  async function readFile(file) {
    if (typeof XLSX === 'undefined') return toast('Library Excel belum termuat. Periksa koneksi internet lalu muat ulang halaman.');
    $('fileName').textContent = file.name;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { cellDates: true });
      const hs = findSheet(wb, ['header', 'headers', 'dt'], 0);
      const is = findSheet(wb, ['items', 'item', 'detail', 'details'], 1);
      if (!hs || !is) throw new Error('File harus punya sheet "Header" dan "Items".');
      const headerRows = XLSX.utils.sheet_to_json(hs, { defval: '', raw: true });
      const itemRows = XLSX.utils.sheet_to_json(is, { defval: '', raw: true });
      const result = DTBuilder.rowsToDts(headerRows, itemRows);
      state.dts = result.dts;
      state.jobs = {};
      state.expanded.clear();
      state.selected = new Set(result.dts.filter((d) => d.errors.length === 0).map((d) => d.no_dt));
      renderGlobalErrors(result.errors);
      renderTable();
      $('dataSection').classList.remove('hidden');
      $('dataSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error(err);
      toast('Gagal membaca file: ' + err.message, 6000);
    }
  }

  // ---------- render ----------
  function renderGlobalErrors(errors) {
    const box = $('globalErrors');
    if (!errors.length) return box.classList.add('hidden');
    box.innerHTML = `<b>${errors.length} baris tidak bisa diproses:</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
    box.classList.remove('hidden');
  }

  function statusCell(dt) {
    if (dt.errors.length) return `<span class="badge b-err">Data belum lengkap</span>`;
    const job = state.jobs[dt.no_dt];
    if (!job) return `<span class="badge b-ready">Siap</span>`;
    switch (job.status) {
      case 'queued': return `<span class="badge b-idle">Antre</span>`;
      case 'processing': return `<span class="badge b-wait">Diproses…</span>`;
      case 'waiting': return `<span class="badge b-wait">Menunggu Asta…</span>${rawLink(job)}`;
      case 'done': {
        const isLocal = job.file_url && job.file_url.startsWith('/files/');
        const dl = isLocal ? `${job.file_url}?download=1` : job.file_url;
        const docx = job.docx_url
          ? `<a href="${esc(job.docx_url.startsWith('/files/') ? job.docx_url + '?download=1' : job.docx_url)}" ${job.docx_url.startsWith('/files/') ? 'download' : 'target="_blank" rel="noopener"'}>DOCX</a>`
          : '';
        return `<span class="badge b-ok">Selesai</span><span class="result-links">
          <a href="${esc(job.file_url)}" target="_blank" rel="noopener">Buka</a>
          <a href="${esc(dl)}" ${isLocal ? 'download' : 'target="_blank" rel="noopener"'}>Unduh PDF</a>${docx}</span>
          ${job.warning ? `<span class="err-text">${esc(job.warning)}</span>` : ''}`;
      }
      default:
        return `<span class="badge b-err">Gagal</span>${rawLink(job)}<span class="err-text">${esc(job.error || 'Terjadi kesalahan')}</span>`;
    }
  }

  // tombol untuk melihat balasan asli Asta (debug)
  const rawStore = {};
  function rawLink(job) {
    if (!job || !job.raw_response) return '';
    rawStore[job.id] = job;
    return `<span class="result-links"><a href="#" data-raw="${esc(job.id)}">Response</a></span>`;
  }
  function showRaw(id) {
    const job = rawStore[id];
    if (!job) return;
    let txt = job.raw_response;
    try { txt = JSON.stringify(JSON.parse(txt), null, 2); } catch { /* bukan JSON utuh */ }
    $('jsonTitle').textContent = `Response Asta — ${job.no_dt}`;
    $('jsonContent').textContent = txt;
    $('jsonDialog').showModal();
  }
  document.addEventListener('click', (e) => {
    const id = e.target && e.target.dataset && e.target.dataset.raw;
    if (id) { e.preventDefault(); showRaw(id); }
  });

  function renderTable() {
    const body = $('dtBody');
    if (!state.dts.length) {
      body.innerHTML = `<tr><td colspan="8" class="muted">Tidak ada DT di file ini.</td></tr>`;
    } else {
      body.innerHTML = state.dts.map((dt, i) => {
        const h = dt.header;
        const invalid = dt.errors.length > 0;
        const open = state.expanded.has(dt.no_dt);
        const row = `<tr class="${invalid ? 'row-error' : ''}">
          <td class="col-check"><input type="checkbox" data-check="${i}" ${state.selected.has(dt.no_dt) ? 'checked' : ''} ${invalid ? 'disabled' : ''}></td>
          <td><b>${esc(dt.no_dt)}</b></td>
          <td>${esc(h.tanggal)}</td>
          <td>${esc(h.customer_name)}</td>
          <td>${esc(h.lokasi_tujuan)}</td>
          <td class="num">${dt.items.length}</td>
          <td>${statusCell(dt)}</td>
          <td class="col-actions">
            <button class="btn btn-ghost btn-sm" data-toggle="${i}">${open ? 'Tutup' : 'Detail'}</button>
            <button class="btn btn-ghost btn-sm" data-json="${i}">JSON</button>
          </td></tr>`;
        if (!open) return row;
        const cols = Array.from(dt.items.reduce((s, it) => { Object.keys(it).forEach((k) => s.add(k)); return s; }, new Set()));
        const detail = `<tr class="detail-row"><td colspan="8">
          ${invalid ? `<ul class="err-list">${dt.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
          <table class="items-table"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${dt.items.map((it) => `<tr>${cols.map((c) => `<td>${esc(it[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>
        </td></tr>`;
        return row + detail;
      }).join('');
    }
    renderSummary();
  }

  function renderSummary() {
    const total = state.dts.length;
    const invalid = state.dts.filter((d) => d.errors.length).length;
    const items = state.dts.reduce((n, d) => n + d.items.length, 0);
    $('summary').textContent = `${total} DT · ${items} item${invalid ? ` · ${invalid} DT perlu diperbaiki` : ''}`;
    const n = state.selected.size;
    $('btnGenerate').textContent = n ? `Cetak ${n} DT` : 'Cetak DT terpilih';
    $('btnGenerate').disabled = n === 0 || Boolean(state.polling);
    const selectable = state.dts.filter((d) => !d.errors.length);
    $('checkAll').checked = selectable.length > 0 && selectable.every((d) => state.selected.has(d.no_dt));

    const jobs = Object.values(state.jobs);
    const done = jobs.filter((j) => j.status === 'done').length;
    const failed = jobs.filter((j) => j.status === 'error').length;
    const running = jobs.length - done - failed;
    $('progressText').textContent = jobs.length
      ? `${done} selesai${failed ? `, ${failed} gagal` : ''}${running ? `, ${running} masih diproses` : ''}`
      : '';
    $('btnDownloadAll').classList.toggle('hidden', done < 2);
  }

  // ---------- generate & polling ----------
  async function generate() {
    const templateId = $('templateId').value.trim();
    if (!templateId) {
      $('templateId').focus();
      return toast('Isi Template ID dulu.');
    }
    try { localStorage.setItem('dt_template_id', templateId); } catch { /* abaikan */ }
    const dts = state.dts.filter((d) => state.selected.has(d.no_dt) && !d.errors.length)
      .map((d) => ({ no_dt: d.no_dt, header: d.header, items: d.items }));
    if (!dts.length) return;
    $('btnGenerate').disabled = true;
    try {
      const res = await api('/api/generate', { method: 'POST', body: JSON.stringify({ template_id: templateId, dts }) });
      res.jobs.forEach((j) => { state.jobs[j.no_dt] = j; });
      renderTable();
      startPolling();
    } catch (err) {
      toast('Gagal mengirim: ' + err.message, 6000);
      renderSummary();
    }
  }

  function startPolling() {
    clearInterval(state.polling);
    let rounds = 0;
    const tick = async () => {
      rounds++;
      const pending = Object.values(state.jobs).filter((j) => ['queued', 'processing', 'waiting'].includes(j.status));
      if (!pending.length || rounds > 400) { // ±20 menit
        clearInterval(state.polling);
        state.polling = null;
        renderTable();
        loadHistory();
        const failed = Object.values(state.jobs).filter((j) => j.status === 'error').length;
        toast(failed ? `Selesai, ${failed} DT gagal. Lihat keterangan di kolom status.` : 'Semua DT selesai dicetak.');
        return;
      }
      try {
        const res = await api('/api/jobs?ids=' + pending.map((j) => j.id).join(','));
        res.jobs.forEach((j) => { state.jobs[j.no_dt] = j; });
        renderTable();
      } catch { /* coba lagi di putaran berikutnya */ }
    };
    state.polling = setInterval(tick, 3000);
    setTimeout(tick, 800);
    renderSummary();
  }

  function downloadAll() {
    const done = Object.values(state.jobs).filter((j) => j.status === 'done' && j.file_url);
    done.forEach((j, i) => setTimeout(() => {
      const a = document.createElement('a');
      const local = j.file_url.startsWith('/files/');
      a.href = local ? `${j.file_url}?download=1` : j.file_url;
      if (local) a.download = ''; else a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 400));
    toast(`Mengunduh ${done.length} file. Izinkan "multiple downloads" bila browser bertanya.`);
  }

  // ---------- JSON preview ----------
  function showJson(dt) {
    const tpl = $('templateId').value.trim() || '(template_id)';
    const payload = DTBuilder.buildAstaPayload(tpl, dt);
    $('jsonTitle').textContent = `Payload JSON — ${dt.no_dt}`;
    $('jsonContent').textContent = JSON.stringify(payload, null, 2);
    $('jsonDialog').showModal();
  }

  // ---------- riwayat ----------
  async function loadHistory() {
    try {
      const res = await api('/api/jobs');
      const body = $('historyBody');
      if (!res.jobs.length) {
        body.innerHTML = `<tr><td colspan="5" class="muted">Belum ada data.</td></tr>`;
        return;
      }
      body.innerHTML = res.jobs.slice(0, 50).map((j) => {
        const t = new Date(j.created_at).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
        const badge = j.status === 'done' ? 'b-ok' : j.status === 'error' ? 'b-err' : 'b-wait';
        const label = { done: 'Selesai', error: 'Gagal', queued: 'Antre', processing: 'Diproses', waiting: 'Menunggu Asta' }[j.status] || j.status;
        const link = j.status === 'done' && j.file_url
          ? `<a class="btn btn-ghost btn-sm" href="${esc(j.file_url)}" target="_blank" rel="noopener">PDF</a>${j.docx_url ? `<a class="btn btn-ghost btn-sm" href="${esc(j.docx_url)}${j.docx_url.startsWith('/files/') ? '?download=1' : ''}" target="_blank" rel="noopener">DOCX</a>` : ''}`
          : '';
        return `<tr><td>${esc(t)}</td><td>${esc(j.no_dt)}</td><td>${esc(j.template_id)}</td>
          <td><span class="badge ${badge}">${esc(label)}</span>${j.status !== 'done' ? rawLink(j) : ''}${j.status === 'error' ? `<span class="err-text">${esc(j.error)}</span>` : ''}</td>
          <td class="col-actions">${link}</td></tr>`;
      }).join('');
    } catch { /* abaikan */ }
  }

  // ---------- events ----------
  $('btnTemplate').addEventListener('click', downloadTemplate);
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) readFile(f);
    e.target.value = '';
  });
  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  $('dtBody').addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.check !== undefined) {
      const dt = state.dts[+t.dataset.check];
      t.checked ? state.selected.add(dt.no_dt) : state.selected.delete(dt.no_dt);
      return renderSummary();
    }
    if (t.dataset.toggle !== undefined) {
      const no = state.dts[+t.dataset.toggle].no_dt;
      state.expanded.has(no) ? state.expanded.delete(no) : state.expanded.add(no);
      return renderTable();
    }
    if (t.dataset.json !== undefined) return showJson(state.dts[+t.dataset.json]);
  });
  $('checkAll').addEventListener('change', (e) => {
    state.selected = new Set(e.target.checked ? state.dts.filter((d) => !d.errors.length).map((d) => d.no_dt) : []);
    renderTable();
  });
  $('btnGenerate').addEventListener('click', generate);
  $('btnDownloadAll').addEventListener('click', downloadAll);
  $('btnRefreshHistory').addEventListener('click', loadHistory);
  $('jsonDialog').addEventListener('click', (e) => {
    if (e.target.dataset.close !== undefined || e.target === $('jsonDialog')) $('jsonDialog').close();
  });
  $('btnCopyJson').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('jsonContent').textContent);
      toast('JSON disalin.');
    } catch { toast('Tidak bisa menyalin otomatis, silakan blok & salin manual.'); }
  });

  // ---------- init ----------
  (async function init() {
    let saved = '';
    try { saved = localStorage.getItem('dt_template_id') || ''; } catch { /* abaikan */ }
    try {
      const cfg = await api('/api/config');
      $('templateId').value = saved || cfg.template_id || '';
    } catch {
      $('templateId').value = saved;
    }
    loadHistory();
  })();
})();
