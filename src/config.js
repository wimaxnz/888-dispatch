// Every rule number lives here. Change a number, the engine follows it.
export const config = {
  rings: { localKm: 5, nearbyKm: 15 },  // ring 1 and ring 2 limits
  waveSize: 3,                          // shops asked at once
  offerMinutes: 15,                     // how long a wave waits
  hubAfterHours: 6,                     // no taker by then -> 888 hub
  shipWithinHours: 24,                  // pay time + this = ship deadline
  strikesToSuspend: 3,
  // Shops short of a few items can still take the order and buy them in.
  partial: {
    maxMissingItems: 2,       // different items a shop may be short of
    maxMissingValuePct: 50,   // ...worth at most this % of the pack
    ringPenalty: 1,           // a short shop counts as one ring further away
    sourceWithinHours: 8,     // after accepting, confirm "all items in hand" within this
    packingHours: 4,          // ...and never later than ship deadline minus this
    rerouteMinHoursLeft: 8,
    shortageDeclinesToDrop: 2, // this many shops can't get an item -> drop it, refund buyer   // if it falls through, re-offer to full-stock shops only if this much time is left
  },
  // Repeat orders: same pack, same family, every week / 2 weeks / month.
  subscriptions: {
    reminderDays: 2,        // message the buyer this many days before each charge
    retryHours: 24,         // card declined -> try again after this
    maxRetries: 3,          // ...then pause the subscription and tell the buyer
  },
  // Shipping estimate (PHP) until we plug in real courier prices.
  shipping: {
    sameIslandBase: 60, perKm: 10, roadFactor: 1.3,
    interIslandBase: 150, perKg: 60,
  },
};
