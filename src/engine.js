// 888 dispatch engine. Pure logic, no server, no database yet.
// Every action takes `now` (milliseconds), so tests can control time.
// RULES.md explains each rule in plain words.
import { km, shippingCost } from './geo.js';

const MIN = 60_000, HOUR = 60 * MIN;
const RING_NAMES = ['local', 'nearby', 'same island', 'other island'];

export class Dispatcher {
  constructor({ packages, shops, config }) {
    this.cfg = config;
    this.packages = new Map(packages.map((p) => [p.id, p]));
    this.shops = new Map(shops.map((s) => [s.id, {
      active: true, strikes: 0, rating: 4.5, ...s,
      stock: { ...s.stock }, reserved: {},
    }]));
    this.orders = new Map();
    this.offers = [];
    this.events = [];   // what would become SMS or app messages
    this.seq = 0;
  }

  log(now, type, data) { this.events.push({ at: now, type, ...data }); }
  hub() { return [...this.shops.values()].find((s) => s.hub); }
  pkg(order) { return this.packages.get(order.packageId); }

  // Items the order needs, for example 2 packs = 2 x each item.
  // Items the order needs, minus any item dropped because nobody can source it.
  need(order) {
    const dropped = new Set((order.dropped ?? []).map((x) => x.sku));
    return this.pkg(order).items
      .filter((i) => !dropped.has(i.sku))
      .map((i) => ({ sku: i.sku, name: i.name, unit: i.unit, qty: i.qty * order.qty }));
  }

  // Shop payout, less the shelf value of any dropped items.
  payoutFor(order) {
    const less = (order.dropped ?? []).reduce((t, x) => t + x.value, 0);
    return this.pkg(order).shopPayout * order.qty - less;
  }

  free(shop, sku) { return Math.max(0, (shop.stock[sku] ?? 0) - (shop.reserved[sku] ?? 0)); }

  // What this shop is short of for this order (after stock promised elsewhere).
  missing(shop, order) {
    return this.need(order)
      .map((n) => ({ ...n, short: Math.max(0, n.qty - this.free(shop, n.sku)) }))
      .filter((n) => n.short > 0)
      .map(({ sku, name, short, unit }) => ({ sku, name, qty: short, value: short * unit }));
  }

  hasFullStock(shop, order) { return this.missing(shop, order).length === 0; }

  // Rule 2b: a shop short of only a few items may still take the order.
  withinTolerance(miss, order) {
    if (!miss.length) return true;
    if (order.fullOnly) return false;
    const p = this.cfg.partial;
    const total = this.need(order).reduce((t, n) => t + n.qty * n.unit, 0);
    const shortValue = miss.reduce((t, m) => t + m.value, 0);
    return miss.length <= p.maxMissingItems && (shortValue / total) * 100 <= p.maxMissingValuePct;
  }

  ring(shop, address) {
    if (shop.island !== address.island) return 3;
    const d = km(shop, address);
    if (d <= this.cfg.rings.localKm) return 0;
    if (d <= this.cfg.rings.nearbyKm) return 1;
    return 2;
  }

  // Rules 2 and 3: eligible shops, nearest ring first (short shops one ring
  // further out), then cheapest shipping, then rating.
  candidates(order) {
    const weight = this.pkg(order).weightKg * order.qty;
    return [...this.shops.values()]
      .filter((s) => !s.hub && s.active && !order.asked.has(s.id))
      .map((s) => ({ shop: s, miss: this.missing(s, order) }))
      .filter((c) => this.withinTolerance(c.miss, order))
      .map((c) => {
        const ring = this.ring(c.shop, order.address);
        return {
          ...c, ring,
          rank: ring + (c.miss.length ? this.cfg.partial.ringPenalty : 0),
          km: Math.round(km(c.shop, order.address) * 10) / 10,
          cost: shippingCost(c.shop, order.address, weight, this.cfg.shipping),
        };
      })
      .sort((a, b) => a.rank - b.rank || a.miss.length - b.miss.length || a.cost - b.cost || b.shop.rating - a.shop.rating);
  }

  // Rule 1: dispatch starts only once the order is paid.
  placeOrder({ id, packageId, qty = 1, address, paidAt, extra = {} }) {
    if (!this.packages.has(packageId)) throw new Error(`Unknown package ${packageId}`);
    const order = {
      ...extra, id, packageId, qty, address, paidAt,
      deadline: paidAt + this.cfg.shipWithinHours * HOUR,
      status: 'dispatching', shopId: null, asked: new Set(), wave: 0, held: {},
      dropped: [], shortageDeclines: {}, shortageShops: new Set(), refund: 0,
    };
    this.orders.set(id, order);
    this.log(paidAt, 'order_paid', { order: id });
    this.sendWave(order, paidAt);
    return order;
  }

