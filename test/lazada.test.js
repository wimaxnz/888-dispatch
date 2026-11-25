import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Dispatcher } from '../src/engine.js';
import { config } from '../src/config.js';
import { buildCatalog } from '../src/catalog.js';
import { snapshot, restore, prune } from '../src/store.js';
import { fromLazada, skuMap, lazadaStage, lazTime, lazadaTracking, packReq, labelReq, rtsReq, packResult, rtsErrors } from '../src/lazada.js';
import { shopView, adminView } from '../src/views.js';
import { textsFor } from '../src/sms.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const catalog = buildCatalog();
const products = JSON.parse(readFileSync(new URL('./fixtures/products.json', import.meta.url), 'utf8'));
const bySku = skuMap(products.products ?? products);

// Shape of a real Lazada order (25 Nov 2026 lookup of order 1128788225184343), masked fields as Lazada sends them.
const ORDER = {
  order_id: 1128788225184343, order_number: 1128788225184343, created_at: '2026-11-20 13:57:23 +0800', price: '673.75',
  payment_method: 'COD', warehouse_code: 'dropshipping', promised_shipping_times: '',
  address_shipping: { country: 'Philippines', city: 'Iba', address1: 'P**r', phone: '6**3', first_name: 'F**n', address3: 'Z**s', post_code: '' },
};
const item = (over = {}) => ({
  order_id: 1128788225184343, order_item_id: 1, sku: '888-LUTONGBAHAY', name: '888 Grocery Lutong-Bahay Essentials Bundle',
  item_price: 673.75, paid_price: 624.75, status: 'pending', warehouse_code: 'dropshipping', payment_time: Date.UTC(2026, 10, 20, 5, 57),
  package_id: 'FP072713139722778', shipping_type: 'Dropshipping', shipment_provider: 'Pickup: J&T Express PH, Delivery: J&T Express PH',
  tracking_code: '', promised_shipping_time: '', ...over,
});

function engine() {
  return new Dispatcher({
    packages: [...catalog.packs.values()], config: structuredClone(config),
    shops: [
      { id: 'hub', name: '888 Hub', city: 'Manila', island: 'Luzon', lat: 14.5995, lng: 120.9842, hub: true, stock: {} },
      { id: 'iba', name: 'Iba Sari-Sari', city: 'Iba', island: 'Luzon', lat: 15.327, lng: 119.978, phone: '09171234567', stock: {}, lazadaWarehouse: 'WH-IBA' },
    ],
  });
}
const shopForWarehouse = (d) => (code) => [...d.shops.values()].find((s) => s.lazadaWarehouse && s.lazadaWarehouse === code)?.id ?? null;

test('Lazada times and stages', () => {
  assert.equal(lazTime('2026-11-20 13:57:23 +0800'), Date.UTC(2026, 10, 20, 5, 57, 23));
  assert.equal(lazadaStage([item()]), 'new');
  assert.equal(lazadaStage([item({ status: 'ready_to_ship' })]), 'shipped');
  assert.equal(lazadaStage([item({ status: 'delivered' })]), 'delivered');
  assert.equal(lazadaStage([item({ status: 'canceled' })]), 'cancelled');
  assert.equal(lazadaTracking([item({ tracking_code: '820173487498' })]), '820173487498');
});

test('a Lazada bundle order from a shop warehouse goes straight to that shop, no waves', () => {
  const d = engine();
  const r = fromLazada(ORDER, [item({ warehouse_code: 'WH-IBA' })], { catalog, bySku, shopForWarehouse: shopForWarehouse(d) });
  assert.ok(r.order, JSON.stringify(r));
  assert.equal(r.order.id, 'LZ-1128788225184343');
  assert.equal(r.order.extra.recipient.city, 'Iba');
  assert.match(r.package.name, /Lutong-Bahay/);
  assert.equal(r.package.price, 673.75);
  d.packages.set(r.package.id, r.package);
  const o = d.assignDirect(r.order);
  assert.equal(o.status, 'assigned');
  assert.equal(o.shopId, 'iba');
  assert.equal(d.offers.filter((x) => x.orderId === o.id && x.status === 'pending').length, 0, 'no offers sent to other shops');
  const v = shopView(d, 'iba', catalog, o.paidAt + HOUR);
  const mine = v.orders.find((x) => x.id === o.id);
  assert.equal(mine.stage, 'pack');
  assert.equal(mine.source, 'lazada');
  assert.ok(mine.missing.length > 0, 'shop with empty stock sees what it lacks');
  const texts = textsFor(d.events, d);
  assert.equal(texts.length, 1);
  assert.match(texts[0].message, /LAZADA ORDER/);
});

test('the main warehouse (not linked to a shop) goes to the 888 hub', () => {
  const d = engine();
  const r = fromLazada(ORDER, [item()], { catalog, bySku, shopForWarehouse: shopForWarehouse(d) });
  d.packages.set(r.package.id, r.package);
  const o = d.assignDirect(r.order);
  assert.equal(o.shopId, 'hub');
  assert.ok(d.events.some((e) => e.type === 'to_hub'));
});

test('unknown Lazada SKU becomes a manual order for the owner', () => {
  const d = engine();
  const r = fromLazada(ORDER, [item({ sku: '888-NOT-A-THING' })], { catalog, bySku, shopForWarehouse: shopForWarehouse(d) });
  assert.ok(r.manual);
  assert.match(r.manual.reason, /888-NOT-A-THING/);
});

