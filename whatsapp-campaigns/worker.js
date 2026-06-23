// Cloudflare Worker — WhatsApp campaign tool.
//
// What it does:
//   1. Hold a list of recipients + a message (a "campaign").
//   2. Send each recipient a WhatsApp message via Twilio.
//   3. Capture their replies on the inbound webhook.
//   4. Email you the collected results on demand.
//
// Bindings expected on the Worker:
//   CAMPAIGNS_DB          - KV namespace (stores campaigns + reply routing)
//
// Secrets / vars expected:
//   TWILIO_ACCOUNT_SID    - Twilio Account SID
//   TWILIO_AUTH_TOKEN     - Twilio Auth Token (also used to verify webhook signatures)
//   TWILIO_WHATSAPP_FROM  - sender, e.g. "whatsapp:+14155238886" (sandbox) or your number
//   DEFAULT_COUNTRY_CODE  - optional, digits only, used when a number has no "+", e.g. "1"
//
//   Email (pluggable — leave unset until you pick a provider):
//   EMAIL_PROVIDER        - "resend" | "sendgrid"  (anything else = email disabled)
//   EMAIL_API_KEY         - API key for the chosen provider
//   EMAIL_FROM            - verified sender address, e.g. "Campaigns <bot@yourco.com>"
//   EMAIL_TO              - where results are emailed (defaults per request)
//
// HTTP surface:
//   GET  /                       → { campaigns }
//   POST /  (X-Action: ...)      → create-campaign | send-campaign | delete-campaign | email-results
//   POST /whatsapp               → Twilio inbound webhook (captures replies)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Action",
};

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (path === "/whatsapp" && request.method === "POST") {
      return handleInboundReply(request, env);
    }

    if (request.method === "GET") {
      return json({ campaigns: await loadCampaigns(env) });
    }

    if (request.method === "POST") {
      const action = request.headers.get("X-Action") || "";
      let body = {};
      try { body = await request.json(); } catch { /* tolerate empty */ }

      if (action === "create-campaign") return createCampaign(env, body);
      if (action === "send-campaign")   return sendCampaign(env, body);
      if (action === "delete-campaign") return deleteCampaign(env, body);
      if (action === "email-results")   return emailResults(env, body);

      return new Response("Unknown action", { status: 400, headers: CORS });
    }

    return new Response("Method not allowed", { status: 405, headers: CORS });
  }
};

// ── Campaign storage ────────────────────────────────────────────

async function loadCampaigns(env) {
  return JSON.parse(await env.CAMPAIGNS_DB.get("campaigns") || "[]");
}
async function saveCampaigns(env, campaigns) {
  await env.CAMPAIGNS_DB.put("campaigns", JSON.stringify(campaigns));
}

// ── Actions ─────────────────────────────────────────────────────

async function createCampaign(env, body) {
  const name    = (body.name || "").trim() || "Untitled campaign";
  const message = (body.message || "").trim();
  const useTemplate  = !!body.useTemplate;
  const templateSid  = (body.templateSid || "").trim();

  if (!useTemplate && !message) {
    return json({ ok: false, error: "Message is required (or enable template mode)." }, 400);
  }
  if (useTemplate && !templateSid) {
    return json({ ok: false, error: "Template mode needs a Twilio Content SID." }, 400);
  }

  const recipients = [];
  for (const r of (Array.isArray(body.recipients) ? body.recipients : [])) {
    const phone = normalizePhone(r.phone, env.DEFAULT_COUNTRY_CODE);
    if (!phone) continue;
    if (recipients.some(x => x.phone === phone)) continue; // dedupe
    recipients.push({
      name:       (r.name || "").trim(),
      phone,
      status:     "pending",   // pending | sent | failed | replied
      sentAt:     null,
      messageSid: null,
      error:      null,
      replies:    [],
    });
  }

  if (!recipients.length) {
    return json({ ok: false, error: "No valid recipients (need phone numbers)." }, 400);
  }

  const campaign = {
    id: Date.now().toString(),
    name, message, useTemplate, templateSid,
    createdAt: new Date().toISOString(),
    recipients,
    emailedAt: null,
  };

  const campaigns = await loadCampaigns(env);
  campaigns.unshift(campaign);
  await saveCampaigns(env, campaigns);
  return json({ ok: true, campaign });
}

