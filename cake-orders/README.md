# Custom Dessert Order System

**Decision (Nov 17 meeting):** go with the standalone website, hosted on Cloudflare at `orders.<her domain>`.
Her GoDaddy site is the drag-and-drop Website Builder, so it just links to the order site. The Google version (`google/`) and the PHP version for GoDaddy hosting (`godaddy/`) are **archived**: kept for reference, but no longer updated.

## How it works now

1. **After the design conversation, she prepares a private link** (Dashboard → *+ Prepare order link*). It holds:
   - the customer's details (as much or as little as she likes)
   - the **design summary**, plus **sketches or inspiration photos**
   - the **items and agreed prices**. Cakes can have **any number of tiers**, each tier with its own size. She can preset flavors or leave them to the customer.
2. **The customer opens their link.** They see the design and photos, choose a **flavor and filling for each tier**, and can **change quantities** on cookies and pops. They can **add extra items**, but only ones marked as add-ons, at the minimum price. They enter a delivery **zip code**, which picks the **delivery zone and fee** automatically. They see a running total (card fee included if they pay by card), then agree to the terms, initial and sign. Each link works once.
3. **She gets the order as New.** If the customer changed or added anything, it's flagged **"Needs review"** and lists exactly what changed. **It can't be confirmed until she presses "Changes reviewed."**
4. **Confirming emails the customer** that the order is confirmed. (When they submit, they're told it's *pending final review*.)
5. **Production statuses:** Confirmed → Baked → Decorated → Done. **Done takes the ingredients out of inventory.** Payment is tracked separately: Unpaid / Deposit paid / Paid.
6. Everything from before still works:
   - Square draft invoice, now including the delivery fee and the card fee
   - shortage alerts and the Sunday shopping list
   - calendar link
   - signed copy, now printable **with or without** the terms
7. **Recipes:** one recipe at a time, with ingredients down the side and sizes across the top.
8. **🐞 Report an issue:** a button on every dashboard page, and on the form when she's signed in on that device. It takes a screenshot, she adds a note, and it lands in **Requests & issues**, where each one gets a status (New / In progress / Fixed / Won't do).
9. **Installable app:** on her phone, open the dashboard and choose *Add to Home Screen*. It opens like an app.

## Folders

```
site/public/   The website: index.html (customer form) and admin.html (dashboard), shared logic in js/
  js/core.js     Pricing, card fee, delivery zones, tiers, recipe math, review rules, emails, Square, calendar
  js/api.js      Server routes (used by Cloudflare and by the demo)
  js/demo.js     In-browser pretend server for the demo (password: demo)
  js/report.js   "Report an issue" button
cloudflare/    The server: Worker + D1 database (see cloudflare/README.md for setup)
tests/e2e.cjs  Full browser test of the whole flow (passes on the demo and on the Cloudflare server)
build.sh       Builds dist/demo (the click-through demo)
PLAN.md        What's next (phase 2 and phase 3) and open questions
google/, godaddy/  Archived earlier options
```

## For Claude: reading her issue reports
`GET /api/admin/feedback` (header `X-Admin-Key: <password>`) lists them. Add `?full=1` to include screenshots.
`POST /api/admin/feedback/<id>` with `{"status": "In progress" | "Fixed" | "Won't do", "reply": "..."}` updates one.
