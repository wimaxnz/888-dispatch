// Turns a paid Shopify order into ONE dispatch order, so each family gets one
// delivery. Gift packs open up into their items; bundles and single groceries
// are one item each. The order becomes its own "package" in the engine.
// Orders that can't be dispatched (outside the Philippines, unknown product,
// address we can't place) become manual orders for the 888 team.
import { locate } from './places.js';

export const PAYOUT = { share: 0.7, packingFee: 50 }; // shop earns 70% of the goods price + ₱50 packing

export function fromShopify(o, catalog, payout = PAYOUT) {
  const paidAt = Date.parse(o.processed_at ?? o.created_at ?? '') || Date.now();
  const a = o.shipping_address ?? {};
  const recipient = {
    name: a.name ?? [a.first_name, a.last_name].filter(Boolean).join(' '),
    phone: a.phone ?? o.phone ?? '',
    address: [a.address1, a.address2].filter(Boolean).join(', '),
    city: a.city ?? '', province: a.province ?? '', zip: a.zip ?? '',
  };
  const buyer = { country: o.billing_address?.country ?? o.customer?.default_address?.country ?? '' };
  const ref = String(o.name ?? o.order_number ?? o.id).replace('#', '');
  const lines = (o.line_items ?? []).filter((li) => li.quantity > 0 && li.requires_shipping !== false);
  const where = locate(a);
  const note = o.note ?? '';

  const manual = (reason) => ({
    manual: { id: `M-${ref}`, shopifyId: o.id, ref, paidAt, reason, recipient, buyer, note,
      items: lines.map((li) => ({ title: li.title, qty: li.quantity })), status: 'todo' },
  });

  if ((a.country_code ?? 'PH') !== 'PH') return manual('Address is outside the Philippines');
  if (!lines.length) return { skip: 'nothing to ship' };
  const unknown = lines.filter((li) => !catalog.byVariant.has(String(li.variant_id)));
  if (unknown.length) return manual(`Not in the 888 catalogue yet: ${unknown.map((li) => li.title).join(', ')}`);
  if (!where) return manual(`Couldn't place the address (${recipient.city}, ${recipient.province})`);

  const items = new Map();
  const add = (sku, name, qty, unit) => {
    const x = items.get(sku);
    if (x) x.qty += qty; else items.set(sku, { sku, name, qty, unit });
  };
  let price = 0, grams = 0;
  const lineSummary = [];
  for (const li of lines) {
    const c = catalog.byVariant.get(String(li.variant_id));
    // Prices come from the 888 peso catalogue: Shopify sends them in the store's
    // base currency (NZD), which isn't what shops are paid in.
    price += c.price * li.quantity;
    grams += (li.grams || c.grams) * li.quantity;
    lineSummary.push({ title: c.title, qty: li.quantity, kind: c.kind, contents: c.contents });
    if (c.kind === 'pack') for (const i of catalog.packs.get(c.packageId).items) add(i.sku, i.name, i.qty * li.quantity, i.unit);
    else add(`v:${c.variantId}`, c.title, li.quantity, c.price);
  }
  const pkg = {
    id: `ORDER-${ref}`, name: lineSummary.map((l) => `${l.qty > 1 ? `${l.qty} × ` : ''}${l.title}`).join(', '),
    price, weightKg: grams / 1000, items: [...items.values()],
    shopPayout: Math.round(price * payout.share + payout.packingFee),
  };
  return {
    package: pkg,
    order: {
      id: ref, packageId: pkg.id, qty: 1, paidAt,
      address: { lat: where.lat, lng: where.lng, island: where.island },
      extra: { shopifyId: o.id, ref, recipient, buyer, note, lines: lineSummary, locatedBy: where.source,
        charged: { amount: Number(o.total_price ?? 0), currency: o.currency ?? '' } },
    },
  };
}

// Shopify signs each webhook: base64 HMAC-SHA256 of the raw body with the shared secret.
export async function verifyShopify(rawBody, header, secret) {
  if (!header || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  const expected = btoa(bin);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}
