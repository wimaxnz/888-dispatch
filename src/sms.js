// Text messages (Semaphore, Philippine numbers only).
// Shops get a text for every new offer, so the order reaches them even when
// their shop page is closed or the phone is locked or silent. The owner can
// get texts for things that need them.
// Plain "P" instead of "₱" keeps each text a single, cheaper SMS.

// 0917 123 4567, +63 917..., 63917... -> 639171234567. Anything else -> null.
export function normalizePH(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  if (/^09\d{9}$/.test(d)) return '63' + d.slice(1);
  if (/^639\d{9}$/.test(d)) return d;
  if (/^9\d{9}$/.test(d)) return '63' + d;
  return null;
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const money = (n) => 'P' + Math.round(n).toLocaleString('en-PH');

// Turns new engine events into texts to send: [{ to, message, kind, ref }].
export function textsFor(events, d, { ownerPhone = null } = {}) {
  const out = [];
  const owner = normalizePH(ownerPhone);
  for (const e of events) {
    if (e.type === 'offer_sent') {
      const shop = d.shops.get(e.shop), to = normalizePH(shop?.phone);
      const order = d.orders.get(e.order), offer = d.offers.find((o) => o.orderId === e.order && o.shopId === e.shop);
      if (!to || !order) continue;
      out.push({ to, kind: 'offer', ref: e.order,
        message: `888 NEW ORDER: ${cut(d.pkg(order).name, 40)}, ${e.km} km away, you earn ${money(offer?.payout ?? d.payoutFor(order))}. Open your 888 shop page now to accept.` });
    }
    if (!owner) continue;
    if (e.type === 'hub_urgent') out.push({ to: owner, kind: 'owner', ref: e.order, message: `888 URGENT: order ${e.order} must now be sent by the 888 hub (${cut(e.reason ?? '', 60)}).` });
    if (e.type === 'customer_notified') out.push({ to: owner, kind: 'owner', ref: e.order, message: `888: order ${e.order} is going without some items. Ask the buyer: refund ${money(e.refund ?? 0)} or send later? See admin.` });
    if (e.type === 'shop_suspended') out.push({ to: owner, kind: 'owner', ref: e.shop, message: `888: ${cut(d.shops.get(e.shop)?.name ?? e.shop, 40)} was paused after too many strikes. See admin.` });
  }
  return out;
}

export function manualText(manual, ownerPhone) {
  const to = normalizePH(ownerPhone);
  return to ? { to, kind: 'owner', ref: manual.ref, message: `888: Shopify order ${manual.ref} needs you: ${cut(manual.reason, 90)}. See admin.` } : null;
}
