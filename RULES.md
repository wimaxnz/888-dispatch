# 888 Dispatch — the rules

Version 1. These are the rules the dispatch engine follows. Every number in
*italics* is a setting in `src/config.js`, so we can change it later without
rewriting anything.

## 1. When dispatch starts
The buyer chooses a package and pays. Once the payment is confirmed, the order
belongs to the dispatch system. Before payment, nothing happens.

## 2. Which shops can get an order
A shop is **eligible** only if all of these are true:
- It is approved and active, and not suspended.
- It has the items in the package, in the full quantity the order needs
  (for example, 2 packs means 2 × each item), **or** it is short of only a
  few items (see 2b).
- It hasn't already declined this order or let an offer for it expire.

Stock that a shop has already promised to another order is **reserved** and
doesn't count as available.

### 2b. Shops short of a few items still get a chance
We don't want to lose a sale because a shop is short of one tin of corned
beef. A shop can still take the order if:
- it is short of at most *2* different items, **and**
- those items are worth no more than *50%* of the pack.

The offer tells the shop exactly what it needs to buy in, for example
"Missing: 2 × Argentina Corned Beef, 1 × Nescafé 10 sticks". The shop buys
the items itself; its payout already covers the full pack.

**Fair ranking:** a short shop counts as *one ring further away*. A shop
with everything at the same distance is asked first. A short shop next door
is asked at the same time as full-stock shops 5–15 km away.

**To accept, the short shop must tick a promise:** "I will buy in the
missing items and ship within 24 hours". Without the tick, it can't accept.
Its other choices are **Decline: I can't get the items** or **Decline: busy
or closed**.

**After accepting, the short shop must:**
1. Tap **"I have all the items"** within *8 hours*, and never later than
   *4 hours* before the 24-hour ship deadline. Until it taps this, it can't
   mark the order as shipped.
2. Or tap **"I can't get them"** before that time. There's **no strike**, and
   the order goes back out.

**If it does neither**, it gets **a strike**, and the order goes back out.

**When the order goes back out**, only shops with **everything in stock** are
asked, and only if at least *8 hours* are left before the deadline.
Otherwise it goes straight to the 888 hub as urgent.

### 2c. An item nobody can get is dropped and refunded (like iHerb)
If *2* shops say they **can't get the same item**, we treat that item as
unavailable in that area. This counts both "Decline: I can't get the items"
and "I can't get them" after accepting. Then:
1. The item is **removed from the order**.
2. The buyer is **refunded that item's share** of the price. For example, the
   coffee in a ₱1,288 Tipid pack is worth ₱120.
3. The buyer gets a message: *"Sorry, Nescafé 3-in-1 is out of stock near your
   family. We're sending everything else now and refunding ₱120 for the
   missing items."*
4. Shops that declined only because of that item are **asked again**. They
   now have everything, so no promise is needed. Their payout is reduced by
   the dropped item's shelf value.

"Decline: busy" never counts as a shortage. Two shops short of **different**
items doesn't drop anything.

**Safety limit:** we never send a gift that's mostly missing. If more than
*2* items, or more than *50%* of the pack's value, would be dropped, the
888 hub sends the full pack instead.

## 3. Who gets asked first: nearest and cheapest
Eligible shops are grouped into rings, closest first:

| Ring | Who |
|---|---|
| 1. Local | Within *5 km* of the delivery address |
| 2. Nearby | Within *15 km* |
| 3. Same island | Anywhere on the same island (for example, anywhere in Cebu) |
| 4. Other islands | For example, Manila or Luzon shops sending by sea or air courier |
| 5. 888 hub | Our own fallback stock. It is always the last resort. |

Within each ring, shops are sorted by **estimated shipping cost**, then by
rating. Shops short of items move one ring out (see 2b).

## 4. Offers go out in waves (the Uber rule)
- The *3* best shops in the current ring get the offer at the same time.
- **The first shop to accept wins.** The other shops' offers are cancelled
  straight away.
- A shop can **decline**. If nobody accepts within *15 minutes*, the next wave
  goes out: first the next shops in the same ring, then the next ring.
- When every ring is used up, the order goes to the **888 hub** directly.
- **Time guard:** if *6 hours* have passed since payment and no shop has
  accepted, the order goes straight to the 888 hub, so the 24-hour promise is
  still kept.

## 5. The 24-hour shipping policy
- **Deadline = payment time + 24 hours.** It's the same deadline for whoever
  accepts the order.
- Before the deadline, the shop must pack the order and hand it to the courier,
  and enter the tracking number.
- **If the shop misses the deadline:**
  - It is **not paid**.
  - It gets a **strike**.
  - Its stock reservation is released.
  - The order goes to the 888 hub as **urgent**.
- *3* strikes means the shop is **suspended**.

## 6. Payment to shops
- Each package has a fixed **shop payout**. This is what the shop earns for
  packing it. Our margin is the sale price minus the shop payout minus
  shipping.
- The payout becomes **payable** only after delivery is confirmed **and** the
  order was handed to the courier before the deadline.

## 7. Subscriptions: the same gift every week, 2 weeks or month
- The buyer picks a pack, the family's address and how often: **weekly**,
  **every 2 weeks** or **monthly**.
- **Monthly** keeps the same day each month. A gift set for the 31st goes on
  the 28th, 29th or 30th in shorter months.
- *2 days* before each charge, the buyer gets a reminder and can **skip**,
  **change** (pack, number of packs or address), **pause** or **cancel**.
- On the day, the saved card is charged. Once it's paid, the gift becomes a
  normal order and goes through all the rules above (nearest shop, short
  items, 24 hours).
- **Card declined:** we try again *each day*. After *3* failed tries, the
  subscription is paused and the buyer is asked to update the card.
- **Resuming** never charges for deliveries missed while paused.

## 8. What we haven't decided yet (we'll add these as we go)
- The shop app or SMS screens (Accept / Decline / Packed / Shipped).
- Real courier prices, which will replace the estimate in `config.js`.
- Turning addresses into map points automatically.
- How payouts are actually sent (a split-payment provider such as Xendit).
- Where it runs online (hosting).
