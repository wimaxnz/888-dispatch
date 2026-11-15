import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from '../src/engine.js';
import { config } from '../src/config.js';
import { loadPackages, sampleShops, stockFor } from '../src/data.js';

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 15, 0, 0);
// Delivery address near Fuente Osmeña, Cebu City.
const CEBU = { lat: 10.3111, lng: 123.8916, island: 'Cebu' };
const MANILA = { lat: 14.5547, lng: 121.0244, island: 'Luzon' };

const make = (shops) => {
  const packages = loadPackages();
  return new Dispatcher({ packages, shops: shops ?? sampleShops(packages), config });
};
const sentTo = (d, orderId) => d.offers.filter((o) => o.orderId === orderId && o.status === 'pending').map((o) => o.shopId);

test('nearest shops with full stock get the first wave', () => {
  const d = make();
  d.placeOrder({ id: 'A', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const wave = sentTo(d, 'A');
  assert.equal(wave.length, 3);
  assert.ok(wave.includes('cebu-colon'));
  assert.ok(!wave.includes('danao'), 'far shop should wait');
  assert.ok(!wave.includes('qc'), 'Manila shop should wait');
});

test('a shop missing most of the pack is never asked', () => {
  const d = make();
  // Lahug only stocks Tipid packs, so it can't do Almusal.
  d.placeOrder({ id: 'B', packageId: '888-ALMUSAL', address: CEBU, paidAt: T0 });
  for (let t = T0; t < T0 + 5 * HOUR; t += 5 * MIN) d.tick(t);
  assert.ok(!d.offers.some((o) => o.orderId === 'B' && o.shopId === 'cebu-lahug'));
});

test('first accept wins and the other offers are cancelled', () => {
  const d = make();
  d.placeOrder({ id: 'C', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const [a, b] = d.offers.filter((o) => o.orderId === 'C');
  assert.equal(d.accept(a.id, T0 + MIN).ok, true);
  const second = d.accept(b.id, T0 + 2 * MIN);
  assert.equal(second.ok, false);
  assert.equal(d.orders.get('C').shopId, a.shopId);
});

test('if nobody answers, the next wave goes further out', () => {
  const d = make();
  d.placeOrder({ id: 'D', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const first = sentTo(d, 'D');
  d.tick(T0 + 15 * MIN);
  const second = sentTo(d, 'D');
  assert.ok(second.length > 0);
  assert.ok(second.every((s) => !first.includes(s)), 'no shop asked twice');
});

test('everyone declining moves on at once, without waiting for the timer', () => {
  const d = make();
  d.placeOrder({ id: 'E', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  for (const o of d.offers.filter((x) => x.orderId === 'E')) d.decline(o.id, T0 + MIN);
  assert.equal(d.orders.get('E').wave, 2);
});

test('Cebu exhausted -> other islands -> 888 hub last', () => {
  const d = make();
  d.placeOrder({ id: 'F', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const rings = [];
  for (let t = T0; d.orders.get('F').status === 'dispatching'; t += 15 * MIN) {
    rings.push(...d.offers.filter((o) => o.orderId === 'F' && o.status === 'pending').map((o) => o.ring));
    d.tick(t + 15 * MIN);
  }
  assert.equal(rings.at(-1), 'other island');
  assert.ok(rings.indexOf('other island') > rings.lastIndexOf('same island'));
  assert.equal(d.orders.get('F').shopId, 'hub-manila');
});

test('time guard: no taker after 6 hours goes to the hub', () => {
  const packages = loadPackages();
  const shops = [
    { id: 'hub', hub: true, island: 'Luzon', lat: 14.6, lng: 121, stock: {} },
    // 30 shops so the waves can't run out within 6 hours.
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`, island: 'Cebu', lat: 10.3 + i * 0.001, lng: 123.9, stock: stockFor(packages, ['888-TIPID'], 1),
    })),
  ];
  const d = new Dispatcher({ packages, shops, config: { ...config, offerMinutes: 60 } });
  d.placeOrder({ id: 'G', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  for (let t = T0; t <= T0 + 6 * HOUR; t += 10 * MIN) d.tick(t);
  assert.equal(d.orders.get('G').shopId, 'hub');
  assert.ok(d.events.some((e) => e.type === 'to_hub' && e.reason === 'time guard reached'));
});

test('accepted stock is reserved, so a shop with 2 packs can take only 2 orders', () => {
  const packages = loadPackages();
  const shops = [
    { id: 'hub', hub: true, island: 'Luzon', lat: 14.6, lng: 121, stock: {} },
    { id: 'only', island: 'Cebu', lat: 10.31, lng: 123.89, stock: stockFor(packages, ['888-TIPID'], 2) },
  ];
  const d = new Dispatcher({ packages, shops, config });
  for (const id of ['H1', 'H2', 'H3']) {
    d.placeOrder({ id, packageId: '888-TIPID', address: CEBU, paidAt: T0 });
    const o = d.offers.find((x) => x.orderId === id && x.status === 'pending');
    if (o) d.accept(o.id, T0 + MIN);
  }
  assert.equal(d.orders.get('H1').shopId, 'only');
  assert.equal(d.orders.get('H2').shopId, 'only');
  assert.equal(d.orders.get('H3').shopId, 'hub');
});

test('ship on time + delivered = payout payable', () => {
  const d = make();
  d.placeOrder({ id: 'I', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const o = d.offers.find((x) => x.orderId === 'I');
  d.accept(o.id, T0 + MIN);
  assert.equal(d.ship('I', o.shopId, 'LALA123', T0 + 20 * HOUR).ok, true);
  d.deliver('I', T0 + 30 * HOUR);
  assert.equal(d.orders.get('I').payout.status, 'payable');
  assert.equal(d.orders.get('I').payout.amount, o.payout);
});

test('missed 24 h deadline: no pay, a strike, order to hub as urgent', () => {
  const d = make();
  d.placeOrder({ id: 'J', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const o = d.offers.find((x) => x.orderId === 'J');
  d.accept(o.id, T0 + MIN);
  d.tick(T0 + 24 * HOUR + MIN);
  const order = d.orders.get('J');
  assert.equal(order.shopId, 'hub-manila');
  assert.equal(order.urgent, true);
  assert.equal(d.shops.get(o.shopId).strikes, 1);
  assert.equal(d.ship('J', o.shopId, 'LATE', T0 + 25 * HOUR).ok, false);
  assert.ok(Object.values(d.shops.get(o.shopId).reserved).every((q) => q === 0), 'reservation released');
});

test('3 strikes suspends the shop', () => {
  const packages = loadPackages();
  const shops = [
    { id: 'hub', hub: true, island: 'Luzon', lat: 14.6, lng: 121, stock: {} },
    { id: 'lazy', island: 'Cebu', lat: 10.31, lng: 123.89, stock: stockFor(packages, ['888-TIPID'], 10) },
  ];
  const d = new Dispatcher({ packages, shops, config });
  for (let i = 0; i < 3; i++) {
    const t = T0 + i * 30 * HOUR;
    d.placeOrder({ id: `K${i}`, packageId: '888-TIPID', address: CEBU, paidAt: t });
    d.accept(d.offers.find((x) => x.orderId === `K${i}`).id, t + MIN);
    d.tick(t + 25 * HOUR);
  }
  assert.equal(d.shops.get('lazy').active, false);
  d.placeOrder({ id: 'K4', packageId: '888-TIPID', address: CEBU, paidAt: T0 + 100 * HOUR });
  assert.equal(d.orders.get('K4').shopId, 'hub');
});

test('Manila order goes to the Manila shop, not Cebu', () => {
  const d = make();
  d.placeOrder({ id: 'L', packageId: '888-TIPID', address: MANILA, paidAt: T0 });
  assert.deepEqual(sentTo(d, 'L'), ['qc']);
});

test('a 2-pack order needs double stock', () => {
  const d = make();
  // Lahug has exactly 2 Tipid sets: OK for qty 2, not for qty 3.
  d.placeOrder({ id: 'M', packageId: '888-TIPID', qty: 3, address: { lat: 10.3302, lng: 123.9001, island: 'Cebu' }, paidAt: T0 });
  assert.ok(!sentTo(d, 'M').includes('cebu-lahug'));
});
