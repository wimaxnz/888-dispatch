import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from '../src/engine.js';
import { config } from '../src/config.js';
import { loadPackages, stockFor } from '../src/data.js';
import { normalizePH, textsFor, manualText } from '../src/sms.js';

const T0 = Date.UTC(2026, 10, 15, 1, 0);
const CEBU = { lat: 10.3111, lng: 123.8916, island: 'Cebu' };
const packages = loadPackages();

test('Philippine mobile numbers in any common format; others refused', () => {
  assert.equal(normalizePH('0917 123 4567'), '639171234567');
  assert.equal(normalizePH('+63 917-123-4567'), '639171234567');
  assert.equal(normalizePH('639171234567'), '639171234567');
  assert.equal(normalizePH('9171234567'), '639171234567');
  assert.equal(normalizePH('+64 21 123 4567'), null, 'New Zealand numbers are not sent to');
  assert.equal(normalizePH(''), null);
});

test('each shop with a mobile gets a text for its offer; shops without one are skipped', () => {
  const d = new Dispatcher({ packages, config, shops: [
    { id: 'hub', hub: true, island: 'Luzon', lat: 14.6, lng: 121, stock: {} },
    { id: 'a', name: 'A', phone: '0917 111 2222', island: 'Cebu', lat: 10.3111, lng: 123.8916, stock: stockFor(packages, ['888-TIPID'], 2) },
    { id: 'b', name: 'B', island: 'Cebu', lat: 10.312, lng: 123.8916, stock: stockFor(packages, ['888-TIPID'], 2) }] });
  d.placeOrder({ id: 'S1', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const texts = textsFor(d.events, d);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].to, '639171112222');
  assert.match(texts[0].message, /^888 NEW ORDER: Tipid Starter Pack, [\d.]+ km away, you earn P[\d,]+\. Open your 888 shop page/);
  assert.ok(texts[0].message.length <= 160, 'fits one text');
  assert.ok(!/₱/.test(texts[0].message), 'no peso sign, so it stays one cheap SMS');
});

test('the owner is texted only when an owner number is set', () => {
  const d = new Dispatcher({ packages, config, shops: [{ id: 'hub', hub: true, island: 'Luzon', lat: 14.6, lng: 121, stock: {} }] });
  d.placeOrder({ id: 'S2', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  d.toHub(d.orders.get('S2'), T0, 'test', true);
  assert.equal(textsFor(d.events, d).length, 0);
  const t = textsFor(d.events, d, { ownerPhone: '09181234567' });
  assert.equal(t.length, 1);
  assert.match(t[0].message, /URGENT: order S2/);
  assert.match(manualText({ ref: '1042', reason: 'Address is outside the Philippines' }, '09181234567').message, /order 1042 needs you/);
  assert.equal(manualText({ ref: '1', reason: 'x' }, null), null);
});
