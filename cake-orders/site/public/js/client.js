// Talks to the backend (or to the in-browser demo backend).
const cfg = window.ORDER_SITE || { api: '/api' };
let demoHandle = null;

export const isDemo = !!cfg.demo;

export async function call(method, path, body, adminKey) {
  if (cfg.demo) {
    if (!demoHandle) demoHandle = (await import('./demo.js')).demoHandle;
    const [p, qs] = path.split('?');
    const res = await demoHandle({ method, path: p, body: body ?? null, adminKey, query: Object.fromEntries(new URLSearchParams(qs || '')), clientInfo: navigator.userAgent });
    if (res.status >= 400) throw Object.assign(new Error(res.data.error || 'Error'), { status: res.status });
    return res.raw ?? res.data;
  }
  // GoDaddy style ("api.php?r=") already has a "?", so a route's own query string joins with "&".
  const url = cfg.api + (cfg.api.includes('?') ? path.replace('?', '&') : path);
  const headers = { 'Content-Type': 'application/json' };
  if (adminKey) headers['X-Admin-Key'] = adminKey;
  const r = await fetch(url, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({ error: 'The server sent an unexpected reply (' + r.status + ').' }));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Error ' + r.status), { status: r.status });
  return data;
}
