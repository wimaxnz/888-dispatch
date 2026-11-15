// Repeat gift orders: "send Lolo & Lola the Care Pack every month".
// Each time one is due, the buyer's saved card is charged; once it's paid, it
// becomes a normal order and goes through dispatch like any other.
// `charge(sub, now)` is the payment provider's job; it returns { ok: true|false }.

const DAY = 86_400_000;
const PH = 8 * 3_600_000; // Philippine time is UTC+8

// Next date. Monthly keeps the same day of the month (31st -> 30th or 28th in short months).
export function advance(at, every, anchorDay) {
  if (every === 'week') return at + 7 * DAY;
  if (every === '2weeks') return at + 14 * DAY;
  if (every === 'month') {
    const d = new Date(at + PH);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const next = Date.UTC(y, m, Math.min(anchorDay, last), d.getUTCHours(), d.getUTCMinutes());
    return next - PH;
  }
  throw new Error(`Unknown repeat: ${every}`);
}

export class Subscriptions {
  constructor({ dispatcher, charge, config }) {
    this.d = dispatcher;
    this.charge = charge;
    this.cfg = config.subscriptions;
    this.subs = new Map();
  }

  log(now, type, data) { this.d.log(now, type, data); }

  create({ id, buyer, packageId, qty = 1, address, every, startAt }) {
    if (!this.d.packages.has(packageId)) throw new Error(`Unknown package ${packageId}`);
    advance(startAt, every, 1); // checks `every` is valid
    const sub = {
      id, buyer, packageId, qty, address, every,
      anchorDay: new Date(startAt + PH).getUTCDate(),
      nextAt: startAt, status: 'active', count: 0, retries: 0, reminded: false, history: [],
    };
    this.subs.set(id, sub);
    this.log(startAt, 'sub_created', { sub: id, every, package: packageId });
    return sub;
  }

  get(id) { return this.subs.get(id); }

  pause(id, now) { const s = this.get(id); if (s?.status === 'active') { s.status = 'paused'; this.log(now, 'sub_paused', { sub: id }); } }

  // Resuming never charges for the deliveries missed while paused.
  resume(id, now) {
    const s = this.get(id);
    if (!s || s.status !== 'paused') return;
    while (s.nextAt <= now) s.nextAt = advance(s.nextAt, s.every, s.anchorDay);
    s.status = 'active'; s.retries = 0; s.retryAt = null; s.reminded = false;
    this.log(now, 'sub_resumed', { sub: id, nextAt: s.nextAt });
  }

  cancel(id, now) { const s = this.get(id); if (s && s.status !== 'cancelled') { s.status = 'cancelled'; this.log(now, 'sub_cancelled', { sub: id }); } }

  skipNext(id, now) {
    const s = this.get(id);
    if (s?.status !== 'active') return;
    // Skipping also drops a pending card retry for that delivery.
    s.nextAt = advance(s.nextAt, s.every, s.anchorDay); s.reminded = false; s.retryAt = null; s.retries = 0;
    this.log(now, 'sub_skipped', { sub: id, nextAt: s.nextAt });
  }

  // Change the pack, number of packs or address; it applies from the next delivery.
  change(id, changes, now) {
    const s = this.get(id);
    if (!s) return;
    if (changes.packageId && !this.d.packages.has(changes.packageId)) throw new Error('Unknown package');
    Object.assign(s, changes);
    this.log(now, 'sub_changed', { sub: id, changes: Object.keys(changes) });
  }

  // Run with the dispatcher's tick: reminders, charges, retries.
  tick(now) {
    for (const s of this.subs.values()) {
      if (s.status !== 'active') continue;
      if (!s.reminded && now >= s.nextAt - this.cfg.reminderDays * DAY && now < s.nextAt) {
        s.reminded = true;
        this.log(now, 'sub_reminder', { sub: s.id, buyer: s.buyer, chargeAt: s.nextAt,
          message: `Your next ${this.d.packages.get(s.packageId).name} is sent in ${this.cfg.reminderDays} days. Skip, change or pause any time.` });
      }
      if (now < (s.retryAt ?? s.nextAt)) continue;
      const paid = this.charge(s, now);
      if (paid.ok) {
        s.count += 1; s.retries = 0;
        const orderId = `${s.id}-${s.count}`;
        this.d.placeOrder({ id: orderId, packageId: s.packageId, qty: s.qty, address: s.address, paidAt: now });
        this.d.orders.get(orderId).subscription = s.id;
        s.history.push(orderId);
        this.log(now, 'sub_charged', { sub: s.id, order: orderId });
        // Stay on the original schedule even if this charge needed a retry.
        do s.nextAt = advance(s.nextAt, s.every, s.anchorDay); while (s.nextAt <= now);
        s.retryAt = null; s.reminded = false;
      } else if (s.retries + 1 >= this.cfg.maxRetries) {
        s.status = 'paused'; s.retries = 0; s.retryAt = null;
        this.log(now, 'sub_payment_failed', { sub: s.id, paused: true,
          message: 'We could not charge your card 3 times, so we paused your gift. Update your card to restart.' });
      } else {
        s.retries += 1;
        s.retryAt = now + this.cfg.retryHours * 3_600_000;
        this.log(now, 'sub_payment_failed', { sub: s.id, retry: s.retries });
      }
    }
  }
}
