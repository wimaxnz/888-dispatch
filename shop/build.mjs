// Builds the phone pages with the real engine and packs inlined.
//   node shop/build.mjs                 -> both pages
//   node shop/build.mjs shop|subscribe|admin  -> one page
import { readFileSync, writeFileSync } from 'node:fs';
import { loadPackages } from '../src/data.js';

const here = (p) => new URL(p, import.meta.url);
const strip = (f) => readFileSync(here(f), 'utf8')
  .split('\n').filter((l) => !l.startsWith('import ')).join('\n')
  .replace(/^export (const|function|class) /gm, '$1 ');
const engine = `const { Dispatcher, Subscriptions, advance, config, km, shippingCost } = (() => {
${strip('../src/config.js')}
${strip('../src/geo.js')}
${strip('../src/engine.js')}
${strip('../src/subscriptions.js')}
return { Dispatcher, Subscriptions, advance, config, km, shippingCost };
})();`;
const logo = 'data:image/png;base64,' + readFileSync(here('../shop-logo.png')).toString('base64');
const packs = JSON.stringify(loadPackages());

const pages = { shop: ['template.html', '888-shop.html'], subscribe: ['subscribe-template.html', '888-subscribe.html'], admin: ['admin-template.html', '888-admin.html'] };
for (const [name, [src, out]] of Object.entries(pages)) {
  if (process.argv[2] && process.argv[2] !== name) continue;
  const html = readFileSync(here(src), 'utf8')
    .replace('/*__ENGINE__*/', () => engine)
    .replace('/*__PACKAGES__*/', () => packs)
    .replace('/*__LOGO__*/', () => logo);
  writeFileSync(here(out), html);
  console.log('built', out, html.length, 'bytes');
}
