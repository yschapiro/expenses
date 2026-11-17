# Custom Dessert Order System: three ways to run it

All three do the same job:

1. **Order form:** the customer fills it in, scrolls past the terms, can't submit without ticking "I agree", initialing and signing.
2. **You get a clean summary.** Every order is saved with a signed copy (the terms they agreed to, their initials and signature).
3. **Calendar:** each order shows up on your calendar.
4. **Square:** a draft invoice is created, with the 3.5% fee added when they pick credit card. Nothing is sent until you press Send.
5. **Inventory:** the recipes say what each item uses. Every new order is checked against your stock, and you get an alert right away if you're short.
6. **Sunday shopping list:** an email with what to buy for the week's orders.

| | **A. Google** (`google/`) | **B. Own website on Cloudflare** (`cloudflare/`) | **C. On her GoDaddy website** (`godaddy/`) |
|---|---|---|---|
| Form link | Long Google link (`script.google.com/…`) | Its own address, e.g. `orders.herbakery.com` | On her site, e.g. `herbakery.com/orders/` |
| Where she manages orders | A Google Sheet | Owner dashboard (phone-friendly) | Same owner dashboard |
| Editing recipes, inventory, menu | Sheet tabs | Dashboard tabs | Dashboard tabs |
| Calendar | Real Google Calendar entries, instant, change color on confirm | Calendar subscription link (updates every few hours) + "add to calendar" file in each new-order email | Same as B |
| Emails | Her Gmail, nothing to set up | Resend (free); one-time domain verification | GoDaddy's mail server (may land in spam; can switch to SMTP later) |
| Square | ✅ | ✅ | ✅ |
| Monthly cost | Free | Free (Cloudflare + Resend free plans) | Included in her GoDaddy hosting plan |
| Setup | ~15 min, all clicks, in her Google account | ~20 min, needs a computer with Node (you) | ~20 min: upload a folder, set a password, add a cron job |
| Requires | Her Google account | Your Cloudflare account | GoDaddy **Web Hosting (cPanel)**, not the drag-and-drop Website Builder |
| Best if… | She lives in Google and likes spreadsheets | You want the nicest version and are happy to host it | She wants everything under her own website |

**Try it:** `dist/demo/` (built by `./build.sh`) is a click-through demo with sample data. It runs in the browser with no server, and the "Emails (demo)" tab shows what would have been emailed.

## Folder guide

```
google/       Option A: Apps Script for a Google Sheet (paste-in setup; see google/README.md)
site/public/  The form (index.html) and owner dashboard (admin.html), shared by B and C
  js/core.js    Business logic: pricing, card fee, recipe math, shopping list, emails, Square, calendar
  js/api.js     Server routes (used by Cloudflare and the demo; mirrored in PHP for GoDaddy)
  js/demo.js    In-browser pretend server for the demo
cloudflare/   Option B: Cloudflare Worker + D1 database (see cloudflare/README.md)
godaddy/      Option C: PHP version for GoDaddy cPanel hosting (see godaddy/README.md)
tests/e2e.cjs Full browser test: form → dashboard → status → inventory → calendar → settings
build.sh      Builds dist/demo and dist/godaddy-orders.zip
```

## Linking from her website
Whatever she picks, her current website just needs a **button or menu item, "Order Form"**, that links to the form's address.
In GoDaddy's Website Builder you can also embed the form in a page: **Add Section → HTML → Embed code**:
```html
<iframe src="https://YOUR-FORM-ADDRESS/" style="width:100%;height:2400px;border:0" title="Order form"></iframe>
```
(Option A's Google link can be embedded the same way.)

## How the recipe math works (all options)
For each item ordered, the system adds up the recipe rows for **the product itself** at that size (boards, boxes, outside icing, sticks, bags) plus **each flavor, filling or coating they picked** at that size, then multiplies by the quantity. A recipe row with a blank size counts for every size. Names must match the menu exactly. If something can't be counted (no recipe yet, or an ingredient missing from inventory), the alerts say so instead of skipping it silently.

- **Reserved** = what all New + Confirmed orders will use
- **Left** = on hand minus reserved. Red means you need to buy.

Marking an order **Done** takes its ingredients off "on hand" (only once).