test('a gift pack sold on Lazada opens into its items; two units count as qty 2', () => {
  const d = engine();
  const r = fromLazada(ORDER, [item({ sku: '888-TIPID', item_price: 1867.14, warehouse_code: 'WH-IBA' }), item({ order_item_id: 2, sku: '888-TIPID', item_price: 1867.14, warehouse_code: 'WH-IBA' })],
    { catalog, bySku, shopForWarehouse: shopForWarehouse(d) });
  assert.ok(r.order, JSON.stringify(r));
  assert.match(r.package.name, /^2 × Tipid/);
  assert.ok(r.package.items.length > 3);
});

test('Lazada cancel releases the shop stock, texts the shop, and is cleaned up later', () => {
  const d = engine();
  const shop = d.shops.get('iba');
  const r = fromLazada(ORDER, [item({ warehouse_code: 'WH-IBA' })], { catalog, bySku, shopForWarehouse: shopForWarehouse(d) });
  for (const it of r.package.items) shop.stock[it.sku] = 10;
  d.packages.set(r.package.id, r.package);
  const o = d.assignDirect(r.order);
  assert.ok(Object.values(shop.reserved).some((q) => q > 0));
  const before = d.events.length;
  assert.equal(d.cancel(o.id, o.paidAt + HOUR, 'Lazada: canceled').ok, true);
  assert.ok(Object.values(shop.reserved).every((q) => q === 0));
  assert.match(textsFor(d.events.slice(before), d)[0].message, /CANCELLED/);
  assert.equal(adminView(d, {}, o.paidAt + HOUR).orders.find((x) => x.id === o.id).stage, 'cancelled');
  const d2 = restore(JSON.parse(JSON.stringify(snapshot(d))));
  prune(d2, o.paidAt + 20 * DAY);
  assert.equal(d2.orders.has(o.id), false);
});

test('Lazada says shipped then delivered: the shop gets paid if on time', () => {
  const d = engine();
  const shop = d.shops.get('iba');
  const r = fromLazada(ORDER, [item({ warehouse_code: 'WH-IBA' })], { catalog, bySku, shopForWarehouse: shopForWarehouse(d) });
  for (const it of r.package.items) shop.stock[it.sku] = 10;
  d.packages.set(r.package.id, r.package);
  const o = d.assignDirect(r.order);
  assert.equal(d.ship(o.id, 'iba', '820173487498', o.paidAt + 5 * HOUR).ok, true);
  d.deliver(o.id, o.paidAt + 3 * DAY);
  assert.equal(d.orders.get(o.id).payout.status, 'payable');
  assert.equal(d.orders.get(o.id).payout.amount, r.package.shopPayout);
});

test('shipping requests match the shape Lazada documents (Pack, PrintAWB, ReadyToShip)', () => {
  assert.deepEqual(packReq(1128788225184343, [111, '222']), {
    pack_order_list: [{ order_item_list: ['111', '222'], order_id: '1128788225184343' }], delivery_type: 'dropship', shipping_allocate_type: 'TFS' });
  assert.deepEqual(labelReq(['FP1']), { doc_type: 'PDF', print_item_list: true, packages: [{ package_id: 'FP1' }] });
  assert.deepEqual(rtsReq(['FP1', 'FP2']), { packages: [{ package_id: 'FP1' }, { package_id: 'FP2' }] });
});

test('pack answer gives the package, J&T tracking and any item errors', () => {
  const ok = { code: '0', result: { success: 'true', data: { pack_order_list: [{ order_id: '1', order_item_list: [
    { order_item_id: '11', msg: 'success', item_err_code: '0', tracking_number: 'JT123', shipment_provider: 'J&T Express', package_id: 'FP9' },
    { order_item_id: '12', msg: 'success', item_err_code: '0', tracking_number: 'JT123', shipment_provider: 'J&T Express', package_id: 'FP9' }] }] } } };
  assert.deepEqual(packResult(ok), { packageIds: ['FP9'], tracking: 'JT123', provider: 'J&T Express', errors: [] });
  const bad = { code: '0', result: { success: 'true', data: { pack_order_list: [{ order_id: '1', order_item_list: [
    { order_item_id: '11', msg: 'item current status not allow to pack', item_err_code: '700026', package_id: '' }] }] } } };
  assert.deepEqual(packResult(bad).packageIds, []);
  assert.deepEqual(packResult(bad).errors, ['item current status not allow to pack']);
});

test('ready-to-ship answer: errors only when Lazada reports them', () => {
  assert.deepEqual(rtsErrors({ result: { success: 'true', data: { packages: [{ package_id: 'FP9', item_err_code: '0', msg: 'success' }] } } }), []);
  assert.deepEqual(rtsErrors({ result: { success: 'true', data: { packages: [{ package_id: 'FP9', item_err_code: '600002', msg: 'package already cancelled' }] } } }), ['package already cancelled']);
});

test('a new Lazada order keeps its item ids (needed to pack it) and the shop sees the shipping steps', () => {
  const items = [item({ order_item_id: 901, warehouse_code: 'WH-IBA' }), item({ order_item_id: 902, warehouse_code: 'WH-IBA' })];
  const d = engine();
  const r = fromLazada(ORDER, items, { catalog, bySku, shopForWarehouse: shopForWarehouse(d) });
  assert.deepEqual(r.order.extra.lazada.itemIds, ['901', '902']);
  d.packages.set(r.package.id, r.package);
  const o = d.assignDirect({ ...r.order, address: { lat: 15.327, lng: 119.978, island: 'Luzon' } });
  o.lazada = { ...o.lazada, packageIds: ['FP9'], tracking: 'JT123', packedAt: 1, labelAt: 2 };
  const mine = shopView(d, 'iba', catalog, Date.now()).orders.find((x) => x.id === o.id);
  assert.equal(mine.lazada.tracking, 'JT123');
  assert.equal(mine.lazada.labelAt, 2);
});
