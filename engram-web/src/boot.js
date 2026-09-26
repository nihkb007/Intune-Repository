// ENGRAM Web portal: sign in (when the deployment has login set up), pick a preset, point it
// at your sessions folder once, then land in ENGRAM (or straight in your latest session).
import { Engine } from './engine.js';
import { createApi } from './api.js';
import { setupScript } from './setup-script.js';
import { Presets, blankPreset, VIEWS } from './presets-client.js';

const engine = new Engine();
const supported = typeof window.showDirectoryPicker === 'function';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const post = (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Engram': '1' }, body: JSON.stringify(body || {}) });

// ---- folder permissions remembered per preset (IndexedDB can store folder handles) --------
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('engram-web', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const idbGet = async (k) => { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch { return null; } };
const idbSet = async (k, v) => { try { const db = await idb(); await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); } catch { /* storage blocked */ } };

/** Accept the drive root, the claude-sessions folder, or a .claude folder. */
async function resolveSessionsFolder(dir) {
  for (const child of ['claude-sessions', 'projects']) {
    try { return await dir.getDirectoryHandle(child); } catch { /* not here */ }
  }
  return dir;
}

// ---- screens ------------------------------------------------------------------------------
function shell(inner) {
  $('#portal')?.remove();
  const box = document.createElement('div');
  box.id = 'portal';
  box.innerHTML = `<div class="cx">
    <div class="cx-logo glitch" data-text="ENGRAM">ENGRAM</div>
    <div class="cx-sub">CLAUDE COMMAND CENTER · PORTAL</div>
    ${inner}
    <p class="cx-foot">Your Claude sessions stay on your drive and are read only by this browser tab. The portal stores your presets. · <a href="https://butchermedia.cc" target="_blank" rel="noopener">butchermedia.cc</a></p>
  </div>`;
  document.body.appendChild(box);
  return box;
}

function renderLogin() {
  const box = shell(`
    <form class="cx-card cx-login" id="lg-form" autocomplete="on">
      <h3>SIGN IN</h3>
      <label class="cx-field"><span>USER</span><input id="lg-user" name="username" autocomplete="username" required /></label>
      <label class="cx-field"><span>PASSWORD</span><input id="lg-pass" name="password" type="password" autocomplete="current-password" required /></label>
      <button class="btn" type="submit" id="lg-go">SIGN IN</button>
      <p class="cx-err" id="lg-err"></p>
    </form>`);
  $('#lg-user', box).focus();
  $('#lg-form', box).onsubmit = async (e) => {
    e.preventDefault();
    $('#lg-go', box).disabled = true;
    const r = await post('api/login', { username: $('#lg-user', box).value, password: $('#lg-pass', box).value });
    $('#lg-go', box).disabled = false;
    if (r.ok) return main();
    $('#lg-err', box).textContent = (await r.json().catch(() => ({}))).error || 'Sign-in failed.';
  };
}

async function renderPresets(ctx) {
  const list = await ctx.presets.load();
  const where = ctx.presets.mode === 'server' ? 'Saved to your account: both laptops see them.' : ctx.me?.auth ? 'Saved in this browser (no server storage connected yet).' : 'Saved in this browser.';
  const box = shell(`
    <div class="cx-bar">${ctx.me?.user ? `<span>Signed in as <b>${esc(ctx.me.user)}</b></span><button class="btn ghost small" id="pr-out">SIGN OUT</button>` : '<span></span>'}</div>
    ${ctx.me?.misconfigured ? '<div class="cx-warn">Login is half set up: ENGRAM_SESSION_SECRET is missing or shorter than 32 characters.</div>' : ''}
    ${supported ? '' : '<div class="cx-warn">This browser can’t open folders. Use <b>Microsoft Edge</b> or <b>Google Chrome</b>. You can still try the demo.</div>'}
    <div class="cx-head"><h3>CHOOSE A PRESET</h3><span class="muted">${where}</span></div>
    <div class="cx-presets" id="pr-list">
      ${list.map((p) => `
        <div class="cx-preset" style="--c:${p.color}" data-id="${esc(p.id)}">
          <div class="cx-preset-top"><i></i><b>${esc(p.name)}</b></div>
          <div class="cx-preset-meta">${esc(p.laptop)} · <span class="mono">${esc(p.folder)}</span> · opens ${esc(VIEWS[p.view])}</div>
          <div class="cx-preset-actions">
            <button class="btn small" data-act="start">${p.view === 'resume' ? 'RESUME LAST SESSION' : 'START'}</button>
            ${p.view === 'resume' ? '<button class="btn ghost small" data-act="dash">DASHBOARD</button>' : '<button class="btn ghost small" data-act="resume">RESUME LAST</button>'}
            <button class="btn ghost small" data-act="edit">EDIT</button>
            <button class="btn danger small" data-act="del">DELETE</button>
          </div>
        </div>`).join('')}
      <button class="cx-preset cx-new" id="pr-new">+ NEW PRESET<small>e.g. WORK LAPTOP · E:\\claude-sessions</small></button>
    </div>
    <p class="cx-err" id="pr-err"></p>
    <details class="cx-card cx-setup"><summary>FIRST TIME ON THIS LAPTOP? ONE-TIME SETUP</summary>
      <p>Close Claude Code, open <b>PowerShell</b>, paste this, press Enter. It moves this laptop's Claude sessions to the drive and links Claude Code to them. Running it again is safe. Give the drive the same letter on both laptops.</p>
      <label class="cx-row">Drive letter <input id="pr-letter" maxlength="1" value="${esc(list[0]?.drive || 'E')}" /></label>
      <pre id="pr-script"></pre>
      <button class="btn ghost small" id="pr-copy">COPY SETUP COMMAND</button>
    </details>
    <p style="text-align:center;margin-top:14px"><button class="btn ghost small" id="pr-demo">TRY THE DEMO</button></p>`);

  const err = (t) => { $('#pr-err', box).textContent = t || ''; };
  const draw = () => { const l = ($('#pr-letter', box).value.replace(/[^A-Za-z]/g, '') || 'E').toUpperCase(); $('#pr-script', box).textContent = setupScript(`${l}:\\claude-sessions`); };
  $('#pr-letter', box).oninput = draw;
  draw();
  $('#pr-copy', box).onclick = async () => { await navigator.clipboard.writeText($('#pr-script', box).textContent); $('#pr-copy', box).textContent = 'COPIED: PASTE IT INTO POWERSHELL'; };
  $('#pr-new', box).onclick = () => editPreset(ctx, blankPreset(list.length));
  $('#pr-demo', box).onclick = async () => {
    try { await start(ctx, { ...blankPreset(0), name: 'Demo', laptop: 'DEMO LAPTOP', view: 'nexus' }, { demo: await (await fetch('demo-pack.json')).json() }); } catch { err('The demo needs the site to be opened over http(s).'); }
  };
  const out = $('#pr-out', box);
  if (out) out.onclick = async () => { await post('api/logout'); main(); };
  box.querySelectorAll('.cx-preset[data-id]').forEach((card) => {
    const p = list.find((x) => x.id === card.dataset.id);
    card.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        err('');
        const act = b.dataset.act;
        if (act === 'edit') return editPreset(ctx, p);
        if (act === 'del') {
          if (!confirm(`Delete preset "${p.name}"? Your sessions are not affected.`)) return;
          await ctx.presets.save(list.filter((x) => x.id !== p.id));
          return renderPresets(ctx);
        }
        const view = act === 'resume' ? 'resume' : act === 'dash' ? 'nexus' : p.view;
        try { await start(ctx, { ...p, view }); } catch (e) { if (e.name !== 'AbortError') err(e.message); }
      };
    });
  });
}

