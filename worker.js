// Cloudflare Worker for Ever Ready expenses app.
//
// Bindings expected on the Worker:
//   EXPENSES_DB     - KV namespace (existing)
//   EXPENSES_R2     - R2 bucket (new) — stores receipt attachments
//
// Secrets expected:
//   ANTHROPIC_KEY        - Anthropic API key (existing)
//   TWILIO_ACCOUNT_SID   - Twilio Account SID (new)
//   TWILIO_AUTH_TOKEN    - Twilio Auth Token (new) — also used for signature check
//   ALLOWED_WHATSAPP_FROM - comma-separated list of allowed sender numbers,
//                          e.g. "whatsapp:+15551234567,whatsapp:+15557654321"
//
// HTTP surface:
//   GET  /                          → existing: load expenses/batches/recurring
//   POST /  (X-Action: ...)         → existing + new actions (see below)
//   POST /whatsapp                  → Twilio webhook (new)
//   GET  /attachment/:id/:idx       → serve receipt image from R2 (new)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Action",
};

const OCR_MODEL  = "claude-sonnet-4-6";
const OCR_PROMPT = "Look at these receipt image(s). Extract: 1) vendor/store name or description, 2) total amount paid, 3) date. Reply ONLY with JSON: {\"description\": \"...\", \"amount\": 0.00, \"date\": \"YYYY-MM-DD\"}. If you cannot find a value leave it empty or 0.";

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // ── Path-based routes (new) ──────────────────────────────
    if (path === "/whatsapp" && request.method === "POST") {
      return handleWhatsApp(request, env);
    }
    const am = path.match(/^\/attachment\/([^/]+)\/(\d+)$/);
    if (am && request.method === "GET") {
      return serveAttachment(env, am[1], parseInt(am[2], 10));
    }

    // ── Header-based routes (existing API) ───────────────────
    const action = request.headers.get("X-Action") || "";

    if (request.method === "GET") {
      const expenses  = JSON.parse(await env.EXPENSES_DB.get("expenses")  || "[]");
      const batches   = JSON.parse(await env.EXPENSES_DB.get("batches")   || "[]");
      const recurring = JSON.parse(await env.EXPENSES_DB.get("recurring") || "[]");
      return json({ expenses, batches, recurring });
    }

    if (request.method === "POST") {
      const body = await request.json();

      if (action === "append-expense") {
        await appendExpense(env, body.expense);
        return json({ ok: true });
      }

      if (action === "add-expenses") {
        const list = Array.isArray(body.expenses) ? body.expenses : [];
        const existing = JSON.parse(await env.EXPENSES_DB.get("expenses") || "[]");
        for (const ex of list) {
          if (!existing.some(e => e.id === ex.id)) existing.push(ex);
        }
        await env.EXPENSES_DB.put("expenses", JSON.stringify(existing));
        return json({ ok: true, count: list.length });
      }

      if (action === "update-expense") {
        const existing = JSON.parse(await env.EXPENSES_DB.get("expenses") || "[]");
        const i = existing.findIndex(e => e.id === body.id);
        if (i >= 0) {
          existing[i] = { ...existing[i], ...body.updates };
          await env.EXPENSES_DB.put("expenses", JSON.stringify(existing));
        }
        return json({ ok: i >= 0 });
      }

      if (action === "delete-expense") {
        const existing = JSON.parse(await env.EXPENSES_DB.get("expenses") || "[]");
        const filtered = existing.filter(e => e.id !== body.id);
        await env.EXPENSES_DB.put("expenses", JSON.stringify(filtered));
        // Also drop attachments from R2 (best effort)
        const removed = existing.find(e => e.id === body.id);
        if (removed && Array.isArray(removed.attachments)) {
          await Promise.all(removed.attachments.map(a =>
            env.EXPENSES_R2.delete(attachmentKey(removed.id, a.idx)).catch(()=>{})
          ));
        }
        return json({ ok: true });
      }

      if (action === "pay-batch") {
        // body: { ids, paidOn, checkNumber, batchId, total }
        const expenses = JSON.parse(await env.EXPENSES_DB.get("expenses") || "[]");
        const batches  = JSON.parse(await env.EXPENSES_DB.get("batches")  || "[]");
        const idSet    = new Set(body.ids || []);
        const updatedIds = [];
        for (const e of expenses) {
          if (idSet.has(e.id) && e.status === "unpaid") {
            e.status      = "paid";
            e.paidOn      = body.paidOn;
            e.checkNumber = body.checkNumber || "";
            e.batchId     = body.batchId;
            updatedIds.push(e.id);
          }
        }
        batches.push({
          id:          body.batchId,
          date:        body.paidOn,
          checkNumber: body.checkNumber || "",
          expenseIds:  updatedIds,
          total:       body.total,
        });
        await env.EXPENSES_DB.put("expenses", JSON.stringify(expenses));
        await env.EXPENSES_DB.put("batches",  JSON.stringify(batches));
        return json({ ok: true, paid: updatedIds.length });
      }

      if (action === "save-recurring") {
        await env.EXPENSES_DB.put("recurring", JSON.stringify(body.recurring || []));
        return json({ ok: true });
      }

      // Legacy save (kept for backward compat — used only by the old client paths)
      if (action === "save") {
        if (body.expenses  !== undefined) await env.EXPENSES_DB.put("expenses",  JSON.stringify(body.expenses));
        if (body.batches   !== undefined) await env.EXPENSES_DB.put("batches",   JSON.stringify(body.batches));
        if (body.recurring !== undefined) await env.EXPENSES_DB.put("recurring", JSON.stringify(body.recurring));
        return json({ ok: true });
      }

      if (action === "ocr" || !action) {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type":      "application/json",
            "x-api-key":         env.ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model:      body.model      || OCR_MODEL,
            max_tokens: body.max_tokens || 300,
            messages:   body.messages
          })
        });
        const data = await resp.json();
        return json(data);
      }

      return new Response("Unknown action", { status: 400, headers: CORS });
    }

    return new Response("Method not allowed", { status: 405, headers: CORS });
  }
};

