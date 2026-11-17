# Plan

## ✅ Phase 1: built (from the Nov 17 meeting)
- Private order links that she prepares: design summary, photos, locked items and prices
- Tiered cakes (any number of tiers), with a flavor and filling for each tier
- The customer can change quantities and add extra items. Every change is flagged, and the order can't be confirmed until she reviews it.
- Delivery zones by zip code, each with its own fee
- Statuses: Draft (link sent) → New → Confirmed → Baked → Decorated → Done / Cancelled. Payment tracked separately (Unpaid / Deposit paid / Paid).
- Customer emails: "received, pending review" and "confirmed"
- Signed copy with or without the terms. Terms are folded away in the order view.
- Recipe editor: one recipe at a time, ingredients × sizes
- "Report an issue" button with a screenshot, plus a Requests & issues list
- Installable on her phone (Add to Home Screen)

## Phase 2: go live
1. **Put it on the web at `orders.<her domain>`.**
   - Deploy to your Cloudflare account. **Needed:** a Cloudflare API token, or run `npm run deploy` yourself (see cloudflare/README.md).
   - For the custom address, her domain's **DNS needs to move from GoDaddy to Cloudflare**. This is free. The GoDaddy website and her email keep working once their DNS records are copied over, which Cloudflare does automatically during setup. The domain itself stays registered at GoDaddy.
   - Until then, it runs at `dessert-orders.<you>.workers.dev`.
2. **Her real content:**
   - her current order form and terms (the two links she sent)
   - her real menu: tier sizes, add-on items and their minimum prices
   - delivery zones and fees
   - event types
3. **"Connect Square" button.** She clicks it, logs in to Square herself and approves, so no passwords are shared. This needs a Square developer app (free); we test in Square's **sandbox** first. This would also let the site mark orders **Paid** automatically when the invoice is paid.
4. **Email from her business address.**
   - Her `@<her domain>` mailbox is GoDaddy-hosted (Microsoft 365 / Outlook).
   - **Option A (simplest, recommended):** send through Resend using her domain, with replies going to her inbox. It takes 3 DNS records.
   - **Option B:** a "Connect your email" button using Microsoft sign-in, so emails go out from her actual mailbox. More setup, and it needs a Microsoft app registration.
5. **Sign-in with Google** for the dashboard instead of a shared password, limited to the accounts we list.
6. **Phone notifications** when a new order comes in or a customer submits changes (web push from the installed app).

## Phase 3: costs and margins
- **Ingredient costs:** each purchase records a price, and the system keeps an **average cost** per unit (her prices change week to week).
- **Receipt photos:** she snaps a receipt, AI reads it (about 2–3¢ per receipt), and the matching ingredients are added to inventory. Snacks and other non-baking items are ignored. She can review and fix the result before it's saved. We already do this for expense receipts.
- **Production steps** (bake, fill, cover, decorate…), each with time and a cost per hour.
- **Overhead** (dishes, rent, gas, kosher supervision…) as a cost per hour of work, spread over orders.
- **Per-order profit:** price minus ingredients, steps and overhead.
- **Inventory value:** what's sitting on the shelf, in dollars.

## Open questions for Shaina
1. The exact spelling of her domain and her business name as it should appear on the form.
2. The links to her current order form and the classes form. The classes info belongs on her main website, not the order site, but we'll use the form for wording and terms.
3. **Tier sizes** she offers (4", 5", 6", 7", 8", 9", 10", 12"…?), plus round vs. square or other shapes.
4. Which items customers may **add themselves**, and each one's **minimum price** (cake pops ~$6 each, so $72 a dozen?).
5. **Delivery zones and fees.** The current ones are samples (Manhattan $85 came from the meeting; the rest are made up).
6. **Deposits:** should the invoice ask for a deposit (e.g. 50%) up front?
7. Card fee: only on credit card, with Venmo, Cash App and Zelle getting no fee. Is that correct?
