// Company gift vouchers (pack vouchers).
// A company says "NZ$80 per staff member, 60 staff". We turn the money into a
// fixed grocery pack from the live 888 shop, make one voucher per person, and
// when the family enters an address the voucher becomes a normal dispatch order.
//  - The pack is fixed when the batch is made, so stock can be forecast.
//  - Pack can be claimed for PACK_DAYS. After that the voucher is shop credit
//    of the same value that never expires.

export const PACK_DAYS = 90;
export const DAY = 86_400_000;

export const VOUCHER_DEFAULTS = {
  nzdToPhp: 34,        // rough rate; the owner sets the real one per batch
  deliveryPhp: 150,    // what we keep aside for the courier (Lazada-like rate)
  minNzd: 30,
  maxNzd: 2000,
};

// The order a pack is filled in: a family staple from each group first, then
// round and round the groups until the money is used up.
export const PACK_GROUPS = [
  'Rice', 'Canned Meat', 'Noodles & Pasta', 'Coffee, Milk & Breakfast', 'Canned Fish',
  'Cooking Oil, Sugar & Salt', 'Condiments, Sauces & Seasonings', 'Biscuits & Crackers',
  'Snacks & Chips', 'Canned Fruits & Vegetables',
];
// Big or odd items we never put in an automatic pack.
const SKIP = /25kg|sack|ensure|anlene|glutinous|malagkit|brown rice/i;
// What families look for first, best first. Anything not listed comes after.
export const STAPLES = [
  /well-milled rice 5kg/i, /corned beef/i, /pancit canton/i, /sardines in tomato/i, /3-in-1|twin pack/i,
  /cooking oil|vegetable oil/i, /soy sauce 1l/i, /luncheon meat/i, /tuna flakes/i, /instant mami/i,
  /spaghetti sauce|pasta.*set/i, /bear brand|birch tree/i, /milo/i, /vinegar/i, /white sugar/i,
  /skyflakes/i, /fruit cocktail/i, /condensada|evaporada/i, /piattos|nova/i, /patis/i, /vienna sausage/i,
  /magic sarap|knorr/i, /oatmeal|koko krunch/i, /cream-o|fudgee|lemon square|hansel|bingo/i,
];
const rank = (t) => { const i = STAPLES.findIndex((r) => r.test(t)); return i < 0 ? STAPLES.length : i; };

