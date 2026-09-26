// Entry point of ENGRAM Web. Shows the connect screen (one-time setup command + folder
// picker), then starts the regular ENGRAM interface on top of the browser engine.
import { Engine } from './engine.js';
import { createApi } from './api.js';
import { setupScript } from './setup-script.js';

const engine = new Engine();
const supported = typeof window.showDirectoryPicker === 'function';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---- remember the folder between visits (IndexedDB can store directory handles) -------
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('engram-web', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
  } catch { return null; }
}
async function idbSet(key, val) {
  try {
    const db = await idb();
    await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(val, key); t.oncomplete = res; t.onerror = res; });
  } catch { /* storage blocked: user picks the folder next time */ }
}

/** Accept the drive root, the claude-sessions folder, or a .claude folder. */
async function resolveSessionsFolder(dir) {
  for (const child of ['claude-sessions', 'projects']) {
    try { return await dir.getDirectoryHandle(child); } catch { /* not here */ }
  }
  return dir;
}

// ---- connect screen ---------------------------------------------------------------------
function renderConnect(saved) {
  const letter = ls.get('engram.driveLetter', 'E').replace(/[^A-Za-z]/g, '').slice(0, 1).toUpperCase() || 'E';
  const box = document.createElement('div');
  box.id = 'connect';
  box.innerHTML = `
    <div class="cx">
      <div class="cx-logo glitch" data-text="ENGRAM">ENGRAM</div>
      <div class="cx-sub">CLAUDE COMMAND CENTER · WEB</div>
      <p class="cx-lead">Use the <b>same Claude Code sessions</b> on both laptops. Keep them on your external drive, next to your projects. Everything runs in this browser tab, and your sessions never leave your computer.</p>
      ${supported ? '' : '<div class="cx-warn">This browser can’t open folders. Use <b>Microsoft Edge</b> or <b>Google Chrome</b>. You can still try the demo.</div>'}

      <div class="cx-step"><span class="cx-n">1</span><div>
        <h3>ONE-TIME SETUP ON EACH LAPTOP</h3>
        <p>Close Claude Code. Open <b>PowerShell</b> (Start → type <i>PowerShell</i>), paste this, and press Enter. It moves this laptop's Claude sessions to the drive and links Claude Code to them. Your login stays on the laptop. Running it again is safe.</p>
        <label class="cx-row">Drive letter <input id="cx-letter" maxlength="1" value="${esc(letter)}" /> <span class="muted">Give the drive the same letter on both laptops (Disk Management → Change Drive Letter).</span></label>
        <pre id="cx-script"></pre>
        <button class="btn ghost small" id="cx-copy">COPY SETUP COMMAND</button>
      </div></div>

      <div class="cx-step"><span class="cx-n">2</span><div>
        <h3>OPEN YOUR SESSIONS FOLDER</h3>
        <label class="cx-row">This laptop is <input id="cx-name" placeholder="e.g. WORK or PERSONAL" value="${esc(ls.get('engram.laptopName'))}" /></label>
        <div class="cx-actions">
          ${saved ? `<button class="btn" id="cx-reconnect">RECONNECT ${esc(saved.name.toUpperCase())}</button>` : ''}
          <button class="btn ${saved ? 'ghost' : ''}" id="cx-pick" ${supported ? '' : 'disabled'}>CHOOSE ${esc(letter)}:\\CLAUDE-SESSIONS</button>
          <button class="btn ghost" id="cx-demo">TRY THE DEMO</button>
        </div>
        <p class="muted" id="cx-status"></p>
      </div></div>
      <p class="cx-foot">ENGRAM Web reads the folder you choose and saves its own notes in a <span class="mono">.engram</span> folder inside it. Nothing is uploaded. · <a href="https://butchermedia.cc" target="_blank" rel="noopener">butchermedia.cc</a></p>
    </div>`;
  document.body.appendChild(box);

  const drawScript = () => {
    const l = ($('#cx-letter').value.replace(/[^A-Za-z]/g, '').slice(0, 1) || 'E').toUpperCase();
    ls.set('engram.driveLetter', l);
    $('#cx-script').textContent = setupScript(`${l}:\\claude-sessions`);
    $('#cx-pick').textContent = `CHOOSE ${l}:\\CLAUDE-SESSIONS`;
  };
  $('#cx-letter').oninput = drawScript;
  drawScript();
  $('#cx-copy').onclick = async () => {
    await navigator.clipboard.writeText($('#cx-script').textContent);
    $('#cx-copy').textContent = 'COPIED: PASTE IT INTO POWERSHELL';
  };
  const name = () => ($('#cx-name').value.trim() || 'THIS LAPTOP').slice(0, 40);
  const status = (t) => { $('#cx-status').textContent = t; };

  $('#cx-pick').onclick = async () => {
    try {
      const picked = await window.showDirectoryPicker({ id: 'engram-sessions', mode: 'readwrite' });
      const dir = await resolveSessionsFolder(picked);
      await idbSet('sessions', dir);
      await start(dir, name());
    } catch (err) {
      if (err.name !== 'AbortError') status(err.message);
    }
  };
  const re = $('#cx-reconnect');
  if (re) re.onclick = async () => {
    try {
      if ((await saved.requestPermission({ mode: 'readwrite' })) !== 'granted') return status('Permission was not granted. Choose the folder again.');
      await start(saved, name());
    } catch (err) { status(err.message); }
  };
  $('#cx-demo').onclick = async () => {
    status('Loading demo…');
    try {
      const pack = await (await fetch('demo-pack.json')).json();
      await start(null, 'DEMO LAPTOP', pack);
    } catch { status('The demo needs the site to be opened over http(s).'); }
  };
}

async function start(dir, laptopName, demoPack) {
  const status = (t) => { const s = $('#cx-status'); if (s) s.textContent = t; };
  ls.set('engram.laptopName', laptopName);
  status('Reading sessions…');
  if (demoPack) engine.connectDemo(demoPack, { laptopName });
  else await engine.connect(dir, { laptopName });
  window.engram = createApi(engine, { onReconnect: () => location.reload() });
  $('#connect')?.remove();
  document.body.classList.remove('connecting');
  document.body.classList.add('web');
  // The web version has a SETUP page where the desktop app has BRIDGE.
  const bridgeLink = document.querySelector('#rail a[data-view="bridge"]');
  if (bridgeLink) { bridgeLink.dataset.view = 'setup'; bridgeLink.querySelector('span').textContent = 'SETUP'; }
  const setup = await import('./setup-view.js'); // loads the ENGRAM interface
  setup.register(engine);
}

// Test hook: lets the end-to-end test connect a folder without the native picker.
window.__engramConnect = (dir, name) => start(dir, name);

(async () => {
  document.body.classList.add('connecting');
  const saved = supported ? await idbGet('sessions') : null;
  // Recent Chrome/Edge keep the permission for sites you use often: then no click is needed.
  if (saved && (await saved.queryPermission?.({ mode: 'readwrite' })) === 'granted' && ls.get('engram.laptopName')) {
    try { await start(saved, ls.get('engram.laptopName')); return; } catch { /* fall back to the connect screen */ }
  }
  renderConnect(saved);
})();
