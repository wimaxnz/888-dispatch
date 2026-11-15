import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from '../src/engine.js';
import { Subscriptions, advance } from '../src/subscriptions.js';
import { config } from '../src/config.js';
import { loadPackages, sampleShops } from '../src/data.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 15, 1, 0); // 15 Nov 2026, 9 am PH
const CEBU = { lat: 10.3111, lng: 123.8916, island: 'Cebu' };
const ph = (t) => new Date(t + 8 * HOUR).toISOString().slice(0, 10);

function setup(chargeResults = []) {
  const packages = loadPackages();
  const d = new Dispatcher({ packages, shops: sampleShops(packages), config });
  const charges = [];
  const charge = (s, now) => { charges.push(now); return { ok: chargeResults.length ? chargeResults.shift() : true }; };
  return { d, subs: new Subscriptions({ dispatcher: d, charge, config }), charges };
}
const run = (subs, d, from, to, step = HOUR) => { for (let t = from; t <= to; t += step) { subs.tick(t); d.tick(t); } };

test('monthly keeps the same day; the 31st becomes the last day in short months', () => {
  const jan31 = Date.UTC(2027, 0, 31, 1); // 31 Jan, 9 am PH
  const feb = advance(jan31, 'month', 31);
  const mar = advance(feb, 'month', 31);
  assert.equal(ph(feb), '2027-02-28');
  assert.equal(ph(mar), '2027-03-31');
});

test('weekly: charged and dispatched every 7 days', () => {
  const { d, subs, charges } = setup();
  subs.create({ id: 'SUB1', buyer: 'maria', packageId: '888-TIPID', address: CEBU, every: 'week', startAt: T0 });
  run(subs, d, T0, T0 + 15 * DAY);
  assert.equal(charges.length, 3);
  assert.deepEqual(subs.get('SUB1').history, ['SUB1-1', 'SUB1-2', 'SUB1-3']);
  assert.equal(d.orders.get('SUB1-2').subscription, 'SUB1');
  assert.ok(d.offers.some((o) => o.orderId === 'SUB1-3'), 'goes through dispatch like any order');
});

test('reminder 2 days before each charge', () => {
  const { d, subs } = setup();
  subs.create({ id: 'SUB2', buyer: 'jun', packageId: '888-TIPID', address: CEBU, every: 'month', startAt: T0 + 10 * DAY });
  run(subs, d, T0, T0 + 10 * DAY);
  const r = d.events.find((e) => e.type === 'sub_reminder');
  assert.ok(r);
  assert.equal(r.at, T0 + 8 * DAY);
});

test('skip next delivery', () => {
  const { d, subs, charges } = setup();
  subs.create({ id: 'SUB3', buyer: 'x', packageId: '888-TIPID', address: CEBU, every: 'week', startAt: T0 });
  subs.skipNext('SUB3', T0 - DAY);
  run(subs, d, T0, T0 + 8 * DAY);
  assert.equal(charges.length, 1);
  assert.equal(charges[0], T0 + 7 * DAY);
});

test('card declined: retried daily, paused after 3 tries, resume does not back-charge', () => {
  const { d, subs, charges } = setup([false, false, false]);
  subs.create({ id: 'SUB4', buyer: 'x', packageId: '888-TIPID', address: CEBU, every: 'week', startAt: T0 });
  run(subs, d, T0, T0 + 3 * DAY);
  assert.equal(charges.length, 3);
  assert.equal(subs.get('SUB4').status, 'paused');
  subs.resume('SUB4', T0 + 20 * DAY);
  assert.equal(subs.get('SUB4').nextAt, T0 + 21 * DAY);
});

test('a retry that succeeds keeps the original weekly day', () => {
  const { d, subs } = setup([false, true]);
  subs.create({ id: 'SUB5', buyer: 'x', packageId: '888-TIPID', address: CEBU, every: 'week', startAt: T0 });
  run(subs, d, T0, T0 + 2 * DAY);
  assert.equal(subs.get('SUB5').count, 1);
  assert.equal(subs.get('SUB5').nextAt, T0 + 7 * DAY);
});

test('cancel stops all future deliveries', () => {
  const { d, subs, charges } = setup();
  subs.create({ id: 'SUB6', buyer: 'x', packageId: '888-TIPID', address: CEBU, every: 'week', startAt: T0 });
  run(subs, d, T0, T0 + DAY);
  subs.cancel('SUB6', T0 + 2 * DAY);
  run(subs, d, T0 + 2 * DAY, T0 + 30 * DAY, 6 * HOUR);
  assert.equal(charges.length, 1);
});

test('skipping while a card retry is pending cancels that retry', () => {
  const { d, subs, charges } = setup([false]);
  subs.create({ id: 'SUB7', buyer: 'x', packageId: '888-TIPID', address: CEBU, every: 'week', startAt: T0 });
  run(subs, d, T0, T0 + HOUR);
  assert.equal(charges.length, 1);
  subs.skipNext('SUB7', T0 + 2 * HOUR);
  run(subs, d, T0 + 2 * HOUR, T0 + 6 * DAY);
  assert.equal(charges.length, 1, 'no retry charge after skipping');
  assert.equal(subs.get('SUB7').nextAt, T0 + 7 * DAY);
});