// ── helpers ────────────────────────────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}

function attachmentKey(expenseId, idx) {
  return `expenses/${expenseId}/${idx}`;
}

async function appendExpense(env, expense) {
  const existing = JSON.parse(await env.EXPENSES_DB.get("expenses") || "[]");
  if (!existing.some(e => e.id === expense.id)) {
    existing.push(expense);
    await env.EXPENSES_DB.put("expenses", JSON.stringify(existing));
  }
}

async function serveAttachment(env, expenseId, idx) {
  const key = attachmentKey(expenseId, idx);
  const obj = await env.EXPENSES_R2.get(key);
  if (!obj) return new Response("Not found", { status: 404, headers: CORS });
  const headers = new Headers(CORS);
  headers.set("Content-Type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(obj.body, { headers });
}

// ── WhatsApp webhook ────────────────────────────────────────────

async function handleWhatsApp(request, env) {
  const rawBody = await request.text();
  const params  = new URLSearchParams(rawBody);

  // 1. Validate Twilio signature so randoms can't fake submissions.
  if (env.TWILIO_AUTH_TOKEN) {
    const signature = request.headers.get("X-Twilio-Signature") || "";
    const valid = await verifyTwilioSignature(request.url, params, env.TWILIO_AUTH_TOKEN, signature);
    if (!valid) return twiml("Unauthorized.", 403);
  }

  // 2. Sender allowlist.
  const from    = params.get("From") || "";
  const allowed = (env.ALLOWED_WHATSAPP_FROM || "").split(",").map(s => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(from)) {
    return twiml("Sender not authorized.");
  }

  const body     = (params.get("Body") || "").trim();
  const numMedia = parseInt(params.get("NumMedia") || "0", 10);

  if (numMedia > 0) {
    return await processNewExpense(env, params, from, body, numMedia);
  }
  if (body) {
    // Text-only message: try as a correction to the last expense first; if
    // the text doesn't match the correction syntax (or there's no recent
    // expense), fall through to creating a new expense from free-form text.
    const corrected = await tryCorrection(env, from, body);
    if (corrected) return corrected;
    return await processTextExpense(env, from, body);
  }
  return twiml("Send a receipt photo, or describe an expense like 'home depot $42.18 today'.");
}

async function processNewExpense(env, params, from, caption, numMedia) {
  const expenseId   = Date.now().toString();
  const attachments = [];
  const imagesForOCR = [];
  const auth = "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);

  for (let i = 0; i < numMedia; i++) {
    const mediaUrl    = params.get(`MediaUrl${i}`);
    const contentType = params.get(`MediaContentType${i}`) || "image/jpeg";
    if (!mediaUrl) continue;
    const mediaResp = await fetch(mediaUrl, { headers: { Authorization: auth }, redirect: "follow" });
    if (!mediaResp.ok) continue;
    const buf = await mediaResp.arrayBuffer();
    await env.EXPENSES_R2.put(attachmentKey(expenseId, i), buf, { httpMetadata: { contentType } });
    attachments.push({ idx: i, contentType });
    if (contentType.startsWith("image/")) {
      imagesForOCR.push({
        type: "image",
        source: { type: "base64", media_type: contentType, data: arrayBufferToBase64(buf) }
      });
    }
  }

  let parsed = { description: "", amount: 0, date: "" };
  if (imagesForOCR.length) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         env.ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: OCR_MODEL,
          max_tokens: 300,
          messages: [{ role: "user", content: [{ type: "text", text: OCR_PROMPT }, ...imagesForOCR] }]
        })
      });
      const data = await resp.json();
      const text = data.content?.[0]?.text || "";
      parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch (e) {
      // Fall through with defaults; user can correct via reply.
    }
  }

  const desc   = (parsed.description || caption || "WHATSAPP RECEIPT").toUpperCase();
  const amount = parseFloat(parsed.amount) || 0;
  const date   = parsed.date || todayISO();

  const expense = {
    id:          expenseId,
    description: desc,
    amount,
    date,
    notes:       caption && caption.toUpperCase() !== desc ? caption : "",
    status:      "unpaid",
    submittedAt: new Date().toISOString(),
    paidOn:      null,
    batchId:     null,
    source:      "whatsapp",
    attachments,
  };
  await appendExpense(env, expense);

  // Remember last expense for this sender so a follow-up text reply can correct it.
  await env.EXPENSES_DB.put(`last:${from}`, expenseId, { expirationTtl: 60 * 60 * 24 * 7 });

  const reply = [
    `Got it: ${money(amount)} ${desc} ${shortDate(date)}.`,
    `Reply with corrections like:`,
    `  amount 50.25`,
    `  desc TARGET`,
    `  date 4/29`,
  ].join("\n");
  return twiml(reply);
}

