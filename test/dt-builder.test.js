'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rowsToDts, buildAstaPayload } = require('../src/shared/dt-builder');

test('mengelompokkan item per DT dan menyusun payload Asta', () => {
  const header = [
    { 'No DT': 'DT-1', Tanggal: new Date(2026, 10, 3), customer_name: 'PT A', lokasi_tujuan: 'Balikpapan' },
    { 'No DT': 'DT-2', Tanggal: new Date(2026, 10, 4), customer_name: 'PT A', lokasi_tujuan: 'Duri' },
  ];
  const items = [
    { no_dt: 'DT-1', description: 'ABC', aku: '01', qty: 4 },
    { no_dt: 'DT-1', description: 'Cable Lug', aku: '15', qty: 20 },
    { no_dt: 'DT-2', description: 'ABC', aku: '01', qty: 2 },
  ];
  const { dts, errors } = rowsToDts(header, items);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(dts.length, 2);
  assert.strictEqual(dts[0].items.length, 2);
  const p = buildAstaPayload('TPL-007', dts[0]);
  assert.strictEqual(p.template_id, 'TPL-007');
  assert.strictEqual(p.data.no_dt, 'DT-1');
  assert.strictEqual(p.data.tanggal, '03-11-2026');
  assert.deepStrictEqual(p.data.line_items[1], { description: 'Cable Lug', aku: '15', qty: '20', item_order: '2' });
});

test('validasi: no_dt dobel, item yatim, DT tanpa item, qty salah', () => {
  const header = [{ no_dt: 'A' }, { no_dt: 'A' }, { no_dt: 'B' }, { no_dt: '' , customer_name: 'x'}];
  const items = [
    { no_dt: 'A', description: 'x', qty: 0 },
    { no_dt: 'Z', description: 'y', qty: 1 },
    { no_dt: '', description: '', qty: '' },
  ];
  const { dts, errors } = rowsToDts(header, items);
  assert.strictEqual(dts.length, 2);
  assert.ok(dts[0].errors.some((e) => e.includes('lebih dari sekali')));
  assert.ok(dts[0].errors.some((e) => e.includes('qty')));
  assert.ok(dts[1].errors.some((e) => e.includes('tidak punya item')));
  assert.ok(errors.some((e) => e.includes('"Z"')));
  assert.ok(errors.some((e) => e.includes('Header baris 5')));
});