function editPreset(ctx, preset) {
  const isNew = !ctx.presets.cache.some((p) => p.id === preset.id);
  const dlg = document.createElement('div');
  dlg.className = 'cx-modal';
  dlg.innerHTML = `<form class="cx-card" id="pe-form">
    <h3>${isNew ? 'NEW PRESET' : 'EDIT PRESET'}</h3>
    <label class="cx-field"><span>NAME</span><input id="pe-name" value="${esc(preset.name)}" placeholder="WORK LAPTOP" required /></label>
    <label class="cx-field"><span>THIS LAPTOP'S ACCOUNT</span><input id="pe-laptop" value="${esc(preset.laptop)}" placeholder="WORK" /></label>
    <div class="cx-two">
      <label class="cx-field"><span>DRIVE</span><input id="pe-drive" maxlength="1" value="${esc(preset.drive)}" /></label>
      <label class="cx-field"><span>SESSIONS FOLDER</span><input id="pe-folder" value="${esc(preset.folder)}" /></label>
    </div>
    <label class="cx-field"><span>OPEN ON START</span><select id="pe-view">${Object.entries(VIEWS).map(([k, v]) => `<option value="${k}" ${preset.view === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <div class="cx-field"><span>COLOR</span><div class="cx-colors">${['#00f0ff', '#ff2bd6', '#fcee0a', '#3dff9a', '#8b7bff', '#ff8a3d'].map((c) => `<button type="button" data-c="${c}" class="${preset.color === c ? 'on' : ''}" style="--c:${c}"></button>`).join('')}</div></div>
    <div class="cx-actions" style="justify-content:flex-end"><button type="button" class="btn ghost" id="pe-cancel">CANCEL</button><button class="btn" type="submit">SAVE</button></div>
  </form>`;
  document.body.appendChild(dlg);
  let color = preset.color;
  dlg.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => { color = b.dataset.c; dlg.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x === b)); }; });
  $('#pe-drive', dlg).oninput = (e) => {
    const l = (e.target.value.replace(/[^A-Za-z]/g, '') || 'E').toUpperCase();
    const f = $('#pe-folder', dlg);
    if (/^[A-Za-z]:\\claude-sessions$/.test(f.value) || !f.value) f.value = `${l}:\\claude-sessions`;
  };
  $('#pe-cancel', dlg).onclick = () => dlg.remove();
  $('#pe-form', dlg).onsubmit = async (e) => {
    e.preventDefault();
    const next = { ...preset, name: $('#pe-name', dlg).value, laptop: $('#pe-laptop', dlg).value, drive: $('#pe-drive', dlg).value, folder: $('#pe-folder', dlg).value, view: $('#pe-view', dlg).value, color, updatedAt: new Date().toISOString() };
    const list = isNew ? [...ctx.presets.cache, next] : ctx.presets.cache.map((p) => (p.id === preset.id ? next : p));
    await ctx.presets.save(list);
    dlg.remove();
    renderPresets(ctx);
  };
}

// ---- open ENGRAM for a preset ---------------------------------------------------------------
async function folderFor(preset) {
  const key = `folder:${preset.id}`;
  const saved = await idbGet(key);
  if (saved) {
    const perm = await saved.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted' || (await saved.requestPermission({ mode: 'readwrite' })) === 'granted') return saved;
  }
  if (window.__engramPickFolder) return window.__engramPickFolder(preset); // end-to-end tests
  if (!supported) throw new Error('Use Edge or Chrome to open your sessions folder.');
  const picked = await resolveSessionsFolder(await window.showDirectoryPicker({ id: `engram-${preset.id}`, mode: 'readwrite' }));
  await idbSet(key, picked);
  return picked;
}

async function start(ctx, preset, { demo } = {}) {
  const dir = demo ? null : await folderFor(preset);
  $('#portal .cx')?.insertAdjacentHTML('beforeend', '<p class="cx-foot" id="cx-loading">Reading sessions…</p>');
  if (demo) engine.connectDemo(demo, { laptopName: preset.laptop });
  else await engine.connect(dir, { laptopName: preset.laptop });
  window.__engramPortal = { preset, user: ctx.me?.user || null, auth: !!ctx.me?.auth, signOut: async () => { await post('api/logout'); location.reload(); }, switchPreset: () => location.reload() };
  window.engram = createApi(engine, { onReconnect: () => location.reload() });
  $('#portal')?.remove();
  document.body.classList.remove('connecting');
  document.body.classList.add('web');
  const bridgeLink = document.querySelector('#rail a[data-view="bridge"]');
  if (bridgeLink) { bridgeLink.dataset.view = 'setup'; bridgeLink.querySelector('span').textContent = 'SETUP'; }
  const setup = await import('./setup-view.js'); // loads the ENGRAM interface
  setup.register(engine);
  // First screen: the preset's choice ("resume" opens the latest session).
  if (preset.view === 'resume') await setup.openLatestSession();
  else await setup.openView(preset.view);
}

// ---- entry ------------------------------------------------------------------------------------
async function whoAmI() {
  try {
    const r = await fetch('api/me', { credentials: 'same-origin' });
    if (r.status === 401) return { auth: true, user: null, ...(await r.json()) };
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null; // static hosting: no portal server
    return await r.json();
  } catch { return null; }
}

async function main() {
  document.body.classList.add('connecting');
  const me = await whoAmI();
  if (me?.auth && !me.user) return renderLogin();
  const presets = new Presets(me?.auth && me.user && me.store && me.store !== 'none' ? 'server' : 'local');
  return renderPresets({ me, presets });
}

main();
