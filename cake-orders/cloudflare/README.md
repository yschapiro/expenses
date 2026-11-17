# Option B: Standalone site on Cloudflare

This puts the order form and an owner dashboard on their own website (for example `orders.yourbakery.com`), running on your Cloudflare account. It works without Google.

- **Customer form:** `https://<your-site>/`
- **Owner dashboard:** `https://<your-site>/admin.html` (password-protected)
- **Data:** Cloudflare D1, a database built into Cloudflare (with automatic 30-day point-in-time restore)
- **Cost:** $0 on Cloudflare's free plan. Free limits: 100,000 requests/day and 5 GB of data, far more than needed.

The site files come from `../site/public` (shared with the GoDaddy version). The server code is in `src/index.js`. The business logic is in `../site/public/js/core.js` and `api.js`.

## One-time setup (about 20 minutes)

You need Node.js installed on your computer. Then, in a terminal, from this folder:

```bash
npm install
npx wrangler login                       # opens the browser, log in to Cloudflare
npx wrangler d1 create dessert-orders    # prints a database_id
```

Paste the `database_id` into `wrangler.jsonc` in place of `REPLACE_WITH_YOUR_D1_DATABASE_ID`. Then:

```bash
npm run db:init                          # creates the tables (sample menu/recipes load on first visit)
npx wrangler secret put ADMIN_PASSWORD   # choose the dashboard password
npm run deploy                           # prints your site address: https://dessert-orders.<you>.workers.dev
```

Open the address. The form should load with the sample menu. Open `/admin.html` and sign in.

### Use her own address (optional)
In the Cloudflare dashboard, go to **Workers & Pages → dessert-orders → Settings → Domains & Routes → Add → Custom domain** and enter e.g. `orders.herbakery.com`. This requires the domain's DNS to be on Cloudflare. If the domain stays at GoDaddy, keep the workers.dev address and link to it from her website (see the top-level README, "Linking from her website").

### Email (new-order alerts, customer copies, Sunday shopping list)
Email is sent through [Resend](https://resend.com) (free for 3,000 emails/month).

1. Create a Resend account and **add her domain**. Resend gives you 3 DNS records to add where the domain is managed (GoDaddy → DNS). Wait until Resend shows "Verified".
2. Create an API key in Resend, then run `npx wrangler secret put RESEND_API_KEY` and paste it.
3. In `wrangler.jsonc`, set `"FROM_EMAIL": "Sweet Creations <orders@herbakery.com>"` and run `npm run deploy` again.
4. In the dashboard → **Settings**, fill in **Your email**.

Until this is done, everything else still works. You just won't get emails, and the dashboard shows "Email: off".

### Square (draft invoices)
1. Go to developer.squareup.com → **Create an app** → **Credentials** → **Production** → copy the **Access token**.
2. Run `npx wrangler secret put SQUARE_ACCESS_TOKEN` and paste it.
3. Dashboard → **Settings** → **Test Square / show my location ID**, then paste the ID into **Square location ID** and save.

To practice with the **Sandbox** token instead, set *Square environment* to `sandbox`.

### Calendar
Dashboard → **Calendar** shows a private link. Add it once:
- **Google Calendar:** Other calendars **+** → From URL
- **iPhone:** Settings → Calendar → Accounts → Add Subscribed Calendar

Calendar apps re-check subscribed links every few hours (Google can take up to a day). For an order you need on the calendar right away, the new-order email has an `.ics` attachment: tap it to add that order straight away.

### Sunday shopping list
`wrangler.jsonc` → `triggers.crons` = `0 11 * * SUN`, which is 11:00 UTC: 6am New York time in winter and 7am in summer. Change it and run `npm run deploy` again if you want a different time.

## Updating later
After editing anything in `site/public` or `src`, run `npm run deploy`.

## Testing locally
```bash
echo "ADMIN_PASSWORD=testpass" > .dev.vars
npm run db:init:local
npx wrangler dev                          # http://localhost:8787
node ../tests/e2e.cjs http://localhost:8787/ testpass   # full browser test
```