// Shopify's public /products.json -> the single groceries we can pack.
export function itemsFromProducts(products) {
  const out = [];
  for (const p of products ?? []) {
    if (!PACK_GROUPS.includes(p.product_type) || SKIP.test(p.title)) continue;
    const v = (p.variants ?? []).find((x) => x.available !== false) ?? p.variants?.[0];
    if (!v) continue;
    const price = Number(v.price);
    if (!(price > 0)) continue;
    out.push({
      variantId: String(v.id), title: p.title, group: p.product_type, price,
      kg: (Number(v.grams) || 0) / 1000, image: p.images?.[0]?.src ?? null, handle: p.handle,
    });
  }
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Fill a pack up to `goodsPhp` (never over). Same money in -> same pack out.
export function buildPack(goodsPhp, allItems) {
  // No single item may eat more than a fifth of the money (rice aside).
  const cap = Math.max(300, goodsPhp / 5);
  const items = allItems.filter((i) => i.group === 'Rice' || i.price <= cap)
    .sort((a, b) => rank(a.title) - rank(b.title) || a.price - b.price || a.title.localeCompare(b.title));
  const byGroup = new Map(PACK_GROUPS.map((g) => [g, items.filter((i) => i.group === g)]));
  const chosen = new Map();
  let left = goodsPhp;
  const take = (i) => {
    const c = chosen.get(i.variantId);
    if (c) c.qty += 1; else chosen.set(i.variantId, { ...i, qty: 1 });
    left = round2(left - i.price);
  };
  // Rice is the heart of a Filipino grocery gift: one 5kg bag if it fits a third of the money.
  const rice = (byGroup.get('Rice') ?? []).filter((i) => /well-milled rice 5kg/i.test(i.title)).sort((a, b) => a.price - b.price || a.title.localeCompare(b.title))[0];
  if (rice && rice.price <= goodsPhp / 3) take(rice);
  // Round 1..n: each group adds its next item (a new one before repeating any).
  for (let round = 0; round < 12; round++) {
    let added = false;
    for (const g of PACK_GROUPS) {
      if (g === 'Rice') continue; // one bag of rice is enough
      const list = byGroup.get(g) ?? [];
      const fresh = list.find((i) => !chosen.has(i.variantId) && i.price <= left);
      // From round 3, a family favourite twice beats an odd new item.
      const again = round >= 2 ? [...chosen.values()].filter((c) => c.group === g && c.qty < 3 && c.price <= left && rank(c.title) < STAPLES.length)[0] : null;
      const freshIsStaple = fresh && rank(fresh.title) < STAPLES.length;
      const pick = freshIsStaple ? fresh : (again ?? fresh);
      if (pick) { take(pick); added = true; }
    }
    if (!added) break;
  }
  // Top up with the smallest items that still fit.
  const cheap = items.filter((i) => i.group !== 'Rice').sort((a, b) => rank(a.title) - rank(b.title) || a.price - b.price || a.title.localeCompare(b.title));
  for (const i of cheap) { while (i.price <= left && (chosen.get(i.variantId)?.qty ?? 0) < 3) take(i); }
  const lines = [...chosen.values()].map(({ variantId, title, group, price, kg, image, handle, qty }) => ({ variantId, title, group, price, kg, image, handle, qty }));
  const total = round2(lines.reduce((t, l) => t + l.price * l.qty, 0));
  const kg = round2(lines.reduce((t, l) => t + l.kg * l.qty, 0));
  return { lines, total, kg, unused: round2(goodsPhp - total) };
}

// NZ$ per staff -> what goes in the box.
export function priceBatch({ budgetNzd, nzdToPhp = VOUCHER_DEFAULTS.nzdToPhp, deliveryPhp = VOUCHER_DEFAULTS.deliveryPhp }) {
  const budgetPhp = round2(Number(budgetNzd) * Number(nzdToPhp));
  const goodsPhp = round2(budgetPhp - Number(deliveryPhp));
  return { budgetPhp, goodsPhp };
}

export function validateBatch(b) {
  const n = Number(b.budgetNzd), q = Number(b.qty);
  if (!String(b.company ?? '').trim()) return 'Add the company name.';
  if (!(n >= VOUCHER_DEFAULTS.minNzd && n <= VOUCHER_DEFAULTS.maxNzd)) return `Value per staff must be between NZ$${VOUCHER_DEFAULTS.minNzd} and NZ$${VOUCHER_DEFAULTS.maxNzd}.`;
  if (!(Number.isInteger(q) && q >= 1 && q <= 2000)) return 'Number of vouchers must be between 1 and 2000.';
  if (!(Number(b.nzdToPhp) > 10 && Number(b.nzdToPhp) < 100)) return 'Exchange rate looks wrong (NZ$1 = about ₱34).';
  if (!(Number(b.deliveryPhp) >= 0 && Number(b.deliveryPhp) < 2000)) return 'Delivery allowance looks wrong.';
  if (b.logo && (!/^data:image\/(png|jpeg|webp);base64,/.test(b.logo) || b.logo.length > 400_000)) return 'Logo must be a PNG or JPG under 300 KB.';
  return null;
}

// Short code printed on the voucher (no 0/O/1/I so it reads well over the phone).
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function voucherCode(prefix, rand) {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHA[rand[i] % ALPHA.length];
  return `${prefix}-${s.slice(0, 3)}-${s.slice(3)}`;
}
export function prefixFor(company) {
  const words = String(company).toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const p = (words.length > 1 ? words.map((w) => w[0]).join('') : words[0] ?? 'GV').slice(0, 3);
  return p.length >= 2 ? p : (p + 'GV').slice(0, 2);
}

// What a voucher is right now.
export function voucherState(v, batch, now) {
  if (v.status === 'redeemed') return 'redeemed';
  if (v.status === 'cancelled') return 'cancelled';
  if (!batch.paid) return 'not_active';
  const from = Date.parse(v.issued_at ?? batch.paid_at ?? batch.created_at);
  return now - from > PACK_DAYS * DAY ? 'credit' : 'pack';
}
export function packDeadline(v, batch) {
  const from = Date.parse(v.issued_at ?? batch.paid_at ?? batch.created_at);
  return new Date(from + PACK_DAYS * DAY).toISOString();
}

// The dispatch package for one redeemed voucher (shops see the real items).
export function voucherPackage(code, batch, payout = { share: 0.7, packingFee: 50 }) {
  const pack = batch.pack;
  return {
    id: `ORDER-V-${code}`,
    name: `${batch.company} gift pack`,
    price: pack.total, weightKg: pack.kg,
    items: pack.lines.map((l) => ({ sku: `v:${l.variantId}`, name: l.title, qty: l.qty, unit: l.price })),
    shopPayout: Math.round(pack.total * payout.share + payout.packingFee),
  };
}

// Clean up what the family typed.
export function cleanRecipient(r = {}) {
  const s = (x, n) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const out = { name: s(r.name, 80), phone: s(r.phone, 20), address: s(r.address, 160), barangay: s(r.barangay, 80),
    city: s(r.city, 60), province: s(r.province, 60), zip: s(r.zip, 10), note: s(r.note, 200) };
  if (out.name.length < 2) return { error: 'Please add the name of the person receiving the gift.' };
  if (!/^(\+?63|0)9\d{9}$/.test(out.phone.replace(/[\s-]/g, ''))) return { error: 'Please add a Philippine mobile number, like 0917 123 4567.' };
  if (out.address.length < 4 || out.city.length < 2 || out.province.length < 2) return { error: 'Please add the full address: street or purok, city or town, and province.' };
  return { recipient: out };
}

// Stock forecast: every voucher not yet used, opened into its items.
export function forecast(batches, vouchers, now) {
  const byBatch = new Map(batches.map((b) => [b.id, b]));
  const need = new Map();
  let open = 0, redeemed = 0, credit = 0;
  for (const v of vouchers) {
    const b = byBatch.get(v.batch_id); if (!b) continue;
    const st = voucherState(v, b, now);
    if (st === 'redeemed') { redeemed++; continue; }
    if (st === 'credit') { credit++; continue; }
    if (st !== 'pack') continue;
    open++;
    for (const l of b.pack.lines) {
      const x = need.get(l.variantId) ?? { variantId: l.variantId, title: l.title, qty: 0 };
      x.qty += l.qty; need.set(l.variantId, x);
    }
  }
  return { open, redeemed, credit, items: [...need.values()].sort((a, b) => b.qty - a.qty) };
}

// ---------- Self-service buying (the company pays in Shopify checkout) ----------
// The "Gift voucher credit" product has three variants (₱1,000 / ₱100 / ₱10).
// A batch total is paid as a mix of them, all tagged with the batch id.
export const DENOMS = [1000, 100, 10];
export const BATCH_PROP = '_voucher_batch';

// Self-service values are whole ₱10 steps, so the total splits exactly.
export const roundTo10 = (php) => Math.ceil(Number(php) / 10) * 10;

export function splitAmount(totalPhp) {
  let left = Math.round(totalPhp);
  if (left % 10) throw new Error('Total must be a multiple of ₱10');
  const out = [];
  for (const d of DENOMS) { const q = Math.floor(left / d); if (q) out.push({ denom: d, qty: q }); left -= q * d; }
  return out;
}

// From a paid Shopify order: how much was paid for each voucher batch.
export function voucherPayments(order) {
  const by = new Map();
  for (const li of order.line_items ?? []) {
    const p = (li.properties ?? []).find((x) => x.name === BATCH_PROP);
    if (!p?.value) continue;
    const paid = Number(li.price) * Number(li.quantity);
    by.set(String(p.value), Math.round(((by.get(String(p.value)) ?? 0) + paid) * 100) / 100);
  }
  return by;
}

// A buyer's own details, checked before anything is made.
export function cleanBuyer(b = {}) {
  const s = (x, n) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const out = { name: s(b.name, 80), email: s(b.email, 120).toLowerCase() };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) return { error: 'Please add your email, so we can send you the voucher links.' };
  return { buyer: out };
}

