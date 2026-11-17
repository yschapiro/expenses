// "Report an issue" button: takes a screenshot of the page, asks for a note, and saves both
// to the Requests & issues list in the dashboard. Only shown to you (signed in on this device).
import { call } from './client.js';

const KEY_STORE = 'orders-admin-key';
const key = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } };

function loadHtml2canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    s.onload = () => resolve(window.html2canvas);
    s.onerror = () => reject(new Error('screenshot tool did not load'));
    document.head.appendChild(s);
  });
}

async function screenshot() {
  try {
    const h2c = await loadHtml2canvas();
    const canvas = await h2c(document.body, { scale: Math.min(1, 900 / window.innerWidth), logging: false, useCORS: true,
      x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight,
      ignoreElements: (el) => el.id === 'reportBtn' || el.id === 'reportBox' });
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch { return ''; }
}

export function installReportButton({ always = false } = {}) {
  if (!always && !key()) return;
  const css = document.createElement('style');
  css.textContent = `#reportBtn{position:fixed;right:calc(14px + env(safe-area-inset-right,0px));bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:40;
    background:#2b2230;color:#fff;border:0;border-radius:99px;padding:10px 14px;font:600 14px/1 inherit;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer}
    #reportBox{position:fixed;inset:0;z-index:41;background:rgba(30,20,35,.5);display:flex;align-items:flex-end;justify-content:center;padding:16px}
    #reportBox .in{background:#fff;color:#2b2230;border-radius:14px;padding:16px;width:min(520px,100%);max-height:90vh;overflow:auto}
    #reportBox img{max-width:100%;border:1px solid #e4dbe6;border-radius:8px;margin:8px 0}
    #reportBox textarea{width:100%;min-height:110px;font:inherit;padding:10px;border:1px solid #e4dbe6;border-radius:9px}
    #reportBox .row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
    #reportBox button{border:0;border-radius:9px;padding:10px 14px;font:inherit;font-weight:600;cursor:pointer}`;
  document.head.appendChild(css);
  const btn = document.createElement('button');
  btn.id = 'reportBtn';
  btn.type = 'button';
  btn.textContent = '🐞 Report an issue';
  document.body.appendChild(btn);
  btn.addEventListener('click', async () => {
    btn.textContent = 'Taking screenshot…';
    const shot = await screenshot();
    btn.textContent = '🐞 Report an issue';
    const box = document.createElement('div');
    box.id = 'reportBox';
    box.innerHTML = `<div class="in"><b>What did you notice, or what would you like changed?</b>
      ${shot ? `<img alt="Screenshot of this page" src="${shot}"><label style="font-size:13px"><input type="checkbox" id="rbShot" checked> Include this screenshot</label>` : ''}
      <textarea id="rbNote" placeholder="e.g. On this page, I'd like the flavors listed in a different order…"></textarea>
      <div id="rbMsg" style="font-size:14px"></div>
      <div class="row"><button type="button" id="rbCancel" style="background:#f6eaf5;color:#9c4f96">Cancel</button><button type="button" id="rbSend" style="background:#9c4f96;color:#fff">Send</button></div></div>`;
    document.body.appendChild(box);
    box.querySelector('#rbNote').focus();
    box.querySelector('#rbCancel').addEventListener('click', () => box.remove());
    box.querySelector('#rbSend').addEventListener('click', async () => {
      const note = box.querySelector('#rbNote').value.trim();
      if (!note) { box.querySelector('#rbMsg').textContent = 'Please write a short note first.'; return; }
      const include = box.querySelector('#rbShot');
      try {
        await call('POST', '/admin/feedback', { note, page: location.pathname.split('/').pop() + location.hash, screenshot: include && include.checked ? shot : '' }, key() || 'demo');
        box.querySelector('.in').innerHTML = '<b>Thanks – sent ✓</b><p style="font-size:14px">You can see it, and its progress, in the dashboard under <b>Requests &amp; issues</b>.</p>';
        setTimeout(() => box.remove(), 1800);
      } catch (e) { box.querySelector('#rbMsg').textContent = '⚠ ' + e.message; }
    });
  });
}