  // Rule 4: ask the next best shops (up to waveSize) in the nearest rank that still has any.
  sendWave(order, now) {
    const list = this.candidates(order);
    if (!list.length) return this.toHub(order, now, 'no eligible shop left');
    const rank = list[0].rank;
    const wave = list.filter((c) => c.rank === rank).slice(0, this.cfg.waveSize);
    order.wave += 1;
    const expiresAt = now + this.cfg.offerMinutes * MIN;
    for (const c of wave) {
      order.asked.add(c.shop.id);
      const offer = {
        id: `of${++this.seq}`, orderId: order.id, shopId: c.shop.id,
        wave: order.wave, ring: RING_NAMES[c.ring], km: c.km, shippingCost: c.cost,
        payout: this.payoutFor(order),
        missing: c.miss,   // shown to the shop: "you need to buy these in"
        sentAt: now, expiresAt, status: 'pending',
      };
      this.offers.push(offer);
      this.log(now, 'offer_sent', {
        order: order.id, shop: c.shop.id, wave: order.wave, ring: offer.ring, km: c.km,
        missing: c.miss.map((m) => `${m.qty} x ${m.name}`),
      });
    }
  }

  pending(order) {
    return this.offers.filter((o) => o.orderId === order.id && o.status === 'pending');
  }

  hold(shop, order, qtys) {
    for (const [sku, q] of Object.entries(qtys)) {
      shop.reserved[sku] = (shop.reserved[sku] ?? 0) + q;
      order.held[sku] = (order.held[sku] ?? 0) + q;
    }
  }

  release(order) {
    const shop = this.shops.get(order.shopId);
    for (const [sku, q] of Object.entries(order.held)) shop.reserved[sku] -= q;
    order.held = {};
  }

  toHub(order, now, reason, urgent = false) {
    const hub = this.hub();
    for (const o of this.pending(order)) o.status = 'cancelled';
    order.status = 'assigned';
    order.shopId = hub.id;
    order.sourcing = null;
    order.urgent = urgent;
    this.log(now, urgent ? 'hub_urgent' : 'to_hub', { order: order.id, reason });
    if (!this.hasFullStock(hub, order)) this.log(now, 'hub_needs_stock', { order: order.id });
  }

  // First accept wins. In a real database this must be one locked update,
  // so two shops tapping Accept at the same moment can't both win.
  // A short shop must tick "I will buy in the missing items and ship within 24 h".
  accept(offerId, now, { commitToSource = false } = {}) {
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer || offer.status !== 'pending') return { ok: false, reason: 'offer no longer open' };
    if (offer.missing.length && !commitToSource) return { ok: false, reason: 'tick the promise to buy in the missing items' };
    if (now > offer.expiresAt) { offer.status = 'expired'; return { ok: false, reason: 'offer expired' }; }
    const order = this.orders.get(offer.orderId);
    const shop = this.shops.get(offer.shopId);
    if (order.status !== 'dispatching') { offer.status = 'cancelled'; return { ok: false, reason: 'already taken' }; }
    const miss = this.missing(shop, order);
    if (!this.withinTolerance(miss, order)) { offer.status = 'declined'; return { ok: false, reason: 'stock changed, too many items short' }; }

    // Hold what the shop has now; the missing part is held once it's bought in.
    const have = {};
    for (const n of this.need(order)) have[n.sku] = Math.min(n.qty, this.free(shop, n.sku));
    offer.status = 'accepted';
    offer.payout = this.payoutFor(order);   // in case an item was dropped after the offer went out
    offer.missing = miss;
    for (const o of this.pending(order)) o.status = 'cancelled';
    order.status = 'assigned';
    order.shopId = shop.id;
    order.offer = offer;
    this.hold(shop, order, have);