// ---------- Buyer's own currency ----------
// Buyers abroad choose round amounts in their money (NZ$100, A$100, US$100, €100).
// Each voucher becomes a fixed peso value at today's rate; the family sees pesos.
export const MIN_VOUCHER_PHP = 1000;
export const MAX_VOUCHER_PHP = 100_000;

export function voucherPhp(amount, phpPerUnit) {
  const a = Number(amount), r = Number(phpPerUnit);
  if (!(a > 0) || !(r > 0)) return { error: 'Choose a gift value.' };
  const php = roundTo10(a * r);
  if (php < MIN_VOUCHER_PHP) return { error: `Each voucher must be worth at least ₱${MIN_VOUCHER_PHP.toLocaleString('en')} so the pack has real groceries in it.`, php };
  if (php > MAX_VOUCHER_PHP) return { error: 'That value is too high for one voucher. Please contact us for large gifts.', php };
  return { php };
}

export function validateSelf(b) {
  if (!String(b.company ?? '').trim()) return 'Add the company or family name.';
  const q = Number(b.qty);
  if (!(Number.isInteger(q) && q >= 1 && q <= 500)) return 'Number of vouchers must be between 1 and 500.';
  if (!/^[A-Z]{3}$/.test(String(b.currency ?? ''))) return 'Choose your currency.';
  if (b.logo && (!/^data:image\/(png|jpeg|webp);base64,/.test(b.logo) || b.logo.length > 400_000)) return 'Logo must be a PNG or JPG under 300 KB.';
  return null;
}

// ---------- Shopify gift cards ----------
// Each voucher becomes a real Shopify gift card. The family adds the pack to the
// cart and pays with the card at Shopify checkout, so the card must cover the
// groceries AND Shopify's delivery fee for that weight (Philippines rates).
export const SHIP_TIERS = [[10, 350], [20, 550], [35, 850], [Infinity, 1200]];
export const shippingPhp = (kg) => SHIP_TIERS.find(([max]) => kg <= max)[1];

// Fill a pack so groceries + delivery fit inside the gift card value.
export function packForCard(cardPhp, items) {
  let ship = shippingPhp(0);
  let pack = buildPack(cardPhp - ship, items);
  for (let i = 0; i < 4; i++) {
    const need = shippingPhp(pack.kg);
    if (need <= ship) break;
    ship = need;
    pack = buildPack(cardPhp - ship, items);
  }
  return { pack, shipPhp: shippingPhp(pack.kg) };
}

// Shopify gift card codes: 8-20 letters/digits. "XSN-ABC-DEF" -> "XSNABCDEF".
export const giftCardCode = (voucher) => String(voucher).replace(/[^A-Z0-9]/gi, '').toUpperCase().padEnd(8, '8').slice(0, 20);
