// What each screen is allowed to see, as plain JSON.
// A shop sees only its own offers, orders, stock and pay; the recipient's
// name, phone and address appear only once the shop has the order.

const stage = (d, o) => {
  if (o.status === 'dispatching') return 'find';
  if (o.status === 'delivered') return 'done';
  if (o.status === 'shipped') return 'way';
  if (d.shops.get(o.shopId)?.hub) return 'hub';
  if (o.sourcing && !o.sourcing.confirmed) return 'buy';
  return 'pack';
};

const rank = (o) => (['buy', 'pack', 'hub'].includes(o.stage) ? 0 : o.stage === 'way' ? 1 : 2); // work to do first
const area = (o) => [o.recipient?.city, o.recipient?.province].filter(Boolean).join(', ') || o.address.island;

export function shopView(d, shopId, catalog, now) {
  const shop = d.shops.get(shopId);
  const free = (sku) => Math.max(0, (shop.stock[sku] ?? 0) - (shop.reserved[sku] ?? 0));
  const offers = d.offers.filter((o) => o.shopId === shopId && o.status === 'pending').map((of) => {
    const order = d.orders.get(of.orderId);
    const miss = d.missing(shop, order);
    const short = new Set(miss.map((m) => m.sku));
    return {
      id: of.id, orderId: order.id, title: d.pkg(order).name, area: area(order), km: of.km,
      paid: d.pkg(order).price, payout: d.payoutFor(order), expiresAt: of.expiresAt, deadline: order.deadline,
      missing: miss.map((m) => ({ name: m.name, qty: m.qty })),
      items: d.need(order).map((n) => ({ sku: n.sku, name: n.name, qty: n.qty, short: short.has(n.sku), have: free(n.sku) })),
      lines: order.lines ?? [], dropped: order.dropped.map((x) => x.name),
      others: d.offers.filter((x) => x.orderId === order.id && x.status === 'pending' && x.shopId !== shopId).length,
    };
  });
  const mine = [...new Set(d.offers.filter((o) => o.shopId === shopId && o.status === 'accepted').map((o) => o.orderId))]
    .map((id) => d.orders.get(id)).filter(Boolean);
  const orders = mine.map((o) => {
    const ours = o.shopId === shopId;
    const lostEv = ours ? null : [...d.events].reverse().find((e) => e.order === o.id && e.shop === shopId && ['cant_source', 'sourcing_missed', 'deadline_missed'].includes(e.type));
    const myOffer = d.offers.find((x) => x.orderId === o.id && x.shopId === shopId && x.status === 'accepted');
    return {
      id: o.id, title: d.pkg(o).name, stage: ours ? stage(d, o) : 'lost', lostWhy: lostEv?.type ?? null,
      payout: o.payout?.shop === shopId ? o.payout.amount : myOffer.payout, payoutStatus: o.payout?.shop === shopId ? o.payout.status : null,
      deadline: o.deadline, paidAt: o.paidAt, tracking: o.tracking ?? null, shippedAt: o.shippedAt ?? null, deliveredAt: o.deliveredAt ?? null,
      partial: !!myOffer.missing?.length,
      sourcing: ours && o.sourcing ? { missing: o.sourcing.missing.map((m) => ({ name: m.name, qty: m.qty })), sourceBy: o.sourcing.sourceBy, confirmed: o.sourcing.confirmed } : null,
      recipient: ours ? o.recipient ?? null : null, note: ours ? o.note ?? '' : '',
      items: ours ? d.need(o).map((n) => ({ sku: n.sku, name: n.name, qty: n.qty })) : [],
      lines: o.lines ?? [], dropped: o.dropped.map((x) => x.name),
    };
  }).sort((a, b) => rank(a) - rank(b) || b.paidAt - a.paidAt);
  const stock = catalog.stockItems.map((i) => ({ ...i, qty: shop.stock[i.sku] ?? 0, held: shop.reserved[i.sku] ?? 0 }));
  return {
    now, shop: { id: shop.id, name: shop.name, city: shop.city, active: shop.active, strikes: shop.strikes },
    rules: { sourceWithinHours: d.cfg.partial.sourceWithinHours, strikesToSuspend: d.cfg.strikesToSuspend, shipWithinHours: d.cfg.shipWithinHours, maxMissingItems: d.cfg.partial.maxMissingItems },
    offers, orders, stock,
  };
}

export function adminView(d, extra, now) {
  const orders = [...d.orders.values()].map((o) => {
    const pkg = d.pkg(o), shop = d.shops.get(o.shopId);
    const accepted = o.offer && o.offer.shopId === o.shopId;
    return {
      id: o.id, title: pkg.name, stage: stage(d, o), urgent: !!o.urgent, paidAt: o.paidAt, deadline: o.deadline,
      shopId: o.shopId, shopName: shop?.name ?? null, wave: o.wave, area: area(o), recipient: o.recipient ?? null, buyer: o.buyer ?? null,
      sale: pkg.price * o.qty, refund: o.buyerChoice?.status === 'later' ? 0 : o.refund, missingRefund: o.refund,
      buyerChoice: o.buyerChoice ?? null, followUpOf: o.followUpOf ?? null, droppedNames: o.dropped.map((x) => x.name), cost: !shop ? d.payoutFor(o) : shop.hub ? d.payoutFor(o) : (o.payout?.amount ?? (accepted ? o.offer.payout : d.payoutFor(o))),
      ship: accepted ? o.offer.shippingCost : null, payout: o.payout ?? null, tracking: o.tracking ?? null,
      sourceBy: o.sourcing && !o.sourcing.confirmed ? o.sourcing.sourceBy : null, failedShop: o.failedShop ?? null,
      dropped: o.dropped.map((x) => `${x.qty} × ${x.name}`), lines: o.lines ?? [], status: o.status,
      shippedAt: o.shippedAt ?? null, deliveredAt: o.deliveredAt ?? null, locatedBy: o.locatedBy ?? null,
    };
  }).sort((a, b) => b.paidAt - a.paidAt);
  const shops = [...d.shops.values()].map((s) => {
    const offers = d.offers.filter((o) => o.shopId === s.id);
    const answered = offers.filter((o) => ['accepted', 'declined', 'expired'].includes(o.status)).length;
    const accepted = offers.filter((o) => o.status === 'accepted').length;
    const theirs = [...d.orders.values()].filter((o) => o.payout?.shop === s.id);
    return {
      id: s.id, name: s.name, city: s.city, island: s.island, hub: !!s.hub, active: s.active, strikes: s.strikes, phone: s.phone ?? '',
      answered, accepted, open: [...d.orders.values()].filter((o) => o.shopId === s.id && o.status === 'assigned').length,
      owed: theirs.filter((o) => o.payout.status === 'payable').reduce((t, o) => t + o.payout.amount, 0),
      owedOrders: theirs.filter((o) => o.payout.status === 'payable').length,
      stocked: Object.values(s.stock).filter((q) => q > 0).length,
    };
  });
  return { now, orders, shops, manual: extra.manual ?? [], payments: extra.payments ?? [], rules: d.cfg, payout: extra.payout, ownerPhone: extra.ownerPhone ?? '' };
}
