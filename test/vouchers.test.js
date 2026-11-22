import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { itemsFromProducts, buildPack, priceBatch, validateBatch, voucherCode, prefixFor, voucherState, voucherPackage,
  cleanRecipient, forecast, PACK_DAYS, DAY } from '../src/vouchers.js';
import { Dispatcher } from '../src/engine.js';
import { config } from '../src/config.js';
import { loadPackages, sampleShops } from '../src/data.js';

const products = JSON.parse(readFileSync(new URL('./fixtures/products.json', import.meta.url))).products;
const items = itemsFromProducts(products);
const T0 = Date.UTC(2026, 11, 1);

test('only single groceries go into packs (no gift packs, bundles, rice sacks or adult milk)', () => {
  assert.ok(items.length > 60);
  assert.ok(items.every((i) => !/pack$|bundle|essentials|25kg|ensure/i.test(i.title)), items.map((i) => i.title).filter((t) => /pack$|bundle|essentials/i.test(t)).join());
});

test('a pack never costs more than the money, uses nearly all of it, and starts with rice', () => {
  for (const nzd of [40, 60, 80, 100, 150, 190, 400]) {
    const { goodsPhp } = priceBatch({ budgetNzd: nzd, nzdToPhp: 34, deliveryPhp: 150 });
    const p = buildPack(goodsPhp, items);
    assert.ok(p.total <= goodsPhp, `NZ$${nzd}: ${p.total} > ${goodsPhp}`);
    assert.ok(p.unused < 60, `NZ$${nzd}: ₱${p.unused} left over`);
    assert.match(p.lines[0].title, /rice 5kg/i, `NZ$${nzd}`);
    assert.ok(p.lines.every((l) => l.qty <= 3));
  }
});

test('same money gives the same pack (so the forecast holds)', () => {
  assert.deepEqual(buildPack(2570, items), buildPack(2570, [...items].reverse()));
});

test('NZ$ to pesos: budget minus delivery is what goes in the box', () => {
  assert.deepEqual(priceBatch({ budgetNzd: 80, nzdToPhp: 34, deliveryPhp: 150 }), { budgetPhp: 2720, goodsPhp: 2570 });
});

test('batch checks', () => {
  const ok = { company: 'Xtra Staff NZ', budgetNzd: 80, qty: 60, nzdToPhp: 34, deliveryPhp: 150 };
  assert.equal(validateBatch(ok), null);
  assert.match(validateBatch({ ...ok, company: ' ' }), /company/);
  assert.match(validateBatch({ ...ok, budgetNzd: 10 }), /between/);
  assert.match(validateBatch({ ...ok, qty: 0 }), /between/);
  assert.match(validateBatch({ ...ok, logo: 'data:text/html;base64,xx' }), /Logo/);
});

