// Lazada orders -> 888 dispatch.
// Each partner shop is set up as its own Lazada warehouse (Seller Center -> Setting -> Warehouse), so
// Lazada's multi-warehouse routing picks the nearest shop with stock and J&T picks up there. We read the
// order through the Lazada Open Platform (app "888 Grocery Shop Tools") and hand it to that shop.
// Lazada masks the buyer's name, phone and street; the shop doesn't need them because the Lazada
// shipping label carries the full address. Only the city is used, to show the area.
import { locate } from './places.js';
import { PAYOUT } from './shopify.js';

// Lazada item statuses, grouped by what they mean for us.
const NEW = ['pending', 'unpaid', 'packed', 'repacked', 'topack', 'toship'];
const SHIPPED = ['ready_to_ship', 'ready_to_ship_pending', 'shipped'];
const DELIVERED = ['delivered', 'confirmed'];
const CANCELLED = ['canceled', 'cancelled', 'failed', 'returned', 'shipped_back', 'shipped_back_success', 'lost_by_3pl', 'damaged_by_3pl'];

export function lazadaStage(items) {
  const st = (items ?? []).map((i) => String(i.status ?? '').toLowerCase());
  if (!st.length) return 'unknown';
  if (st.every((s) => CANCELLED.includes(s))) return 'cancelled';
  if (st.some((s) => DELIVERED.includes(s))) return 'delivered';
  if (st.some((s) => SHIPPED.includes(s))) return 'shipped';
  if (st.some((s) => NEW.includes(s))) return 'new';
  return 'unknown';
}

// Lazada time "2026-11-20 13:57:23 +0800" -> ms.
export function lazTime(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return s;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2})(\d{2})$/);
  const t = Date.parse(m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : s);
  return Number.isFinite(t) ? t : null;
}

// order: Lazada /order/get data; items: /order/items/get data.
// bySku: Map(seller SKU -> Shopify variant id) built from the Shopify product list.
// shopForWarehouse: (warehouseCode) -> shop id or null (null = 888 hub).
export function fromLazada(order, items, { catalog, bySku, shopForWarehouse, payout = PAYOUT }) {
  const ref = `LZ-${order.order_id ?? order.order_number}`;
  const a = order.address_shipping ?? {};
  const paidAt = Number(items?.find((i) => i.payment_time)?.payment_time) || lazTime(order.created_at) || Date.now();
  const lines = (items ?? []).filter((i) => !CANCELLED.includes(String(i.status ?? '').toLowerCase()));
  const warehouse = lines[0]?.warehouse_code ?? order.warehouse_code ?? null;
  const recipient = { name: '(on the Lazada label)', phone: '', address: '(on the Lazada label)', city: a.city ?? '', province: '', zip: a.post_code ?? '' };
  const lazada = {
    orderId: String(order.order_id), warehouse, payment: order.payment_method ?? '', packageIds: [...new Set(lines.map((i) => i.package_id).filter(Boolean))],
    itemIds: lines.map((i) => String(i.order_item_id)).filter((x) => x && x !== 'undefined'),
    shippingType: lines[0]?.shipping_type ?? '', provider: lines[0]?.shipment_provider ?? '',
  };
  const manual = (reason) => ({
    manual: { id: `M-${ref}`, ref, paidAt, reason, recipient, buyer: { country: 'Philippines' }, note: 'Lazada order', source: 'lazada', lazada,
      items: lines.map((i) => ({ title: i.name, qty: 1 })), status: 'todo' },
  });
  if (!lines.length) return { skip: 'nothing to ship' };

  // Lazada lists one row per unit; count them per SKU.
  const qtyBySku = new Map();
  for (const i of lines) qtyBySku.set(i.sku, (qtyBySku.get(i.sku) ?? 0) + 1);
  const unknown = [...qtyBySku.keys()].filter((sku) => !catalog.byVariant.has(String(bySku.get(sku))));
  if (unknown.length) return manual(`Lazada product not in the 888 catalogue yet: ${unknown.join(', ')}`);

  const shopId = shopForWarehouse(warehouse);
  const items2 = new Map();
  const add = (sku, name, qty, unit) => { const x = items2.get(sku); if (x) x.qty += qty; else items2.set(sku, { sku, name, qty, unit }); };
  let price = 0, grams = 0;
  const lineSummary = [];
  for (const [sku, qty] of qtyBySku) {
    const c = catalog.byVariant.get(String(bySku.get(sku)));
    const paid = lines.filter((i) => i.sku === sku).reduce((t, i) => t + Number(i.item_price ?? i.paid_price ?? 0), 0);
    price += paid || c.price * qty;
    grams += c.grams * qty;
    lineSummary.push({ title: c.title, qty, kind: c.kind, contents: c.contents });
    if (c.kind === 'pack') for (const i of catalog.packs.get(c.packageId).items) add(i.sku, i.name, i.qty * qty, i.unit);
    else add(`v:${c.variantId}`, c.title, qty, c.price);
  }
  const where = locate({ city: a.city, province: '' });
  const pkg = {
    id: `ORDER-${ref}`, name: lineSummary.map((l) => `${l.qty > 1 ? `${l.qty} × ` : ''}${l.title}`).join(', '),
    price, weightKg: grams / 1000, items: [...items2.values()],
    shopPayout: Math.round(price * payout.share + payout.packingFee),
  };
  const promised = lazTime(lines.find((i) => i.promised_shipping_time)?.promised_shipping_time ?? order.promised_shipping_times);
  return {
    package: pkg,
    order: {
      id: ref, packageId: pkg.id, qty: 1, paidAt, shopId, deadline: promised ?? undefined,
      address: where ? { lat: where.lat, lng: where.lng, island: where.island } : null,
      extra: { source: 'lazada', lazada, ref, recipient, buyer: { country: 'Philippines' }, note: '', lines: lineSummary,
        locatedBy: where?.source ?? 'warehouse', charged: { amount: Number(order.price ?? price), currency: 'PHP' } },
    },
  };
}

