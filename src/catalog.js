// The real Shopify catalogue, keyed by Shopify variant ID (SKUs in the store
// aren't unique, so they can't be used to tell products apart).
//  - Gift packs open up into their items (rice, noodles, ...) so a shop can be
//    short of 1-2 items and still take the order.
//  - Bundles and single groceries are one stock item each: "v:<variantId>".
import { RAW } from './catalog-raw.js';
import { PACKS } from './packs.js';
import { BUNDLE_CONTENTS } from './bundles.js';

export function buildCatalog(raw = RAW, packs = PACKS) {
  const byName = new Map(packs.map((p) => [p.name, p]));
  const byVariant = new Map();
  for (const row of raw.split('^')) {
    const [id, price, grams, kind, title] = row.split('~');
    const pack = kind === 'P' ? byName.get(title) : null;
    byVariant.set(id, {
      variantId: id, title, price: Number(price), grams: Number(grams),
      kind: kind === 'P' ? 'pack' : kind === 'B' ? 'bundle' : 'item',
      packageId: pack?.id ?? null,
      contents: kind === 'B' ? BUNDLE_CONTENTS[title] ?? null : null,
    });
  }
  // Everything a shop can hold in stock, for its stock screen.
  const stock = new Map();
  for (const p of packs) for (const i of p.items) if (!stock.has(i.sku)) stock.set(i.sku, { sku: i.sku, name: i.name, group: 'Gift pack items' });
  for (const v of byVariant.values()) if (v.kind !== 'pack') stock.set(`v:${v.variantId}`, { sku: `v:${v.variantId}`, name: v.title, group: v.kind === 'bundle' ? 'Essentials bundles (ready to pack)' : 'Groceries' });
  return { byVariant, packs: new Map(packs.map((p) => [p.id, p])), stockItems: [...stock.values()] };
}
