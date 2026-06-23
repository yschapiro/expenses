# WhatsApp Campaigns

A small, self-contained tool to:

1. Hold a **list of recipients** and a **message** (a "campaign").
2. **Send** each recipient a WhatsApp message via Twilio.
3. **Capture their replies** automatically.
4. **Email you the results** on demand.

It's completely separate from the expenses app in this repo — its own Worker,
its own storage, its own front-end.

```
whatsapp-campaigns/
├── worker.js      Cloudflare Worker (API + WhatsApp send/receive + email)
├── index.html     PIN-gated web UI (deploy as a static page, or open locally)
├── wrangler.toml  Worker config
└── README.md      this file
```

---

## How it works

```
 You (web UI)
     │  create campaign, hit "Send"
     ▼
 Cloudflare Worker  ──POST /Messages.json──▶  Twilio  ──▶  WhatsApp recipients
     ▲                                                          │
     │  recipient replies                                       │
     └────────────  POST /whatsapp (Twilio webhook)  ◀──────────┘
     │
     └─ "Email results" ──▶ Resend / SendGrid ──▶ your inbox
```

Replies are matched back to a campaign by phone number: when a campaign is sent,
each recipient's number is stored as `phone:<number> → campaignId` (7-day TTL),
so the inbound webhook knows which campaign/recipient a reply belongs to.

---

## Setup

### 1. Twilio (WhatsApp)

- Create a Twilio account and enable WhatsApp. For testing, use the **WhatsApp
  Sandbox** (Messaging → Try it out → WhatsApp). Each recipient must first send
  the sandbox join code (e.g. `join <word>`) to the sandbox number.
- Note your **Account SID** and **Auth Token**.
- Set the sandbox/your number as `TWILIO_WHATSAPP_FROM` in `wrangler.toml`
  (format: `whatsapp:+14155238886`).
- Point the **inbound webhook** ("When a message comes in") at:
  `https://<your-worker>.workers.dev/whatsapp`  (HTTP POST).

### 2. Deploy the Worker

```bash
cd whatsapp-campaigns
npx wrangler kv namespace create CAMPAIGNS_DB   # paste the id into wrangler.toml
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler deploy
```

### 3. Front-end

Open `index.html` after setting two constants near the top of its `<script>`:

```js
const WORKER  = "https://<your-worker>.workers.dev";  // your deployed Worker
const APP_PIN = "1234";                                // change before sharing
```

Host it anywhere static (Cloudflare Pages, Netlify, or just open the file).

### 4. Email (pluggable — decide later)

The Worker already supports **Resend** and **SendGrid**. Pick one, then set:

```toml
# wrangler.toml [vars]
EMAIL_PROVIDER = "resend"        # or "sendgrid"
EMAIL_FROM     = "Campaigns <bot@yourcompany.com>"
EMAIL_TO       = "you@yourcompany.com"
```
```bash
npx wrangler secret put EMAIL_API_KEY
npx wrangler deploy
```

Until this is configured, everything else works — only the "Email results"
button returns "Email not configured".

---

## Sending: free-form vs. templates (important)

WhatsApp / Meta rules:

- **Free-form text** only reaches someone within **24 hours** of *their* last
  message to you (the "customer service window"). This is fine for the sandbox
  (recipients join first) and for warm/opted-in contacts.
- **First contact / cold outreach** outside that window **requires a
  pre-approved template** (Twilio "Content" template). 

This tool supports both:

- Leave the template box unchecked → sends your typed message (use `{{name}}`
  to personalize).
- Check **"Use an approved Twilio template"** and paste the **Content SID**
  (`HX...`) → the Worker sends the template; the recipient's name fills
  variable `{{1}}`.

If sends fail with a `63016`-type error, you're outside the 24h window and need
a template.

---

## Usage

1. Unlock with the PIN.
2. **New campaign** → name it, write the message (or pick template mode), paste
   recipients (one per line: `Name, +15551234567`).
3. **Create**, then **Send**. Statuses update to `sent`, then `replied` as
   answers come in.
4. **Refresh replies** to pull the latest, and **Email results** to send
   yourself the summary.

---

## Notes / limits

- Inbound webhook requests are verified with the Twilio signature
  (`X-Twilio-Signature`) using your Auth Token.
- Sends are sequential; for very large lists consider batching / a queue
  (Twilio also rate-limits, and WhatsApp has per-number daily caps).
- All campaign data lives in one KV key (`campaigns`) — fine for hundreds of
  recipients; revisit for very large volumes.
