// Turns the engine into plain JSON for the database, and back again.
import { Dispatcher } from './engine.js';

const DAY = 86_400_000;

export function snapshot(d, extra = {}) {
  return {
    v: 1,
    cfg: d.cfg,
    seq: d.seq,
    packages: [...d.packages.values()],
    shops: [...d.shops.values()],
    orders: [...d.orders.values()].map((o) => ({
      ...o, asked: [...o.asked], shortageShops: [...o.shortageShops], offer: o.offer ? o.offer.id : null,
    })),
    offers: d.offers,
    events: d.events,
    ...extra,
  };
}

export function restore(s) {
  const d = new Dispatcher({ packages: s.packages, shops: [], config: s.cfg });
  d.shops = new Map(s.shops.map((x) => [x.id, x]));
  d.offers = s.offers;
  d.seq = s.seq;
  d.events = s.events ?? [];
  const byId = new Map(d.offers.map((o) => [o.id, o]));
  d.orders = new Map(s.orders.map((o) => [o.id, {
    ...o, asked: new Set(o.asked), shortageShops: new Set(o.shortageShops), offer: o.offer ? byId.get(o.offer) : undefined,
  }]));
  return d;
}

// Keep the live state small: finished orders leave after 14 days (once the
// shop is paid), and only the latest events stay (all are also in event_log).
export function prune(d, now, { keepDays = 14, keepEvents = 1500 } = {}) {
  for (const [id, o] of d.orders) {
    const done = o.status === 'delivered' && now - o.deliveredAt > keepDays * DAY;
    if (done && o.payout?.status !== 'payable') d.orders.delete(id);
  }
  d.offers = d.offers.filter((o) => d.orders.has(o.orderId));
  for (const id of d.packages.keys()) if (id.startsWith('ORDER-') && !d.orders.has(id.slice(6))) d.packages.delete(id);
  if (d.events.length > keepEvents) d.events = d.events.slice(-keepEvents);
}