// Returns a TwiML response if the text was successfully applied as a
// correction to the most recent expense from this sender, or null if it
// didn't match the correction shape (caller should fall through to
// free-form expense creation).
async function tryCorrection(env, from, body) {
  const lastId = await env.EXPENSES_DB.get(`last:${from}`);
  if (!lastId) return null;
  const updates = parseCorrections(body);
  if (!Object.keys(updates).length) return null;
  const expenses = JSON.parse(await env.EXPENSES_DB.get("expenses") || "[]");
  const i = expenses.findIndex(e => e.id === lastId);
  if (i < 0) return null;
  expenses[i] = { ...expenses[i], ...updates };
  await env.EXPENSES_DB.put("expenses", JSON.stringify(expenses));
  const e = expenses[i];
  return twiml(`Updated: ${money(e.amount)} ${e.description} ${shortDate(e.date)}.`);
}

// Free-form text → new expense via Claude. The user can describe what
// they spent without sending a receipt photo.
async function processTextExpense(env, from, text) {
  let parsed = { description: "", amount: 0, date: "" };
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: OCR_MODEL,
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `Extract expense details from this text. Reply ONLY with JSON: {"description": "...", "amount": 0.00, "date": "YYYY-MM-DD"}. Use today (${todayISO()}) if no date is mentioned. If you cannot extract a value leave it empty or 0.\n\nText: ${text}`
        }]
      })
    });
    const data    = await resp.json();
    const content = data.content?.[0]?.text || "";
    parsed = JSON.parse(content.replace(/```json|```/g, "").trim());
  } catch (e) {
    return twiml("Couldn't parse that. Try: 'home depot $42.18 today' or send a receipt photo.");
  }

  const amount = parseFloat(parsed.amount) || 0;
  const desc   = (parsed.description || "").trim().toUpperCase();
  if (!amount || !desc) {
    return twiml("Need at least a description and amount. Try: 'home depot $42.18 today'.");
  }

  const expenseId = Date.now().toString();
  const expense = {
    id:          expenseId,
    description: desc,
    amount,
    date:        parsed.date || todayISO(),
    notes:       "",
    status:      "unpaid",
    submittedAt: new Date().toISOString(),
    paidOn:      null,
    batchId:     null,
    source:      "whatsapp",
    attachments: [],
  };
  await appendExpense(env, expense);
  await env.EXPENSES_DB.put(`last:${from}`, expenseId, { expirationTtl: 60 * 60 * 24 * 7 });

  const reply = [
    `Got it: ${money(expense.amount)} ${expense.description} ${shortDate(expense.date)}.`,
    `Reply with corrections like:`,
    `  amount 50.25`,
    `  desc TARGET`,
    `  date 4/29`,
  ].join("\n");
  return twiml(reply);
}