test('voucher codes read well and carry the company initials', () => {
  assert.equal(prefixFor('Xtra Staff New Zealand'), 'XSN');
  assert.equal(prefixFor('Fonterra'), 'FON');
  const c = voucherCode('XSN', new Uint8Array([0, 1, 2, 3, 4, 31]));
  assert.match(c, /^XSN-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  assert.ok(!/[01IO]/.test(c.slice(4)));
});

test('pack for 3 months, then shop credit; nothing works before the company pays', () => {
  const b = { paid: false, created_at: new Date(T0).toISOString() };
  const v = { status: 'issued', issued_at: null };
  assert.equal(voucherState(v, b, T0), 'not_active');
  const paid = { ...b, paid: true, paid_at: new Date(T0).toISOString() };
  const iv = { ...v, issued_at: paid.paid_at };
  assert.equal(voucherState(iv, paid, T0 + 10 * DAY), 'pack');
  assert.equal(voucherState(iv, paid, T0 + (PACK_DAYS + 1) * DAY), 'credit');
  assert.equal(voucherState({ ...iv, status: 'redeemed' }, paid, T0 + 500 * DAY), 'redeemed');
});

test('family details: name, PH mobile and address are required', () => {
  assert.match(cleanRecipient({}).error, /name/);
  assert.match(cleanRecipient({ name: 'Rosa', phone: '12345' }).error, /mobile/);
  assert.match(cleanRecipient({ name: 'Rosa', phone: '0917 555 0142' }).error, /address/);
  const ok = cleanRecipient({ name: ' Rosa  Dela Cruz ', phone: '0917 555 0142', address: 'Purok 3', city: 'Talisay City', province: 'Cebu' });
  assert.equal(ok.recipient.name, 'Rosa Dela Cruz');
});

test('a redeemed voucher becomes a normal dispatch order that shops see item by item', () => {
  const pack = buildPack(2570, items);
  const batch = { company: 'Xtra Staff NZ', pack };
  const pkg = voucherPackage('XSN-ABC-DEF', batch);
  assert.equal(pkg.id, 'ORDER-V-XSN-ABC-DEF');
  assert.equal(pkg.items.length, pack.lines.length);
  assert.ok(pkg.items.every((i) => i.sku.startsWith('v:')));
  const d = new Dispatcher({ packages: loadPackages(), shops: sampleShops(loadPackages()), config });
  d.packages.set(pkg.id, pkg);
  d.placeOrder({ id: 'V-XSN-ABC-DEF', packageId: pkg.id, address: { lat: 10.3111, lng: 123.8916, island: 'Cebu' }, paidAt: T0 });
  assert.ok(d.orders.has('V-XSN-ABC-DEF'));
});

test('forecast adds up the items still owed', () => {
  const pack = { total: 100, kg: 1, lines: [{ variantId: '1', title: 'Rice', qty: 1 }, { variantId: '2', title: 'Noodles', qty: 2 }] };
  const b = { id: 'B1', paid: true, paid_at: new Date(T0).toISOString(), pack };
  const vs = [
    { batch_id: 'B1', status: 'issued', issued_at: b.paid_at },
    { batch_id: 'B1', status: 'issued', issued_at: b.paid_at },
    { batch_id: 'B1', status: 'redeemed', issued_at: b.paid_at },
  ];
  const f = forecast([b], vs, T0 + DAY);
  assert.equal(f.open, 2); assert.equal(f.redeemed, 1);
  assert.deepEqual(f.items.map((i) => [i.title, i.qty]), [['Noodles', 4], ['Rice', 2]]);
});

import { splitAmount, voucherPayments, roundTo10, cleanBuyer, BATCH_PROP } from '../src/vouchers.js';

test('self-service: totals split into ₱1,000 / ₱100 / ₱10 credit and add back up', () => {
  assert.deepEqual(splitAmount(163_230), [{ denom: 1000, qty: 163 }, { denom: 100, qty: 2 }, { denom: 10, qty: 3 }]);
  assert.deepEqual(splitAmount(2720), [{ denom: 1000, qty: 2 }, { denom: 100, qty: 7 }, { denom: 10, qty: 2 }]);
  assert.throws(() => splitAmount(2725));
  assert.equal(roundTo10(2720.4), 2730);
  assert.equal(roundTo10(2720), 2720);
});

test('self-service: a paid order is matched to its batch by the hidden line property', () => {
  const order = { line_items: [
    { price: '1000.00', quantity: 2, properties: [{ name: BATCH_PROP, value: 'B-1' }] },
    { price: '100.00', quantity: 7, properties: [{ name: BATCH_PROP, value: 'B-1' }] },
    { price: '10.00', quantity: 2, properties: [{ name: BATCH_PROP, value: 'B-1' }] },
    { price: '1499.86', quantity: 1, properties: [] },
  ] };
  assert.deepEqual([...voucherPayments(order)], [['B-1', 2720]]);
});

test('self-service: buyer needs an email', () => {
  assert.match(cleanBuyer({ name: 'Ana' }).error, /email/);
  assert.equal(cleanBuyer({ email: ' Ana@Example.com ' }).buyer.email, 'ana@example.com');
});

import { voucherPhp, validateSelf } from '../src/vouchers.js';

test('buyer currency: NZ$100 / A$100 / US$100 become a fixed peso value, rounded up to ₱10', () => {
  assert.deepEqual(voucherPhp(100, 35.12), { php: 3520 });
  assert.deepEqual(voucherPhp(100, 58.4), { php: 5840 });
  assert.match(voucherPhp(10, 35).error, /at least/);
  assert.match(voucherPhp(5000, 58).error, /too high/);
  assert.match(voucherPhp(0, 35).error, /Choose/);
});

test('buyer currency: order checks', () => {
  const ok = { company: 'Xtra Staff', qty: 10, currency: 'NZD' };
  assert.equal(validateSelf(ok), null);
  assert.match(validateSelf({ ...ok, currency: 'nz' }), /currency/);
  assert.match(validateSelf({ ...ok, qty: 501 }), /500/);
});