async function sendCampaign(env, body) {
  const campaigns = await loadCampaigns(env);
  const c = campaigns.find(x => x.id === body.id);
  if (!c) return json({ ok: false, error: "Campaign not found." }, 404);

  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_WHATSAPP_FROM) {
    return json({ ok: false, error: "Twilio is not configured on the Worker." }, 400);
  }

  // Optionally re-send only those not yet sent; default re-sends pending + failed.
  const onlyIds = Array.isArray(body.recipientPhones) ? new Set(body.recipientPhones) : null;

  let sent = 0, failed = 0;
  for (const r of c.recipients) {
    if (onlyIds && !onlyIds.has(r.phone)) continue;
    if (!onlyIds && r.status === "sent") continue;     // don't double-send
    if (!onlyIds && r.status === "replied") continue;

    const text = personalize(c.message, r);
    const res  = await twilioSend(env, r.phone, text, {
      useTemplate: c.useTemplate,
      templateSid: c.templateSid,
      name: r.name,
    });

    if (res.ok) {
      r.status = "sent"; r.sentAt = new Date().toISOString();
      r.messageSid = res.sid; r.error = null;
      sent++;
      // Route this number's future replies to this campaign (7-day window).
      await env.CAMPAIGNS_DB.put(`phone:${r.phone}`, c.id, { expirationTtl: 60 * 60 * 24 * 7 });
    } else {
      r.status = "failed"; r.error = res.error || "send failed";
      failed++;
    }
  }

  await saveCampaigns(env, campaigns);
  return json({ ok: true, sent, failed, campaign: c });
}

async function deleteCampaign(env, body) {
  const campaigns = await loadCampaigns(env);
  const c = campaigns.find(x => x.id === body.id);
  const filtered = campaigns.filter(x => x.id !== body.id);
  await saveCampaigns(env, filtered);
  // Best-effort cleanup of reply routing.
  if (c) await Promise.all(c.recipients.map(r =>
    env.CAMPAIGNS_DB.delete(`phone:${r.phone}`).catch(() => {})
  ));
  return json({ ok: true });
}

async function emailResults(env, body) {
  const campaigns = await loadCampaigns(env);
  const c = campaigns.find(x => x.id === body.id);
  if (!c) return json({ ok: false, error: "Campaign not found." }, 404);

  const to = (body.to || env.EMAIL_TO || "").trim();
  const { subject, text, html } = renderResultsEmail(c);
  const res = await sendEmail(env, { to, subject, text, html });

  if (res.ok) {
    c.emailedAt = new Date().toISOString();
    await saveCampaigns(env, campaigns);
  }
  return json(res.ok ? { ok: true } : { ok: false, error: res.error }, res.ok ? 200 : 400);
}

// ── Twilio sending ──────────────────────────────────────────────

async function twilioSend(env, phone, text, opts) {
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const form = new URLSearchParams();
  form.set("To", `whatsapp:${phone}`);
  form.set("From", env.TWILIO_WHATSAPP_FROM);

  if (opts.useTemplate && opts.templateSid) {
    // Approved WhatsApp template (required for first contact outside the 24h window).
    form.set("ContentSid", opts.templateSid);
    // Map the recipient name into template variable {{1}} if present.
    if (opts.name) form.set("ContentVariables", JSON.stringify({ "1": opts.name }));
  } else {
    form.set("Body", text);
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: data.message || `Twilio ${resp.status}` };
    return { ok: true, sid: data.sid };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function personalize(message, recipient) {
  const name = recipient.name || "";
  return (message || "")
    .replace(/\{\{\s*name\s*\}\}/gi, name)
    .replace(/\{\{\s*1\s*\}\}/g, name);
}

// ── Inbound replies ─────────────────────────────────────────────

async function handleInboundReply(request, env) {
  const raw    = await request.text();
  const params = new URLSearchParams(raw);

  // Verify the request really came from Twilio.
  if (env.TWILIO_AUTH_TOKEN) {
    const sig   = request.headers.get("X-Twilio-Signature") || "";
    const valid = await verifyTwilioSignature(request.url, params, env.TWILIO_AUTH_TOKEN, sig);
    if (!valid) return emptyTwiml(403);
  }

  const from  = params.get("From") || "";           // "whatsapp:+1555..."
  const phone = from.replace(/^whatsapp:/, "").trim();
  const reply = (params.get("Body") || "").trim();

  const campaignId = await env.CAMPAIGNS_DB.get(`phone:${phone}`);
  if (campaignId && reply) {
    const campaigns = await loadCampaigns(env);
    const c = campaigns.find(x => x.id === campaignId);
    if (c) {
      const r = c.recipients.find(x => x.phone === phone);
      if (r) {
        r.replies.push({ body: reply, at: new Date().toISOString() });
        r.status = "replied";
        await saveCampaigns(env, campaigns);
      }
    }
  }

  // No auto-reply — return an empty TwiML so Twilio stays quiet.
  return emptyTwiml(200);
}

// ── Email (pluggable provider) ──────────────────────────────────

async function sendEmail(env, { to, subject, text, html }) {
  const provider = (env.EMAIL_PROVIDER || "").toLowerCase();
  const from     = env.EMAIL_FROM;

  if (!provider)        return { ok: false, error: "Email not configured (set EMAIL_PROVIDER)." };
  if (!env.EMAIL_API_KEY) return { ok: false, error: "Email not configured (set EMAIL_API_KEY)." };
  if (!from)            return { ok: false, error: "Email not configured (set EMAIL_FROM)." };
  if (!to)              return { ok: false, error: "No recipient (set EMAIL_TO or pass 'to')." };

  if (provider === "resend") {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    });
    if (!resp.ok) return { ok: false, error: `Resend ${resp.status}: ${await resp.text()}` };
    return { ok: true };
  }

  if (provider === "sendgrid") {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: parseEmailFrom(from),
        subject,
        content: [
          { type: "text/plain", value: text },
          { type: "text/html",  value: html },
        ],
      }),
    });
    if (!resp.ok) return { ok: false, error: `SendGrid ${resp.status}: ${await resp.text()}` };
    return { ok: true };
  }

  return { ok: false, error: `Unknown EMAIL_PROVIDER "${provider}".` };
}

