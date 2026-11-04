/**
 * DT Builder — dipakai di browser (window.DTBuilder) dan di Node (require).
 *
 * Mengubah baris Excel (sheet Header + sheet Items) menjadi daftar DT,
 * lengkap dengan validasi, lalu menyusun objek `data` untuk Asta Document Services.
 *
 * Aturan:
 *  - Nama kolom Excel = nama key JSON (huruf kecil, spasi -> underscore).
 *    Tambah kolom baru di Excel = otomatis ikut terkirim, tanpa ubah kode.
 *  - Sheet Header: 1 baris = 1 DT. Kolom wajib: no_dt.
 *  - Sheet Items : 1 baris = 1 item di sebuah DT. Kolom wajib: no_dt, description.
 *  - item_order diisi otomatis (1, 2, 3, ...) bila kosong.
 *  - Semua nilai dikirim sebagai string. Tanggal diformat Indonesia: "4 November 2026"
 *    (sel bertipe tanggal, atau teks 05-11-2026 / 2026-11-05 di kolom tanggal/tgl/date).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DTBuilder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ITEMS_KEY = 'line_items';

  function normalizeKey(key) {
    return String(key == null ? '' : key)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

  /** Tanggal format Indonesia: "4 November 2026" */
  function formatDate(d) {
    return d.getDate() + ' ' + BULAN[d.getMonth()] + ' ' + d.getFullYear();
  }

  // kolom yang dianggap tanggal: tanggal, tgl, date, tanggal_kirim, tgl_po, delivery_date, ...
  function isDateKey(key) {
    return /(^|_)(tanggal|tgl|date)(_|$)/.test(key || '');
  }

  function dateFromParts(y, m, d) {
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
  }

  // Teks tanggal yang diketik manual: 05-11-2026, 05/11/2026, 5.11.2026, 2026-11-05
  function parseDateText(s) {
    let m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (m) return dateFromParts(+m[3], +m[2], +m[1]);
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s);
    if (m) return dateFromParts(+m[1], +m[2], +m[3]);
    return null;
  }

  function toText(value, key) {
    if (value == null) return '';
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return '';
      // bulatkan ke detik terdekat (Excel kadang menyimpan 23:59:59.999)
      return formatDate(new Date(Math.round(value.getTime() / 1000) * 1000));
    }
    if (typeof value === 'number') {
      // nomor seri tanggal Excel (mis. 46330) pada kolom tanggal
      if (isDateKey(key) && value > 20000 && value < 80000) {
        const d = new Date(Math.round((value - 25569) * 86400000));
        return formatDate(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      }
      // hindari 0.30000000000000004 dari Excel
      return String(Math.round(value * 1e6) / 1e6);
    }
    const s = String(value).trim();
    if (isDateKey(key)) {
      const d = parseDateText(s);
      if (d) return formatDate(d);
    }
    return s;
  }

  function normalizeRow(row) {
    const out = {};
    Object.keys(row || {}).forEach(function (k) {
      const key = normalizeKey(k);
      // kolom tanpa judul (SheetJS menamainya __EMPTY, __EMPTY_1, ...) diabaikan
      if (!key || /^empty(_\d+)?$/.test(key)) return;
      out[key] = toText(row[k], key);
    });
    return out;
  }

  function isBlankRow(row) {
    return Object.keys(row).every(function (k) {
      return row[k] === '';
    });
  }

  /**
   * @param {object[]} headerRows  baris mentah dari sheet Header
   * @param {object[]} itemRows    baris mentah dari sheet Items
   * @returns {{dts: object[], errors: string[]}}
   *   dts[i] = { no_dt, header: {...}, items: [...], errors: [...] }
   *   errors = error global (bukan milik satu DT tertentu)
   */
  function rowsToDts(headerRows, itemRows) {
    const errors = [];
    const dts = [];
    const byNo = new Map();

    (headerRows || []).map(normalizeRow).forEach(function (row, idx) {
      if (isBlankRow(row)) return;
      const excelRow = idx + 2; // baris 1 = judul kolom
      const no = row.no_dt || '';
      if (!no) {
        errors.push('Sheet Header baris ' + excelRow + ': kolom no_dt kosong.');
        return;
      }
      if (byNo.has(no)) {
        byNo.get(no).errors.push('No DT "' + no + '" muncul lebih dari sekali di sheet Header (baris ' + excelRow + ').');
        return;
      }
      const dt = { no_dt: no, header: row, items: [], errors: [] };
      byNo.set(no, dt);
      dts.push(dt);
    });

    (itemRows || []).map(normalizeRow).forEach(function (row, idx) {
      if (isBlankRow(row)) return;
      const excelRow = idx + 2;
      const no = row.no_dt || '';
      if (!no) {
        errors.push('Sheet Items baris ' + excelRow + ': kolom no_dt kosong.');
        return;
      }
      const dt = byNo.get(no);
      if (!dt) {
        errors.push('Sheet Items baris ' + excelRow + ': No DT "' + no + '" tidak ada di sheet Header.');
        return;
      }
      const item = Object.assign({}, row);
      delete item.no_dt;
      if (!item.description) {
        dt.errors.push('Item di sheet Items baris ' + excelRow + ': description kosong.');
      }
      if ('qty' in item) {
        const q = Number(String(item.qty).replace(',', '.'));
        if (item.qty === '' || !isFinite(q) || q <= 0) {
          dt.errors.push('Item di sheet Items baris ' + excelRow + ': qty harus angka lebih dari 0.');
        }
      }
      dt.items.push(item);
    });

    dts.forEach(function (dt) {
      if (dt.items.length === 0) dt.errors.push('DT tidak punya item di sheet Items.');
      dt.items.forEach(function (item, i) {
        if (!item.item_order) item.item_order = String(i + 1);
      });
    });

    return { dts: dts, errors: errors };
  }

  /**
   * Menyusun objek `data` untuk payload Asta:
   * { ...kolom header, line_items: [ {...kolom item} ] }
   */
  function buildAstaData(dt) {
    const data = Object.assign({}, dt.header);
    data[ITEMS_KEY] = (dt.items || []).map(function (item, i) {
      const it = Object.assign({}, item);
      if (!it.item_order) it.item_order = String(i + 1);
      return it;
    });
    return data;
  }

  function buildAstaPayload(templateId, dt) {
    return { template_id: templateId, data: buildAstaData(dt) };
  }

  return {
    ITEMS_KEY: ITEMS_KEY,
    normalizeKey: normalizeKey,
    toText: toText,
    formatDate: formatDate,
    rowsToDts: rowsToDts,
    buildAstaData: buildAstaData,
    buildAstaPayload: buildAstaPayload,
  };
});
