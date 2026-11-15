// A shop that is short of 1-2 items can ship without them: it is paid only for
// what it sends, and the buyer chooses a refund or having the rest sent later.
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
const shop = (id, without = [], lat = 10.3111) => {
  const stock = stockFor(packages, ['888-TIPID'], 3);
  for (const w of without) stock[item(w).sku] = 0;
  return { id, island: 'Cebu', lat, lng: 123.8916, stock };
};
const HUB = { id: 'hub', hub: true, island: 'Luzon', lat: 14.6, lng: 121, stock: stockFor(packages, ['888-TIPID'], 50) };
const make = (...shops) => new Dispatcher({ packages, shops: [HUB, ...shops], config });
const offer = (d, order, s) => d.offers.find((o) => o.orderId === order && o.shopId === s && o.status === 'pending');
const itemsValue = tipid.items.reduce((t, i) => t + i.qty * i.unit, 0);

test('a shop can leave an item unticked and ship without it: paid less, buyer asked', () => {
  const d = make(shop('a'));
  d.placeOrder({ id: 'W1', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const coffee = item('Nescaf');
  const r = d.accept(offer(d, 'W1', 'a').id, T0 + MIN, { mode: 'without', notHave: [coffee.sku] });
  assert.equal(r.ok, true);
  const o = d.orders.get('W1');
  assert.deepEqual(o.dropped.map((x) => x.sku), [coffee.sku]);
  assert.equal(o.refund, Math.round((tipid.price * coffee.qty * coffee.unit) / itemsValue));
  assert.equal(o.buyerChoice.status, 'ask');
  assert.equal(o.offer.payout, tipid.shopPayout - coffee.qty * coffee.unit, 'shop is paid only for what it sends');
  assert.equal(d.shops.get('a').stock[coffee.sku], 0, 'stock corrected: the shop said it has none');
  assert.ok(!o.sourcing, 'nothing to buy in');
  assert.match(d.events.find((e) => e.type === 'customer_notified').message, /refund .* or shall we send it later/);
  d.ship('W1', 'a', 'LLM-1', T0 + HOUR);
  d.deliver('W1', T0 + 2 * HOUR);
  assert.equal(o.payout.amount, tipid.shopPayout - coffee.qty * coffee.unit);
});

test('with something missing the shop must choose: buy in, or send without', () => {
  const d = make(shop('a', ['Nescaf']));
  d.placeOrder({ id: 'W2', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const of = offer(d, 'W2', 'a');
  assert.equal(d.accept(of.id, T0 + MIN).ok, false);
  assert.equal(of.status, 'pending', 'offer stays open so the shop can choose');
  assert.equal(d.accept(of.id, T0 + MIN, { mode: 'without' }).ok, true);
  assert.equal(d.orders.get('W2').dropped.length, 1);
});

test('the safety limit still applies: 3 unticked items cannot be accepted', () => {
  const d = make(shop('a'));
  d.placeOrder({ id: 'W3', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const of = offer(d, 'W3', 'a');
  const r = d.accept(of.id, T0 + MIN, { mode: 'without', notHave: ['Nescaf', 'Corned', 'Tuna'].map((w) => item(w).sku) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /too many/);
  assert.equal(of.status, 'pending');
});

test('buyer chooses "send later": a new delivery with just the missing items goes out', () => {
  const d = make(shop('a'), shop('b', [], 10.312));
  d.placeOrder({ id: 'W4', packageId: '888-TIPID', address: CEBU, paidAt: T0, extra: { recipient: { name: 'Rosa' } } });
  const coffee = item('Nescaf');
  d.accept(offer(d, 'W4', 'a').id, T0 + MIN, { mode: 'without', notHave: [coffee.sku] });
  const r = d.buyerChoice('W4', 'later', T0 + HOUR);
  assert.equal(r.ok, true);
  const b = d.orders.get('W4-B');
  assert.ok(b, 'follow-up order created');
  assert.deepEqual(d.need(b).map((n) => n.sku), [coffee.sku]);
  assert.equal(b.recipient.name, 'Rosa');
  assert.equal(d.pkg(b).shopPayout, Math.round(d.orders.get('W4').refund * tipid.shopPayout / tipid.price), 'same pay rate as the original');
  assert.ok(d.offers.some((o) => o.orderId === 'W4-B' && o.shopId === 'b'), 'offered to the shop that has it');
  assert.equal(d.orders.get('W4').buyerChoice.status, 'later');
  assert.equal(d.buyerChoice('W4', 'refund', T0 + 2 * HOUR).ok, false, 'decided only once');
});

test('buyer chooses refund', () => {
  const d = make(shop('a'));
  d.placeOrder({ id: 'W5', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  d.accept(offer(d, 'W5', 'a').id, T0 + MIN, { mode: 'without', notHave: [item('Nescaf').sku] });
  const r = d.buyerChoice('W5', 'refund', T0 + HOUR);
  assert.equal(r.ok, true);
  assert.equal(r.refund, d.orders.get('W5').refund);
  assert.equal(d.orders.get('W5').buyerChoice.status, 'refund');
});

test('a shop that ticks an item its stock list says it lacks is trusted', () => {
  const d = make(shop('a', ['Nescaf']));
  d.placeOrder({ id: 'W6', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const coffee = item('Nescaf');
  const r = d.accept(offer(d, 'W6', 'a').id, T0 + MIN, { confirmHave: [coffee.sku] });
  assert.equal(r.ok, true);
  assert.equal(d.orders.get('W6').dropped.length, 0);
  assert.ok(!d.orders.get('W6').sourcing, 'nothing to buy in');
  assert.equal(d.shops.get('a').reserved[coffee.sku], coffee.qty);
});
