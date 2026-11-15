import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Dispatcher } from '../src/engine.js';
import { config } from '../src/config.js';
import { loadPackages, sampleShops } from '../src/data.js';
import { snapshot, restore, prune } from '../src/store.js';
import { fromShopify, verifyShopify } from '../src/shopify.js';
import { locate } from '../src/places.js';
import { buildCatalog } from '../src/catalog.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 15, 1, 0);
const packages = loadPackages();
const CEBU = { lat: 10.3111, lng: 123.8916, island: 'Cebu' };

test('save and load keeps everything, including who was asked and the accepted offer', () => {
  const d = new Dispatcher({ packages, shops: sampleShops(packages), config });
  d.placeOrder({ id: 'A', packageId: '888-TIPID', address: CEBU, paidAt: T0 });
  const of = d.offers.find((o) => o.orderId === 'A');
  d.accept(of.id, T0 + MIN);
  const d2 = restore(JSON.parse(JSON.stringify(snapshot(d))));
  const o = d2.orders.get('A');
  assert.equal(o.offer, d2.offers.find((x) => x.id === of.id), 'offer is the same object as in the list');
  assert.ok(o.asked instanceof Set && o.asked.has(of.shopId));
  assert.deepEqual(d2.shops.get(of.shopId).reserved, d.shops.get(of.shopId).reserved);
  // The loaded engine keeps working.
  assert.equal(d2.ship('A', of.shopId, 'X', T0 + HOUR).ok, true);
  d2.deliver('A', T0 + 2 * HOUR);
  assert.equal(d2.orders.get('A').payout.status, 'payable');
});

test('prune drops old paid-up orders but keeps ones still owed', () => {
  const d = new Dispatcher({ packages, shops: sampleShops(packages), config });
  for (const id of ['P1', 'P2']) {
    d.placeOrder({ id, packageId: '888-TIPID', address: CEBU, paidAt: T0 });
    const of = d.offers.find((o) => o.orderId === id && o.status === 'pending');
    d.accept(of.id, T0 + MIN); d.ship(id, of.shopId, 'X', T0 + HOUR); d.deliver(id, T0 + 2 * HOUR);
  }
  d.orders.get('P1').payout.status = 'paid';
  prune(d, T0 + 20 * DAY);
  assert.ok(!d.orders.has('P1'));
  assert.ok(d.orders.has('P2'), 'still owed to the shop');
  assert.ok(d.offers.every((o) => d.orders.has(o.orderId)));
});

const catalog = buildCatalog();
const V = (title) => [...catalog.byVariant.values()].find((v) => v.title === title).variantId;
const shopifyOrder = (over = {}) => ({
  id: 5550001, name: '#1042', processed_at: '2026-11-15T02:00:00Z',
  shipping_address: { name: 'Rosa Dela Cruz', phone: '0917 555 0142', address1: 'Purok 3', address2: 'Brgy. Lawaan II', city: 'Talisay City', province: 'Cebu', country_code: 'PH', latitude: 10.2501, longitude: 123.8467 },
  billing_address: { country: 'New Zealand' },
  line_items: [{ variant_id: Number(V('Tipid Starter Pack')), quantity: 2, price: '1400.00', title: 'Tipid Starter Pack', grams: 8500 }],
  ...over,
});

test('the catalogue knows all 9 gift packs and opens them into items', () => {
  const packs = [...catalog.byVariant.values()].filter((v) => v.kind === 'pack');
  assert.equal(packs.length, 9);
  assert.ok(packs.every((p) => catalog.packs.has(p.packageId)), 'every Shopify pack matches a pack definition');
  assert.equal([...catalog.byVariant.values()].filter((v) => v.kind === 'bundle' && v.contents).length, 9);
});

test('a Shopify order becomes one dispatch order with the real price, address and items', () => {
  const r = fromShopify(shopifyOrder(), catalog);
  assert.equal(r.order.id, '1042');
  assert.deepEqual(r.order.address, { lat: 10.2501, lng: 123.8467, island: 'Cebu' });
  assert.equal(r.package.price, 2800);
  assert.equal(r.package.weightKg, 17);
  const rice = r.package.items.find((i) => i.name.includes('rice'));
  assert.equal(rice.qty, 2, 'two packs = two bags of rice');
  assert.equal(r.package.shopPayout, Math.round(2800 * 0.7 + 50));
  assert.equal(r.order.extra.recipient.address, 'Purok 3, Brgy. Lawaan II');
});

