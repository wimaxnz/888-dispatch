// Plays out one day of orders and prints what happens, in plain words.
import { Dispatcher } from '../src/engine.js';
import { config } from '../src/config.js';
import { loadPackages, sampleShops } from '../src/data.js';

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 15, 1, 0); // 9:00 am Philippine time
const packages = loadPackages();
const d = new Dispatcher({ packages, shops: sampleShops(packages), config });
const name = (id) => d.shops.get(id)?.name ?? id;
const clock = (t) => (t - T0 >= 15 * HOUR ? 'next day ' : '') + new Date(t + 8 * HOUR).toISOString().slice(11, 16);
const offerOf = (order, shop) => d.offers.find((o) => o.orderId === order && o.shopId === shop && o.status === 'pending');

// Order 1: Cebu City, nearest shop accepts on the first wave.
d.placeOrder({ id: 'ORD-1', packageId: '888-TIPID', address: { lat: 10.3111, lng: 123.8916, island: 'Cebu' }, paidAt: T0 });
d.accept(offerOf('ORD-1', 'cebu-colon').id, T0 + 4 * MIN);
d.ship('ORD-1', 'cebu-colon', 'LALAMOVE-5521', T0 + 3 * HOUR);
d.deliver('ORD-1', T0 + 4 * HOUR);

// Order 2: Cebu again; the first wave declines, the second wave ignores it, then Manila.
const t2 = T0 + 30 * MIN;
d.placeOrder({ id: 'ORD-2', packageId: '888-PAMILYA', address: { lat: 10.3157, lng: 123.8854, island: 'Cebu' }, paidAt: t2 });
for (const o of d.offers.filter((x) => x.orderId === 'ORD-2' && x.status === 'pending')) d.decline(o.id, t2 + 2 * MIN);
for (let t = t2; d.orders.get('ORD-2').status === 'dispatching' && t < t2 + 8 * HOUR; t += MIN) {
  const qc = offerOf('ORD-2', 'qc');
  if (qc) d.accept(qc.id, t);
  else d.tick(t);
}

d.ship('ORD-2', 'qc', 'LBC-77310', t2 + 5 * HOUR);

// Order 3: Mandaue shop accepts but never ships; the 24 h rule kicks in.
const t3 = T0 + HOUR;
d.placeOrder({ id: 'ORD-3', packageId: '888-MERIENDA', address: { lat: 10.3236, lng: 123.9223, island: 'Cebu' }, paidAt: t3 });
d.accept(offerOf('ORD-3', 'mandaue').id, t3 + 10 * MIN);
// Order 4: a big ₱19,000 order (2 x Prosperity Box) in Talisay. The shops with
// everything decline; Talisay Family Store is short of ham and cheese but
// takes it, buys them in, and ships.
const t4 = T0 + 2 * HOUR;
const prosperity = packages.find((p) => p.id === '888-PROSPERITY');
const skuOf = (w) => prosperity.items.find((i) => i.name.includes(w)).sku;
const talisay = d.shops.get('talisay');
talisay.stock[skuOf('Fiesta Ham')] = 0;
talisay.stock[skuOf('Queso')] = 1;
d.placeOrder({ id: 'ORD-4', packageId: '888-PROSPERITY', qty: 2, address: { lat: 10.2440, lng: 123.8480, island: 'Cebu' }, paidAt: t4 });
for (let t = t4 + MIN; d.orders.get('ORD-4').status === 'dispatching'; t += MIN) {
  for (const o of d.offers.filter((x) => x.orderId === 'ORD-4' && x.status === 'pending')) {
    if (o.shopId === 'talisay') d.accept(o.id, t, { commitToSource: true });
    else d.decline(o.id, t);
  }
}
d.confirmSourced('ORD-4', 'talisay', t4 + 3 * HOUR);
d.ship('ORD-4', 'talisay', 'LALAMOVE-8890', t4 + 5 * HOUR);
d.deliver('ORD-4', t4 + 6 * HOUR);
d.tick(t4 + 24 * HOUR);

const say = {
  order_paid: (e) => `${e.order} paid. Dispatch starts.`,
  offer_sent: (e) => `  offer -> ${name(e.shop)} (wave ${e.wave}, ${e.ring}, ${e.km} km)` +
    (e.missing.length ? ` — short of: ${e.missing.join(', ')}` : ''),
  declined: (e) => `  ${name(e.shop)} declined`,
  offer_expired: (e) => `  ${name(e.shop)} didn't answer in time`,
  accepted: (e) => `${e.order} ACCEPTED by ${name(e.shop)}. Must ship by ${clock(e.deadline)}.`,
  accepted_partial: (e) => `${e.order} ACCEPTED by ${name(e.shop)}, who will buy in: ${e.missing.join(', ')}. Must confirm by ${clock(e.sourceBy)}.`,
  sourced: (e) => `${e.order} ${name(e.shop)} confirmed: all items in hand.`,
  cant_source: (e) => `${e.order} ${name(e.shop)} couldn't get the items (no strike). Order goes back out.`,
  sourcing_missed: (e) => `${e.order} ${name(e.shop)} never confirmed the items: strike ${e.strikes}. Order goes back out.`,
  shipped: (e) => `${e.order} handed to the courier by ${name(e.shop)}, tracking ${e.tracking}`,
  payout_payable: (e) => `${e.order} delivered. ${name(e.shop)} is owed ₱${e.amount}.`,
  deadline_missed: (e) => `${e.order} NOT shipped in 24 h by ${name(e.shop)}: not paid, strike ${e.strikes}.`,
  to_hub: (e) => `${e.order} -> 888 Hub (${e.reason})`,
  hub_urgent: (e) => `${e.order} -> 888 Hub as URGENT (${e.reason})`,
  hub_needs_stock: (e) => `  !! hub is short of stock for ${e.order}`,
};
for (const e of d.events.sort((a, b) => a.at - b.at)) console.log(clock(e.at), (say[e.type] ?? ((x) => x.type))(e));