    if (miss.length) {
      const p = this.cfg.partial;
      const sourceBy = Math.min(now + p.sourceWithinHours * HOUR, order.deadline - p.packingHours * HOUR);
      order.sourcing = { missing: miss, sourceBy, confirmed: false };
      this.log(now, 'accepted_partial', {
        order: order.id, shop: shop.id, sourceBy,
        missing: miss.map((m) => `${m.qty} x ${m.name}`),
      });
      return { ok: true, deadline: order.deadline, sourceBy, missing: miss };
    }
    this.log(now, 'accepted', { order: order.id, shop: shop.id, deadline: order.deadline });
    return { ok: true, deadline: order.deadline };
  }

  // reason 'shortage' = "I can't get the missing items". Any other reason = busy, closed, etc.
  decline(offerId, now, reason = 'busy') {
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer || offer.status !== 'pending') return { ok: false };
    offer.status = 'declined';
    const order = this.orders.get(offer.orderId);
    this.log(now, 'declined', { order: order.id, shop: offer.shopId, reason });
    if (reason === 'shortage' && offer.missing.length) this.countShortage(order, offer.shopId, offer.missing, now);
    // Everyone in the wave said no: don't wait for the timer.
    if (order.status === 'dispatching' && !this.pending(order).length) this.next(order, now);
    return { ok: true };
  }

  // Rule 2c (the iHerb rule): when 2 shops say they can't get the same item,
  // treat it as unavailable. Drop it from the order, refund the buyer its share,
  // tell the buyer, and re-offer to shops that only declined because of it.
  countShortage(order, shopId, missing, now) {
    order.shortageShops.add(shopId);
    const drop = [];
    const stillNeeded = new Set(this.need(order).map((n) => n.sku));
    for (const m of missing.filter((x) => stillNeeded.has(x.sku))) {
      order.shortageDeclines[m.sku] = (order.shortageDeclines[m.sku] ?? 0) + 1;
      if (order.shortageDeclines[m.sku] >= this.cfg.partial.shortageDeclinesToDrop) drop.push(m);
    }
    if (!drop.length) return;
    const pkg = this.pkg(order);
    const itemsValue = pkg.items.reduce((t, i) => t + i.qty * i.unit, 0);
    // Never hollow out a gift: if too much would be missing, the 888 hub sends the full pack.
    const goneValue = [...order.dropped, ...drop].reduce((t, x) => t + (x.value ?? 0), 0);
    if (order.dropped.length + drop.length > this.cfg.partial.maxMissingItems ||
        (goneValue / (itemsValue * order.qty)) * 100 > this.cfg.partial.maxMissingValuePct) {
      if (order.status === 'dispatching') this.toHub(order, now, 'too many items unavailable nearby', true);
      return;
    }
    for (const m of drop) {
      const need = this.need(order).find((n) => n.sku === m.sku);
      if (!need) continue;
      const value = need.qty * need.unit;
      const refund = Math.round(((order.unitPrice ?? pkg.price) * value) / itemsValue); // value already counts every pack in the order
      order.dropped.push({ sku: m.sku, name: m.name, qty: need.qty, value, refund });
      order.refund += refund;
      this.log(now, 'item_dropped', { order: order.id, item: `${need.qty} x ${m.name}`, refund });
    }
    this.log(now, 'customer_notified', {
      order: order.id, refund: order.refund,
      message: `Sorry, ${order.dropped.map((x) => x.name).join(' and ')} ${order.dropped.length > 1 ? 'are' : 'is'} out of stock near your family. ` +
        `We're sending everything else now and refunding ₱${order.refund} for the missing items.`,
    });
    // Shops that declined only because of the shortage get another chance.
    for (const id of order.shortageShops) order.asked.delete(id);
    order.shortageShops.clear();
  }

  // Shop taps "I have all items now". The bought-in items join its stock and are held.
  confirmSourced(orderId, shopId, now) {
    const order = this.orders.get(orderId);
    if (!order?.sourcing || order.shopId !== shopId || order.status !== 'assigned') return { ok: false, reason: 'nothing to confirm' };
    if (now > order.sourcing.sourceBy) return { ok: false, reason: 'sourcing time is up' };
    const shop = this.shops.get(shopId);
    const bought = {};
    for (const m of order.sourcing.missing) { shop.stock[m.sku] = (shop.stock[m.sku] ?? 0) + m.qty; bought[m.sku] = m.qty; }
    this.hold(shop, order, bought);
    order.sourcing.confirmed = true;
    this.log(now, 'sourced', { order: orderId, shop: shopId });
    return { ok: true };
  }

  // Shop taps "I can't get the items" before its sourcing time is up: no strike.
  cantSource(orderId, shopId, now) {
    const order = this.orders.get(orderId);
    if (!order?.sourcing || order.sourcing.confirmed || order.shopId !== shopId || now > order.sourcing.sourceBy) return { ok: false };
    this.log(now, 'cant_source', { order: orderId, shop: shopId, strike: false });
    const missing = order.sourcing.missing;
    this.reroute(order, now, { hold: true });
    this.countShortage(order, shopId, missing, now);
    if (order.status === 'dispatching') this.next(order, now);
    return { ok: true };
  }

  // The order goes back out: full-stock shops only, and only if there's time left.
  reroute(order, now, { hold = false } = {}) {
    this.release(order);
    order.status = 'dispatching';
    order.shopId = null;
    order.sourcing = null;
    order.fullOnly = true;
    // Shops whose offer was only cancelled because someone else accepted first
    // never said no, so they can be asked again.
    for (const o of this.offers) if (o.orderId === order.id && o.status === 'cancelled') order.asked.delete(o.shopId);
    order.asked.add(order.offer.shopId);
    if (!hold) this.next(order, now);
  }

  next(order, now) {
    if (order.fullOnly) {
      if (order.deadline - now < this.cfg.partial.rerouteMinHoursLeft * HOUR) return this.toHub(order, now, 'not enough time left to re-offer', true);
    } else if (now - order.paidAt >= this.cfg.hubAfterHours * HOUR) {
      return this.toHub(order, now, 'time guard reached');
    }
    this.sendWave(order, now);
  }

  // Run every minute or so: expire offers, send next waves, enforce the deadlines.
  tick(now) {
    for (const o of this.offers) if (o.status === 'pending' && now >= o.expiresAt) {
      o.status = 'expired';
      this.log(now, 'offer_expired', { order: o.orderId, shop: o.shopId });
    }
    for (const order of this.orders.values()) {
      if (order.status === 'dispatching') {
        if (!order.fullOnly && now - order.paidAt >= this.cfg.hubAfterHours * HOUR) this.toHub(order, now, 'time guard reached');
        else if (!this.pending(order).length) this.next(order, now);
      } else if (order.status === 'assigned') {
        if (order.sourcing && !order.sourcing.confirmed && now > order.sourcing.sourceBy) this.missedSourcing(order, now);
        else if (now > order.deadline) this.missedDeadline(order, now);
      }
    }
  }

  strike(shop, now) {
    shop.strikes += 1;
    if (shop.strikes >= this.cfg.strikesToSuspend) {
      shop.active = false;
      this.log(now, 'shop_suspended', { shop: shop.id });
    }
  }

  // Rule 5b: promised to buy in the missing items but never confirmed -> a strike, order re-offered.
  missedSourcing(order, now) {
    const shop = this.shops.get(order.shopId);
    this.strike(shop, now);
    this.log(now, 'sourcing_missed', { order: order.id, shop: shop.id, strikes: shop.strikes });
    this.reroute(order, now);
  }

  // Rule 5: missed the 24 h deadline -> no pay, a strike, order to hub as urgent.
  missedDeadline(order, now) {
    const shop = this.shops.get(order.shopId);
    if (shop.hub) {
      if (!order.hubLateLogged) { order.hubLateLogged = true; this.log(now, 'hub_late', { order: order.id }); }
      return;
    }
    this.release(order);
    this.strike(shop, now);
    this.log(now, 'deadline_missed', { order: order.id, shop: shop.id, strikes: shop.strikes, paid: false });
    order.failedShop = shop.id;
    this.toHub(order, now, 'shop missed the 24 h deadline', true);
  }

  // Shop hands the order to the courier and enters the tracking number.
  ship(orderId, shopId, tracking, now) {
    const order = this.orders.get(orderId);
    if (!order || order.shopId !== shopId || order.status !== 'assigned') return { ok: false, reason: 'not your order' };
    const shop = this.shops.get(shopId);
    if (!shop.hub && now > order.deadline) return { ok: false, reason: 'deadline passed' };
    if (order.sourcing && !order.sourcing.confirmed) return { ok: false, reason: 'confirm the missing items first' };
    if (!shop.hub) {
      for (const [sku, q] of Object.entries(order.held)) { shop.stock[sku] -= q; shop.reserved[sku] -= q; }
      order.held = {};
    }
    order.status = 'shipped';
    order.shippedAt = now;
    order.tracking = tracking;
    this.log(now, 'shipped', { order: orderId, shop: shopId, tracking });
    return { ok: true };
  }

  // Rule 6: the payout becomes payable only after delivery, if it was shipped on time.
  deliver(orderId, now) {
    const order = this.orders.get(orderId);
    if (!order || order.status !== 'shipped') return { ok: false };
    order.status = 'delivered';
    order.deliveredAt = now;
    const shop = this.shops.get(order.shopId);
    if (!shop.hub && order.shippedAt <= order.deadline) {
      order.payout = { shop: shop.id, amount: order.offer.payout, status: 'payable' };
      this.log(now, 'payout_payable', { order: orderId, shop: shop.id, amount: order.payout.amount });
    }
    return { ok: true };
  }
}