test('packs, bundles and single groceries in one Shopify order become one delivery', () => {
  const r = fromShopify(shopifyOrder({ line_items: [
    { variant_id: Number(V('Tipid Starter Pack')), quantity: 1, price: '1400', title: 'Tipid' },
    { variant_id: Number(V('Ulam Essentials')), quantity: 1, price: '500', title: 'Ulam Essentials' },
    { variant_id: Number(V('Spam Luncheon Meat Classic 340g')), quantity: 3, price: '400', title: 'Spam' }] }), catalog);
  assert.equal(r.package.price, 1400 + 500 + 1200);
  assert.ok(r.package.items.some((i) => i.sku === `v:${V('Spam Luncheon Meat Classic 340g')}` && i.qty === 3));
  assert.ok(r.package.items.some((i) => i.sku === `v:${V('Ulam Essentials')}`));
  assert.equal(r.order.extra.lines.length, 3);
});

test('unknown products, foreign addresses and unplaceable addresses go to the 888 team', () => {
  assert.match(fromShopify(shopifyOrder({ line_items: [{ variant_id: 1, quantity: 1, price: '9', title: 'Mystery' }] }), catalog).manual.reason, /Mystery/);
  assert.match(fromShopify(shopifyOrder({ shipping_address: { country_code: 'NZ' } }), catalog).manual.reason, /outside/);
  assert.match(fromShopify(shopifyOrder({ shipping_address: { city: 'Nowhere', province: 'Atlantis', country_code: 'PH' } }), catalog).manual.reason, /place/);
});

test('no map point from Shopify: falls back to the city', () => {
  const r = fromShopify(shopifyOrder({ shipping_address: { name: 'X', city: 'Mandaue City', province: 'Cebu', country_code: 'PH' } }), catalog);
  assert.equal(r.order.address.island, 'Cebu');
  assert.equal(r.order.extra.locatedBy, 'city');
  assert.equal(locate({ city: 'Somewhere', province: 'Davao del Sur' }).island, 'Mindanao');
});

test('a Shopify order runs through the engine: a shop with the items gets the offer', () => {
  const r = fromShopify(shopifyOrder(), catalog);
  const stock = {}; for (const i of r.package.items) stock[i.sku] = i.qty;
  const d = new Dispatcher({ packages: [...catalog.packs.values()], config, shops: [
    { id: 'hub', hub: true, island: 'Luzon', lat: 14.6, lng: 121, stock: {} },
    { id: 'talisay', island: 'Cebu', lat: 10.2447, lng: 123.8494, stock }] });
  d.packages.set(r.package.id, r.package);
  d.placeOrder(r.order);
  assert.ok(d.offers.some((o) => o.orderId === '1042' && o.shopId === 'talisay'));
  assert.equal(d.orders.get('1042').recipient.name, 'Rosa Dela Cruz');
});

test('Shopify signature check accepts the real signature and rejects anything else', async () => {
  const body = JSON.stringify(shopifyOrder());
  const good = createHmac('sha256', 'test-secret').update(body).digest('base64');
  assert.equal(await verifyShopify(body, good, 'test-secret'), true);
  assert.equal(await verifyShopify(body + ' ', good, 'test-secret'), false);
  assert.equal(await verifyShopify(body, good, 'other'), false);
  assert.equal(await verifyShopify(body, null, 'test-secret'), false);
});


test('shop and admin views: a shop sees its offer but not the address until it accepts', async () => {
  const { shopView, adminView } = await import('../src/views.js');
  const r = fromShopify(shopifyOrder(), catalog);
  const stock = {}; for (const i of r.package.items) stock[i.sku] = i.qty;
  const d = new Dispatcher({ packages: [...catalog.packs.values()], config, shops: [
    { id: 'hub', hub: true, island: 'Luzon', lat: 14.6, lng: 121, stock: {} },
    { id: 'talisay', name: 'Talisay', island: 'Cebu', lat: 10.2447, lng: 123.8494, stock }] });
  d.packages.set(r.package.id, r.package);
  d.placeOrder(r.order);
  let v = shopView(d, 'talisay', catalog, T0);
  assert.equal(v.offers.length, 1);
  assert.equal(JSON.stringify(v.offers).includes('Purok 3'), false, 'no address in the offer');
  d.accept(v.offers[0].id, T0 + MIN);
  v = shopView(d, 'talisay', catalog, T0);
  assert.equal(v.orders[0].recipient.address, 'Purok 3, Brgy. Lawaan II');
  assert.equal(v.orders[0].stage, 'pack');
  assert.ok(v.stock.length > 150);
  const a = adminView(d, { manual: [], payments: [] }, T0);
  assert.equal(a.orders[0].shopName, 'Talisay');
  assert.equal(a.orders[0].sale, 2800);
});
