// Straight-line distance between two map points, in km.
export function km(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Estimated shipping cost in PHP from a shop to an address.
export function shippingCost(shop, address, weightKg, s) {
  if (shop.island === address.island) {
    return Math.round(s.sameIslandBase + s.perKm * km(shop, address) * s.roadFactor);
  }
  return Math.round(s.interIslandBase + s.perKg * weightKg);
}
