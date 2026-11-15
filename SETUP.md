# 888 Dispatch: what runs where

| Part | Where |
|---|---|
| Server (rules, Shopify link, timer) | Supabase project **888-dispatch** (Singapore), Edge Function `api` |
| Database | the same Supabase project. Tables: `dispatch_state`, `event_log`, `shop_links`, `shopify_orders`, `app_secrets` |
| Timer | `pg_cron` job `dispatch-tick`, every minute |
| Shop screen | https://wimaxnz.github.io/888-dispatch/shop.html (each shop opens it through its own secret link) |
| Admin screen | https://wimaxnz.github.io/888-dispatch/admin.html |
| Code | this repository. `npm test` runs every rule. |

## Steps for the owner

1. **Get your admin key.** In Supabase, go to project 888-dispatch → Table Editor → `app_secrets` → `admin_key`, and copy the value. Paste it into the admin page. Keep it private.
2. **Connect Shopify.**
   1. In Shopify admin, go to Settings → Notifications → Webhooks → **Create webhook**.
   2. Choose Event **Order payment**, Format **JSON**, and URL `https://jssnhzkyhtobhuogddeq.supabase.co/functions/v1/api/shopify`.
   3. Shopify shows "Your webhooks will be signed with …". Copy that value.
   4. In Supabase `app_secrets`, edit `shopify_webhook_secret` and paste it in place of the `TEST-…` value.
3. **Add your first partner shop.** In admin, go to Shops → Add a partner shop, then send the link it shows to the shop owner.
4. **Shops fill in their stock** on the Stock tab of their screen.

## How a Shopify order is handled
- An order of gift packs, bundles and single groceries becomes **one** delivery.
- Gift packs open up into their items, so a shop short of 1–2 items can still take the order.
- **Shop pay** is 70% of the goods price plus ₱50 packing. You can change this in Admin → Rules.
- These orders come to you as **manual orders** in Admin → Needs you:
  - addresses outside the Philippines;
  - products not in the catalogue;
  - addresses that can't be placed on the map.

## Updating the server code
The function loads `src/*.js` from this repository at a fixed commit (jsDelivr). After changing `src/`, commit and push. Then redeploy `server/index.ts`, with its imports pointed at the new commit.
