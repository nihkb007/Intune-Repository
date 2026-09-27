// SETUP page of ENGRAM Web (takes the place of BRIDGE in the desktop app).
import { state, call, toast, applySnapshot, rerender, go } from '../../engram/src/renderer/app.js';
import { views } from '../../engram/src/renderer/views.js';
import { esc, money, tokens, icon } from '../../engram/src/renderer/util.js';
import { setupScript, undoScript } from './setup-script.js';

export function register(engine) {
  views.setup = (root) => setupView(root, engine);
  if (state.view === 'setup') rerender();
}

const ready = async () => { for (let i = 0; i < 100 && !state.model; i++) await new Promise((r) => setTimeout(r, 100)); };

export async function openView(view) {
  await ready();
  if (view && view !== 'nexus') go(view);
}

/** Preset "resume": open the most recent session, where COPY RESUME COMMAND is one click. */
export async function openLatestSession() {
  await ready();
  const s = state.model?.sessions?.[0];
  if (!s) { toast('No sessions in this folder yet.', 'NOTHING TO RESUME', 'var(--yellow)'); return; }
  go('replay', { id: s.id, label: s.title, atEnd: true });
  toast('Press COPY RESUME COMMAND, then paste it into PowerShell on this laptop. It works from any folder.', 'LATEST SESSION', 'var(--green)');
}

function portalPanel() {
  const p = window.__engramPortal;
  if (!p) return '';
  return `<div class="panel" style="margin-bottom:18px;--pc:var(--violet)">
    <div class="panel-h"><h3><b>00</b>PORTAL</h3><div class="tools"><button class="btn ghost small" id="su-preset">SWITCH PRESET</button>${p.auth ? '<button class="btn danger small" id="su-signout">SIGN OUT</button>' : ''}</div></div>
    <div class="set-row"><div><b>Preset</b><small>${esc(p.preset.name)} · ${esc(p.preset.laptop)} · <span class="mono">${esc(p.preset.folder)}</span></small></div><span class="dot" style="--c:${p.preset.color}"></span></div>
    ${p.user ? `<div class="set-row"><div><b>Signed in as</b><small>${esc(p.user)}</small></div></div>` : ''}
  </div>`;
}

function setupView(root, engine) {
  const api = window.engram;
  const m = state.model;
  const me = state.accounts[0];
  const letter = (() => { try { return localStorage.getItem('engram.driveLetter') || 'E'; } catch { return 'E'; } })();
  const target = `${letter}:\\claude-sessions`;
  const laptops = m.accounts;

  root.innerHTML = `
    <div class="page-head"><div><h1><small>ENGRAM WEB</small>SETUP</h1><p>The same Claude Code sessions on both laptops, stored on your drive.</p></div>
      <div class="actions"><button class="btn ghost" id="su-rescan">${icon('refresh')}RESCAN</button>${engine.demo ? '' : `<button class="btn" id="su-switch">${icon('folder')}OPEN ANOTHER FOLDER</button>`}</div></div>
    ${portalPanel()}
    <div class="grid g-2e">
      <div class="panel" style="--pc:var(--green)">
        <div class="panel-h"><h3><b>01</b>THIS BROWSER</h3></div>
        <div class="set-row"><div><b>Sessions folder</b><small class="mono" style="display:block">${esc(engine.demo ? 'Demo data (nothing is saved)' : engine.folderName)}</small></div><span class="tag g">${engine.demo ? 'DEMO' : 'CONNECTED'}</span></div>
        <div class="set-row"><div><b>This laptop's account</b><small>Label used for costs made on this laptop.</small></div><input class="input" id="su-name" style="width:200px" value="${esc(me?.name || '')}" /></div>
        <div class="set-row"><div><b>Refresh</b><small>Browsers can’t watch folders, so ENGRAM re-reads changed sessions every 20 seconds while this tab is open.</small></div></div>
        ${engine.saveError ? `<div class="insight" style="--c:var(--red)">${icon('alert')}<div><b>Could not save to the drive</b><p>${esc(engine.saveError)}</p></div></div>` : ''}
      </div>
      <div class="panel" style="--pc:var(--yellow)">
        <div class="panel-h"><h3><b>02</b>LAPTOPS SHARING THIS DRIVE</h3></div>
        ${laptops.map((a) => `<div class="recent-row" style="grid-template-columns:10px 1fr auto auto;cursor:default"><span class="dot" style="--c:${a.color}"></span><span class="t">${esc(a.name)}<small>${a.remote ? 'other laptop' : 'this laptop'} · ${a.sessions} sessions · ${tokens(a.tokens)} tokens</small></span><span class="cost">${money(a.cost)}</span><span></span></div>`).join('')}
        <p class="muted" style="font-size:12px">Each laptop appears here after you open this site there once. Costs are split by the laptop that first saw each message.</p>
      </div>
    </div>
    <div class="panel" style="margin-top:18px;--pc:var(--magenta)">
      <div class="panel-h"><h3><b>03</b>ONE-TIME SETUP ON EACH LAPTOP</h3><div class="tools"><button class="btn small" id="su-copy">${icon('copy')}COPY SETUP COMMAND</button></div></div>
      <ol style="margin:0 0 12px 18px;line-height:1.8;color:var(--ink-2)">
        <li>Give the drive the same letter on both laptops (currently <b>${esc(letter)}:</b>). Use Disk Management → right-click the drive → <i>Change Drive Letter and Paths</i>.</li>
        <li>Close Claude Code, open <b>PowerShell</b>, paste the command, press Enter.</li>
        <li>Then, on either laptop: <span class="mono">cd ${esc(letter)}:\\your-project</span> and run <span class="mono">claude --continue</span>.</li>
      </ol>
      <pre class="cmdblock" id="su-script"></pre>
      <details style="margin-top:10px"><summary class="muted" style="cursor:pointer">Undo on a laptop</summary><pre class="cmdblock" id="su-undo"></pre><button class="btn ghost small" id="su-copy-undo">COPY UNDO COMMAND</button></details>
    </div>`;

  const p = window.__engramPortal;
  if (p) {
    root.querySelector('#su-preset').onclick = () => p.switchPreset();
    const out = root.querySelector('#su-signout');
    if (out) out.onclick = () => p.signOut();
  }
  root.querySelector('#su-script').textContent = setupScript(target);
  root.querySelector('#su-undo').textContent = undoScript(target);
  root.querySelector('#su-copy').onclick = async () => { await call(api.clipboard, setupScript(target)); toast('Paste it into PowerShell on this laptop.', 'SETUP COMMAND COPIED', 'var(--green)'); };
  root.querySelector('#su-copy-undo').onclick = async () => { await call(api.clipboard, undoScript(target)); toast('Paste it into PowerShell to undo on this laptop.', 'UNDO COMMAND COPIED', 'var(--yellow)'); };
  root.querySelector('#su-rescan').onclick = async () => { applySnapshot(await call(api.scan)); toast(`${state.model.totals.sessions} sessions`, 'RESCANNED', 'var(--green)'); rerender(); };
  const sw = root.querySelector('#su-switch');
  if (sw) sw.onclick = () => { try { localStorage.removeItem('engram.laptopName'); } catch {} indexedDB.deleteDatabase('engram-web'); location.reload(); };
  root.querySelector('#su-name').onchange = async (e) => {
    const name = e.target.value.trim().slice(0, 40);
    if (!name || !me) return;
    await call(api.accounts.upsert, { id: me.id, name });
    try { localStorage.setItem('engram.laptopName', name); } catch {}
    applySnapshot(await call(api.scan));
    rerender();
  };
}