// Bundles that are sold on Lazada under their own SKU but live in the 888 catalogue as these variants.
export const LAZADA_BUNDLES = {
  '888-LUTONGBAHAY': '44542312120381', '888-ULAM': '44542312054845', '888-ULAMPAMILYA': '44542312087613',
  '888-LINISBAHAY': '44542312022077', '888-UMAGA': '44542311989309', '888-PAMILYA-B': '44542311956541',
  '888-ARAWARAW': '44542311923773', '888-SALOSALO': '44542311891005', '888-TREATS': '44542312185917',
};

// Seller SKU -> Shopify variant id, from Shopify products (Admin or storefront JSON shape: variants[].sku / id),
// plus the Lazada-only bundle SKUs above.
export function skuMap(products) {
  const m = new Map(Object.entries(LAZADA_BUNDLES));
  for (const p of products ?? []) for (const v of p.variants ?? []) if (v.sku) m.set(String(v.sku), String(v.id));
  return m;
}

// Tracking number Lazada gave the parcel, if any.
export const lazadaTracking = (items) => (items ?? []).map((i) => i.tracking_code).find(Boolean) ?? null;

// ---- Shipping from 888 Dispatch (pack -> label -> ready to ship), Lazada's Fulfillment API ----
// Request bodies exactly as Lazada documents them (open.lazada.com: Pack, PrintAWB, ReadyToShip).
export const packReq = (orderId, itemIds) => ({
  pack_order_list: [{ order_item_list: itemIds.map(String), order_id: String(orderId) }],
  delivery_type: 'dropship', shipping_allocate_type: 'TFS',
});
export const labelReq = (packageIds) => ({ doc_type: 'PDF', print_item_list: true, packages: packageIds.map((package_id) => ({ package_id })) });
export const rtsReq = (packageIds) => ({ packages: packageIds.map((package_id) => ({ package_id })) });

// Pack answer -> { packageIds, tracking, provider, errors[] }.
export function packResult(r) {
  const rows = (r?.result?.data?.pack_order_list ?? []).flatMap((o) => o.order_item_list ?? []);
  const ok = rows.filter((x) => String(x.item_err_code ?? '0') === '0' && x.package_id);
  const errors = rows.filter((x) => String(x.item_err_code ?? '0') !== '0').map((x) => x.msg || x.item_err_code);
  if (!rows.length && r?.result?.error_msg) errors.push(r.result.error_msg);
  return {
    packageIds: [...new Set(ok.map((x) => x.package_id))],
    tracking: ok.map((x) => x.tracking_number).find(Boolean) ?? null,
    provider: ok.map((x) => x.shipment_provider).find(Boolean) ?? null,
    errors,
  };
}
// Ready-to-ship answer -> errors[] (empty = all good).
export function rtsErrors(r) {
  const rows = r?.result?.data?.packages ?? [];
  const errs = rows.filter((x) => String(x.item_err_code ?? '0') !== '0').map((x) => x.msg || x.item_err_code);
  if (!rows.length && r?.result?.success !== true && r?.result?.success !== 'true' && r?.result?.error_msg) errs.push(r.result.error_msg);
  return errs;
}
