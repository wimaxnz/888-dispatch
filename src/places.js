// Philippine provinces -> island group and a rough centre point.
// Used when Shopify doesn't give map coordinates for an address, and to tell
// which shops are on the same island (same courier zone).
// Metro Cebu cities are listed separately because most orders go there.
const P = (island, lat, lng) => ({ island, lat, lng });

export const PROVINCES = {
  'metro manila': P('Luzon', 14.5995, 120.9842), 'ncr': P('Luzon', 14.5995, 120.9842), 'national capital region': P('Luzon', 14.5995, 120.9842),
  'bulacan': P('Luzon', 14.7943, 120.88), 'cavite': P('Luzon', 14.28, 120.87), 'laguna': P('Luzon', 14.17, 121.33), 'rizal': P('Luzon', 14.6, 121.3),
  'batangas': P('Luzon', 13.76, 121.06), 'pampanga': P('Luzon', 15.08, 120.66), 'tarlac': P('Luzon', 15.48, 120.59), 'nueva ecija': P('Luzon', 15.58, 121.0),
  'pangasinan': P('Luzon', 15.9, 120.33), 'zambales': P('Luzon', 15.5, 120.0), 'bataan': P('Luzon', 14.64, 120.48), 'quezon': P('Luzon', 13.93, 121.62),
  'benguet': P('Luzon', 16.41, 120.6), 'la union': P('Luzon', 16.62, 120.32), 'ilocos norte': P('Luzon', 18.2, 120.59), 'ilocos sur': P('Luzon', 17.57, 120.39),
  'isabela': P('Luzon', 16.97, 121.81), 'cagayan': P('Luzon', 17.61, 121.73), 'nueva vizcaya': P('Luzon', 16.33, 121.17), 'aurora': P('Luzon', 15.76, 121.56),
  'camarines sur': P('Luzon', 13.62, 123.18), 'camarines norte': P('Luzon', 14.14, 122.76), 'albay': P('Luzon', 13.14, 123.73), 'sorsogon': P('Luzon', 12.97, 124.0),
  'cebu': P('Cebu', 10.3157, 123.8854), 'bohol': P('Bohol', 9.85, 124.14),
  'iloilo': P('Panay', 10.7202, 122.5621), 'capiz': P('Panay', 11.58, 122.75), 'aklan': P('Panay', 11.71, 122.37), 'antique': P('Panay', 11.17, 122.06), 'guimaras': P('Guimaras', 10.59, 122.63),
  'negros occidental': P('Negros', 10.6765, 122.9509), 'negros oriental': P('Negros', 9.3068, 123.3054), 'siquijor': P('Siquijor', 9.2, 123.52),
  'leyte': P('Leyte', 11.24, 125.0), 'southern leyte': P('Leyte', 10.33, 125.17), 'biliran': P('Leyte', 11.58, 124.47),
  'samar': P('Samar', 11.77, 124.89), 'western samar': P('Samar', 11.77, 124.89), 'eastern samar': P('Samar', 11.5, 125.5), 'northern samar': P('Samar', 12.37, 124.6),
  'masbate': P('Masbate', 12.37, 123.62), 'palawan': P('Palawan', 9.74, 118.74), 'marinduque': P('Marinduque', 13.4, 121.97), 'romblon': P('Romblon', 12.58, 122.27),
  'occidental mindoro': P('Mindoro', 13.1, 120.77), 'oriental mindoro': P('Mindoro', 13.41, 121.18),
  'davao del sur': P('Mindanao', 7.0731, 125.6128), 'davao del norte': P('Mindanao', 7.45, 125.81), 'davao de oro': P('Mindanao', 7.6, 126.0), 'davao oriental': P('Mindanao', 7.32, 126.54),
  'misamis oriental': P('Mindanao', 8.4542, 124.6319), 'misamis occidental': P('Mindanao', 8.34, 123.71), 'bukidnon': P('Mindanao', 8.05, 125.0),
  'lanao del norte': P('Mindanao', 8.23, 124.24), 'zamboanga del sur': P('Mindanao', 6.9214, 122.079), 'zamboanga del norte': P('Mindanao', 8.15, 123.26),
  'south cotabato': P('Mindanao', 6.11, 125.17), 'cotabato': P('Mindanao', 7.2, 124.85), 'sultan kudarat': P('Mindanao', 6.5, 124.42), 'sarangani': P('Mindanao', 5.93, 125.0),
  'agusan del norte': P('Mindanao', 8.95, 125.53), 'agusan del sur': P('Mindanao', 8.5, 125.9), 'surigao del norte': P('Mindanao', 9.79, 125.49), 'surigao del sur': P('Mindanao', 8.6, 126.0),
};

export const CITIES = {
  'cebu city': P('Cebu', 10.3157, 123.8854), 'mandaue': P('Cebu', 10.3236, 123.9223), 'mandaue city': P('Cebu', 10.3236, 123.9223),
  'lapu-lapu': P('Cebu', 10.3103, 123.9494), 'lapu-lapu city': P('Cebu', 10.3103, 123.9494), 'talisay': P('Cebu', 10.2447, 123.8494), 'talisay city': P('Cebu', 10.2447, 123.8494),
  'minglanilla': P('Cebu', 10.245, 123.796), 'consolacion': P('Cebu', 10.3766, 123.9573), 'liloan': P('Cebu', 10.399, 123.999), 'danao': P('Cebu', 10.52, 124.027), 'danao city': P('Cebu', 10.52, 124.027),
  'naga': P('Cebu', 10.2087, 123.7583), 'carcar': P('Cebu', 10.106, 123.64), 'toledo': P('Cebu', 10.377, 123.638),
  'manila': P('Luzon', 14.5995, 120.9842), 'quezon city': P('Luzon', 14.676, 121.0437), 'makati': P('Luzon', 14.5547, 121.0244), 'pasig': P('Luzon', 14.5764, 121.0851),
  'taguig': P('Luzon', 14.5176, 121.0509), 'caloocan': P('Luzon', 14.6507, 120.9676), 'parañaque': P('Luzon', 14.4793, 121.0198), 'paranaque': P('Luzon', 14.4793, 121.0198),
  'iloilo city': P('Panay', 10.7202, 122.5621), 'bacolod': P('Negros', 10.6765, 122.9509), 'davao city': P('Mindanao', 7.0731, 125.6128),
  'cagayan de oro': P('Mindanao', 8.4542, 124.6319), 'tacloban': P('Leyte', 11.2444, 125.0039), 'tagbilaran': P('Bohol', 9.65, 123.85), 'baguio': P('Luzon', 16.4023, 120.596),
};

const clean = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/^province of /, '').trim();

// Where an address is: map point + island. Shopify coordinates win when present.
export function locate(addr) {
  const city = CITIES[clean(addr.city)] ?? CITIES[clean(addr.city).replace(/ city$/, '')];
  const prov = PROVINCES[clean(addr.province)];
  const island = prov?.island ?? city?.island ?? 'Unknown';
  const lat = Number(addr.latitude), lng = Number(addr.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && lat && lng) return { lat, lng, island, source: 'shopify' };
  const c = city ?? prov;
  if (c) return { lat: c.lat, lng: c.lng, island, source: city ? 'city' : 'province' };
  return null;
}
