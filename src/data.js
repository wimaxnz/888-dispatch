// Loads our real gift packs from data/packages.json.
// The shops below are SAMPLE shops for testing; real ones come from sign-ups.
import { readFileSync } from 'node:fs';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function loadPackages(file = new URL('../data/packages.json', import.meta.url)) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const raw = Array.isArray(json) ? json : json.packages ?? Object.values(json);
  return raw.map((p) => {
    const items = p.items.map(([qty, name, unit]) => ({ sku: slug(name), name, qty, unit }));
    const itemsCost = items.reduce((t, i) => t + i.qty * i.unit, 0);
    return {
      id: p.sku, name: p.name, price: p.price, weightKg: p.weight_kg, items,
      fil: p.fil, highlights: p.highlights,
      // Placeholder: shop earns the shelf value of the items plus ₱50 for packing.
      shopPayout: itemsCost + 50,
    };
  });
}

// Fill a shop's stock with `packs` full sets of the given packages.
export function stockFor(packages, ids, packs) {
  const stock = {};
  for (const p of packages.filter((x) => ids.includes(x.id)))
    for (const i of p.items) stock[i.sku] = (stock[i.sku] ?? 0) + i.qty * packs;
  return stock;
}

export function sampleShops(packages) {
  const all = packages.map((p) => p.id);
  return [
    { id: 'hub-manila', name: '888 Hub (Manila)', hub: true, island: 'Luzon', lat: 14.5995, lng: 120.9842, stock: stockFor(packages, all, 50) },
    { id: 'cebu-colon', name: 'Colon St Grocery', island: 'Cebu', lat: 10.2966, lng: 123.9006, stock: stockFor(packages, all, 4) },
    { id: 'cebu-lahug', name: 'Lahug Mini Mart', island: 'Cebu', lat: 10.3302, lng: 123.9001, stock: stockFor(packages, ['888-TIPID'], 2) },
    { id: 'mandaue', name: 'Mandaue Sari-Sari Plus', island: 'Cebu', lat: 10.3236, lng: 123.9223, stock: stockFor(packages, all, 2) },
    { id: 'talisay', name: 'Talisay Family Store', island: 'Cebu', lat: 10.2447, lng: 123.8494, stock: stockFor(packages, all, 3) },
    { id: 'lapulapu', name: 'Lapu-Lapu Grocery', island: 'Cebu', /* Mactan: bridged, same courier zone */ lat: 10.3103, lng: 123.9494, stock: stockFor(packages, all, 3) },
    { id: 'danao', name: 'Danao Town Store', island: 'Cebu', lat: 10.5200, lng: 124.0270, stock: stockFor(packages, all, 5) },
    { id: 'qc', name: 'Quezon City Grocer', island: 'Luzon', lat: 14.6760, lng: 121.0437, stock: stockFor(packages, all, 10) },
  ];
}