function parseEmailFrom(from) {
  // Accepts "Name <addr@x.com>" or "addr@x.com".
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1], email: m[2] } : { email: from.trim() };
}

function renderResultsEmail(c) {
  const replied = c.recipients.filter(r => r.replies.length);
  const noReply = c.recipients.filter(r => !r.replies.length);
  const subject = `WhatsApp campaign results — ${c.name} (${replied.length}/${c.recipients.length} replied)`;

  const lines = [];
  lines.push(`Campaign: ${c.name}`);
  lines.push(`Sent: ${new Date(c.createdAt).toLocaleString()}`);
  lines.push(`Recipients: ${c.recipients.length}  |  Replied: ${replied.length}`);
  lines.push("");
  lines.push("── Replies ──");
  if (!replied.length) lines.push("(none yet)");
  for (const r of replied) {
    lines.push(`• ${r.name || r.phone} (${r.phone}):`);
    for (const rep of r.replies) lines.push(`    "${rep.body}"`);
  }
  lines.push("");
  lines.push("── No reply yet ──");
  lines.push(noReply.length ? noReply.map(r => `${r.name || r.phone} (${r.phone}) [${r.status}]`).join(", ") : "(everyone replied)");
  const text = lines.join("\n");

  const esc = s => String(s).replace(/[<>&]/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]));
  const rows = replied.map(r => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;vertical-align:top"><strong>${esc(r.name || r.phone)}</strong><br><span style="color:#888">${esc(r.phone)}</span></td>
      <td style="padding:8px;border-bottom:1px solid #eee">${r.replies.map(rep => esc(rep.body)).join("<br>")}</td>
    </tr>`).join("");
  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
      <h2 style="margin:0 0 4px">${esc(c.name)}</h2>
      <p style="color:#666;margin:0 0 16px">${replied.length}/${c.recipients.length} replied · sent ${esc(new Date(c.createdAt).toLocaleString())}</p>
      <table style="border-collapse:collapse;width:100%">
        <thead><tr><th align="left" style="padding:8px;border-bottom:2px solid #ddd">Recipient</th><th align="left" style="padding:8px;border-bottom:2px solid #ddd">Reply</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="2" style="padding:8px;color:#888">No replies yet.</td></tr>`}</tbody>
      </table>
      ${noReply.length ? `<p style="color:#888;margin-top:16px"><strong>No reply yet:</strong> ${noReply.map(r => esc(r.name || r.phone)).join(", ")}</p>` : ""}
    </div>`;

  return { subject, text, html };
}

// ── helpers ─────────────────────────────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function emptyTwiml(status = 200) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

// Normalize a phone string to E.164 ("+15551234567") best-effort.
function normalizePhone(raw, defaultCC) {
  if (!raw) return "";
  let s = String(raw).trim();
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return "";
  if (hasPlus) return "+" + digits;
  const cc = (defaultCC || "1").replace(/\D/g, "");      // default to US if unset
  if (digits.length === 10) return "+" + cc + digits;     // bare local number
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits;                                    // assume already includes CC
}

async function verifyTwilioSignature(url, params, authToken, signature) {
  const sorted = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const data   = url + sorted.map(([k, v]) => k + v).join("");
  const key    = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const sigBuf   = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return signature === expected;
}