function parseCorrections(text) {
  const out = {};
  const lines = text.split(/\n|;/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(amount|amt|desc|description|name|date)\s+(.+)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "amount" || k === "amt") {
      const n = parseFloat(v.replace(/[^\d.\-]/g, ""));
      if (!isNaN(n)) out.amount = n;
    } else if (k === "desc" || k === "description" || k === "name") {
      out.description = v.toUpperCase();
    } else if (k === "date") {
      const d = parseDate(v);
      if (d) out.date = d;
    }
  }
  return out;
}

function parseDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parts = s.split(/[\/\-]/).map(p => p.trim());
  let yyyy = new Date().getFullYear(), mm, dd;
  if (parts.length === 2)      { mm = parts[0]; dd = parts[1]; }
  else if (parts.length === 3) {
    mm = parts[0]; dd = parts[1];
    yyyy = parts[2].length === 2 ? 2000 + parseInt(parts[2], 10) : parseInt(parts[2], 10);
  } else return null;
  const m = String(parseInt(mm, 10)).padStart(2, "0");
  const d = String(parseInt(dd, 10)).padStart(2, "0");
  return `${yyyy}-${m}-${d}`;
}

function todayISO() { return new Date().toISOString().split("T")[0]; }
function money(n)   { return "$" + parseFloat(n || 0).toFixed(2); }
function shortDate(iso) {
  if (!iso) return "";
  const p = iso.split("-");
  return p.length === 3 ? `${p[1]}/${p[2]}/${p[0].slice(2)}` : iso;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    str += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(str);
}

function twiml(message, status = 200) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escapeXml(message)}</Message></Response>`;
  return new Response(xml, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;"
  }[c]));
}

async function verifyTwilioSignature(url, params, authToken, signature) {
  // Twilio signs HMAC-SHA1( URL + sorted concatenated key+value ), base64.
  const sorted = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const data   = url + sorted.map(([k, v]) => k + v).join("");
  const key    = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sigBuf   = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return signature === expected;
}
