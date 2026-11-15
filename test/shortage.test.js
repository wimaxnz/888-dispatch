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
const item = (w) => tipid.items.find((i) => i.name.includes(w));
const shop = (id, without, lat = 10.3111) => {
  const stock = stockFor(packages, ['888-TIPID'], 3);
  for (const w of without) stock[item(w).sku] = 0;
  return { id, island: 'Cebu', lat, lng: 123.8916, stock };
};
const HUB = { id: 'hub', hub: true, island: 'Luzon', lat: 14.6, lng: 121, stock: stockFor(packages, ['888-TIPID'], 50) };
const make = (...shops) => new Dispatcher({ packages, shops: [HUB, ...shops], config });
const offer = (d, order, s) => d.offers.find((o) => o.orderId === order && o.shopId === s && o.status === 'pending');

test('a short shop must tick the promise to buy in the items', () => {
  const d = make(shop('a', ['Nescaf']));
  d.placeOrder({ id: 'S1', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const o = offer(d, 'S1', 'a');
  assert.equal(d.accept(o.id, T0 + MIN).ok, false);
  assert.equal(d.accept(o.id, T0 + MIN, { commitToSource: true }).ok, true);
});

test('2 shops cannot get the same item -> item dropped, buyer refunded and told, shop re-asked', () => {
  const d = make(shop('a', ['Nescaf']), shop('b', ['Nescaf'], 10.312));
  d.placeOrder({ id: 'S2', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  d.decline(offer(d, 'S2', 'a').id, T0 + MIN, 'shortage');
  d.decline(offer(d, 'S2', 'b').id, T0 + 2 * MIN, 'shortage');
  const order = d.orders.get('S2');
  const coffee = item('Nescaf');
  assert.deepEqual(order.dropped.map((x) => x.sku), [coffee.sku]);
  const itemsValue = tipid.items.reduce((t, i) => t + i.qty * i.unit, 0);
  const expectedRefund = Math.round((tipid.price * coffee.unit * coffee.qty) / itemsValue);
  assert.equal(order.refund, expectedRefund);
  const note = d.events.find((e) => e.type === 'customer_notified');
  assert.match(note.message, /Nescaf/);
  assert.ok(note.message.includes(`₱${expectedRefund}`));
  // Both shops have everything else, so they're asked again, now as full-stock.
  const again = offer(d, 'S2', 'a');
  assert.ok(again);
  assert.equal(again.missing.length, 0);
  const lessCoffee = tipid.shopPayout - coffee.unit * coffee.qty;
  assert.equal(again.payout, lessCoffee, 'shop paid less the dropped item');
  assert.equal(d.accept(again.id, T0 + 3 * MIN).ok, true, 'no promise needed now');
  d.ship('S2', 'a', 'LALA', T0 + 2 * HOUR);
  d.deliver('S2', T0 + 3 * HOUR);
  assert.equal(order.payout.amount, lessCoffee);
  assert.equal(d.shops.get('a').stock[coffee.sku], 0, 'no coffee taken from stock it never had');
});

test('a late third "can\'t get it" after the item is dropped does not refund or message twice', () => {
  const d = make(shop('a', ['Nescaf']), shop('b', ['Nescaf'], 10.312), shop('c', ['Nescaf'], 10.313));
  d.placeOrder({ id: 'S5', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const [oa, ob, oc] = ['a', 'b', 'c'].map((s) => offer(d, 'S5', s));
  d.decline(oa.id, T0 + MIN, 'shortage');
  d.decline(ob.id, T0 + MIN, 'shortage');
  const refund = d.orders.get('S5').refund;
  d.decline(oc.id, T0 + 2 * MIN, 'shortage'); // its old offer still listed the coffee
  assert.equal(d.orders.get('S5').refund, refund);
  assert.equal(d.orders.get('S5').dropped.length, 1);
  assert.equal(d.events.filter((e) => e.type === 'customer_notified').length, 1);
});

test('declining because busy does not count as a shortage', () => {
  const d = make(shop('a', ['Nescaf']), shop('b', ['Nescaf'], 10.312));
  d.placeOrder({ id: 'S3', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  d.decline(offer(d, 'S3', 'a').id, T0 + MIN, 'busy');
  d.decline(offer(d, 'S3', 'b').id, T0 + MIN, 'busy');
  assert.equal(d.orders.get('S3').dropped.length, 0);
});

test('different items short at different shops are not dropped', () => {
  const d = make(shop('a', ['Nescaf']), shop('b', ['Corned'], 10.312));
  d.placeOrder({ id: 'S4', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  d.decline(offer(d, 'S4', 'a').id, T0 + MIN, 'shortage');
  d.decline(offer(d, 'S4', 'b').id, T0 + MIN, 'shortage');
  assert.equal(d.orders.get('S4').dropped.length, 0);
  assert.equal(d.orders.get('S4').shopId, 'hub', 'nobody left -> hub sends the full pack');
});
