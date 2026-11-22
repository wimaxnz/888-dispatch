// Copies the live pages into docs/ (served by GitHub Pages) with the server address filled in.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const API = 'https://jssnhzkyhtobhuogddeq.supabase.co/functions/v1/api';
const here = (p) => new URL(p, import.meta.url);
import { PROVINCES } from '../src/places.js';
const title = (s) => s === 'ncr' ? 'NCR' : s.replace(/\b\w/g, (c) => c.toUpperCase());
const provinces = [...new Set(Object.keys(PROVINCES).map(title))].sort().map((p) => `<option value="${p}">`).join('');
// shop.html and admin.html: docs/ has the home-screen-app additions (install.js)
// that web/ doesn't, so they are only rebuilt with `node web/build.mjs --all`.
const pages = process.argv.includes('--all') ? ['shop.html', 'admin.html'] : [];
for (const f of pages) writeFileSync(here(`../docs/${f}`), readFileSync(here(f), 'utf8').replaceAll('__API__', API).replaceAll('__PROVINCES__', provinces));
copyFileSync(here('common.css'), here('../docs/common.css'));
copyFileSync(here('../shop-logo.png'), here('../docs/logo.png'));
writeFileSync(here('../docs/index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>888 Partners</title>
<link rel="stylesheet" href="common.css"><body><header class="top"><div class="wrap bar" style="max-width:520px"><img src="logo.png" alt="888 Grocery"></div></header>
<div class="wrap" style="max-width:520px"><main><div class="card"><h2>888 partner shops</h2><p class="note">Partner shops: open the link 888 sent you. It takes you straight to your shop screen.</p></div></main></div></body>`);
writeFileSync(here('../docs/.nojekyll'), '');
console.log('docs/ ready');
