import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from '../src/engine.js';
import { config } from '../src/config.js';
import { loadPackages, stockFor } from '../src/data.js';

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 15, 1, 0);
const CEBU = { lat: 10.3111, lng: 123.8916, island: 'Cebu' };
const packages = loadPackages();
const tipid = packages.find((p) => p.id === '888-TIPID');
const sku = (word) => tipid.items.find((i) => i.name.includes(word)).sku;

// A Tipid-stocked shop with some items taken out.
function shopWithout(id, words, extra = {}) {
  const stock = stockFor(packages, ['888-TIPID'], 3);
  for (const w of words) stock[sku(w)] = 0;
  return { id, island: 'Cebu', lat: 10.3111, lng: 123.8916, stock, ...extra };
}
const HUB = { id: 'hub', hub: true, island: 'Luzon', lat: 14.6, lng: 121, stock: stockFor(packages, ['888-TIPID'], 50) };
const make = (shops) => new Dispatcher({ packages, shops: [HUB, ...shops], config });
const offerTo = (d, order, shop) => d.offers.find((o) => o.orderId === order && o.shopId === shop && o.status === 'pending');

test('a shop short of 1-2 items gets the offer, with the missing list', () => {
  const d = make([shopWithout('short', ['Nescaf', 'Corned'])]);
  d.placeOrder({ id: 'P1', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const o = offerTo(d, 'P1', 'short');
  assert.ok(o, 'short shop was asked');
  assert.deepEqual(o.missing.map((m) => m.sku).sort(), [sku('Corned'), sku('Nescaf')].sort());
});

test('a shop short of 3 items is not asked', () => {
  const d = make([shopWithout('short3', ['Nescaf', 'Corned', 'Tuna'])]);
  d.placeOrder({ id: 'P2', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  assert.equal(offerTo(d, 'P2', 'short3'), undefined);
  assert.equal(d.orders.get('P2').shopId, 'hub');
});

test('a shop short of items worth more than half the pack is not asked', () => {
  const cfg = { ...config, partial: { ...config.partial, maxMissingValuePct: 25 } };
  const d = new Dispatcher({ packages, shops: [HUB, shopWithout('norice', ['rice'])], config: cfg });
  d.placeOrder({ id: 'P3', packageId: '888-TIPID', address: CEBU, paidAt: T0 });  // rice = 30% of Tipid
  assert.equal(offerTo(d, 'P3', 'norice'), undefined);
});

test('full-stock shops at the same distance are asked before short ones', () => {
  const d = make([shopWithout('short', ['Nescaf']), shopWithout('full', [], { lat: 10.312 })]);
  d.placeOrder({ id: 'P4', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  assert.ok(offerTo(d, 'P4', 'full'));
  assert.equal(offerTo(d, 'P4', 'short'), undefined, 'short shop waits for the next wave');
  d.tick(T0 + 15 * MIN);
  assert.ok(offerTo(d, 'P4', 'short'), 'then it gets its chance');
});

test('short shop: accept -> cannot ship yet -> confirm items -> ship -> paid', () => {
  const d = make([shopWithout('short', ['Nescaf'])]);
  d.placeOrder({ id: 'P5', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const r = d.accept(offerTo(d, 'P5', 'short').id, T0 + 5 * MIN, { commitToSource: true });
  assert.equal(r.ok, true);
  assert.equal(r.sourceBy, T0 + 5 * MIN + 8 * HOUR);
  assert.equal(d.ship('P5', 'short', 'X', T0 + HOUR).ok, false, 'must confirm first');
  assert.equal(d.confirmSourced('P5', 'short', T0 + 3 * HOUR).ok, true);
  assert.equal(d.ship('P5', 'short', 'LALA1', T0 + 4 * HOUR).ok, true);
  d.deliver('P5', T0 + 6 * HOUR);
  assert.equal(d.orders.get('P5').payout.status, 'payable');
  const shop = d.shops.get('short');
  assert.ok(Object.values(shop.reserved).every((q) => q === 0), 'nothing left on hold');
  assert.equal(shop.stock[sku('Nescaf')], 0, 'bought-in coffee used up');
});

test('"I can\'t get the items" before the cut-off: no strike, re-offered to full-stock shops', () => {
  const d = make([shopWithout('short', ['Nescaf']), shopWithout('full', [], { lat: 10.35 })]);
  d.placeOrder({ id: 'P6', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  // The full-stock shop is asked first and declines; then the short shop gets it.
  d.decline(offerTo(d, 'P6', 'full').id, T0 + MIN);
  d.accept(offerTo(d, 'P6', 'short').id, T0 + 2 * MIN, { commitToSource: true });
  assert.equal(d.cantSource('P6', 'short', T0 + 2 * HOUR).ok, true);
  assert.equal(d.shops.get('short').strikes, 0);
  // 'full' already declined, so nobody full-stock is left -> hub, urgent.
  assert.equal(d.orders.get('P6').shopId, 'hub');
});

test('sourcing cut-off missed: a strike, then re-offered to a full-stock shop while time allows', () => {
  const far = shopWithout('full-far', [], { lat: 10.52, lng: 124.03 }); // Danao, same island
  const d = make([shopWithout('short', ['Nescaf']), far]);
  d.placeOrder({ id: 'P7', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  // Short shop ranks as 'nearby' (local + penalty), the Danao shop as 'same island' -> short shop first.
  const o = offerTo(d, 'P7', 'short');
  assert.ok(o);
  d.accept(o.id, T0 + MIN, { commitToSource: true });
  d.tick(T0 + MIN + 8 * HOUR + MIN);
  assert.equal(d.shops.get('short').strikes, 1);
  assert.ok(offerTo(d, 'P7', 'full-far'), 're-offered to the full-stock shop');
  assert.equal(d.orders.get('P7').fullOnly, true);
});

test('a shop that lost the race in the first wave is asked again when the order comes back', () => {
  const near = shopWithout('short', ['Nescaf']);
  const rival = shopWithout('rival', [], { lat: 10.37 }); // ~6.5 km, full stock: same rank as the short shop
  const d = make([near, rival]);
  d.placeOrder({ id: 'P9', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  assert.ok(offerTo(d, 'P9', 'rival'), 'both in the first wave');
  d.accept(offerTo(d, 'P9', 'short').id, T0 + MIN, { commitToSource: true });
  d.tick(T0 + MIN + 8 * HOUR + MIN); // short shop never confirms
  assert.ok(offerTo(d, 'P9', 'rival'), 'rival asked again, not sent straight to the hub');
  assert.equal(offerTo(d, 'P9', 'short'), undefined, 'the shop that failed is not');
});

test('re-offer is skipped when less than 8 hours remain: straight to hub', () => {
  const cfg = { ...config, partial: { ...config.partial, sourceWithinHours: 22 } };
  const d = new Dispatcher({ packages, shops: [HUB, shopWithout('short', ['Nescaf']), shopWithout('full-far', [], { lat: 10.52, lng: 124.03 })], config: cfg });
  d.placeOrder({ id: 'P8', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const r = d.accept(offerTo(d, 'P8', 'short').id, T0 + MIN, { commitToSource: true });
  assert.equal(r.sourceBy, T0 + 20 * HOUR, 'capped at deadline minus 4 h packing time');
  d.tick(T0 + 20 * HOUR + MIN);
  assert.equal(d.orders.get('P8').shopId, 'hub');
  assert.equal(d.orders.get('P8').urgent, true);
});

test('two short shops cannot both count the same shelf stock', () => {
  const d = make([shopWithout('short', ['Nescaf'])]);
  // Shop has 3 sets minus coffee. Three orders: each accepted as partial; a 4th has no rice left.
  for (const id of ['Q1', 'Q2', 'Q3', 'Q4']) {
    d.placeOrder({ id, packageId: '888-TIPID', address: CEBU, paidAt: T0 });
    const o = offerTo(d, id, 'short');
    if (o) d.accept(o.id, T0 + MIN, { commitToSource: true });
  }
  assert.equal(d.orders.get('Q3').shopId, 'short');
  assert.equal(d.orders.get('Q4').shopId, 'hub');
});
