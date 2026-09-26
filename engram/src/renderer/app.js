import { startBackground } from './bg.js';
import { esc, money, icon, scramble } from './util.js';
import { views } from './views.js';

const api = window.engram;

export const state = {
  model: null,
  accounts: [],
  activeAccountId: null,
  settings: {},
  capsules: [],
  demo: false,
  platform: 'win32',
  view: 'nexus',
  params: {},
  selected: new Set(),
  cleanup: null,
};

// ---------- ipc helpers ----------
export async function call(fn, ...args) {
  const r = await fn(...args);
  if (!r || !r.ok) {
    toast(r ? r.error : 'Unknown error', 'ERROR', 'var(--red)');
    throw new Error(r ? r.error : 'ipc');
  }
  return r.data;
}

export function applySnapshot(s) {
  state.model = s.model;
  state.accounts = s.accounts;
  state.activeAccountId = s.activeAccountId;
  state.settings = s.settings;
  state.capsules = s.capsules;
  document.body.dataset.effects = s.settings.effects || 'full';
  renderAccountSwitch();
  renderRailStat();
}

export const acct = (id) => state.accounts.find((a) => a.id === id) || { id, name: 'Unknown', color: '#6c7a98' };
export const activeAccount = () => acct(state.activeAccountId);

// ---------- toasts / modal ----------
export function toast(msg, title = 'ENGRAM', color = 'var(--cyan)') {
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.setProperty('--c', color);
  t.innerHTML = `<b>${esc(title)}</b>${esc(msg)}`;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .4s, transform .4s'; t.style.opacity = 0; t.style.transform = 'translateX(30px)'; }, 3600);
  setTimeout(() => t.remove(), 4100);
}

export function modal(title, bodyHtml, { okLabel = 'CONFIRM', onOk, wide = false } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-back"><div class="panel modal" style="${wide ? 'width:760px' : ''}">
    <h3>${esc(title)}</h3><div class="modal-body">${bodyHtml}</div>
    <div class="foot"><button class="btn ghost" data-x>CANCEL</button>${onOk ? `<button class="btn mag" data-ok>${esc(okLabel)}</button>` : ''}</div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('[data-x]').onclick = close;
  root.querySelector('.modal-back').onclick = (e) => { if (e.target.classList.contains('modal-back')) close(); };
  const ok = root.querySelector('[data-ok]');
  if (ok) ok.onclick = async () => { ok.disabled = true; try { if ((await onOk(root)) !== false) close(); } finally { ok.disabled = false; } };
  const first = root.querySelector('input, textarea, select');
  if (first) first.focus();
  return root;
}

// ---------- navigation ----------
const LABELS = { nexus: 'NEXUS', projects: 'PROJECTS', recordings: 'RECORDINGS', vault: 'VAULT', fusion: 'FUSION', bridge: 'BRIDGE', settings: 'SYSTEM', project: 'PROJECT', replay: 'REPLAY' };
const RAIL = { project: 'projects', replay: 'recordings' };

export function go(view, params = {}) {
  state.view = view;
  state.params = params;
  if (typeof state.cleanup === 'function') { try { state.cleanup(); } catch {} }
  state.cleanup = null;
  document.querySelectorAll('#rail a').forEach((a) => a.classList.toggle('active', a.dataset.view === (RAIL[view] || view)));
  scramble(document.getElementById('crumb'), LABELS[view] + (params.label ? ' // ' + params.label.toUpperCase().slice(0, 40) : ''));
  const root = document.getElementById('view');
  root.scrollTop = 0;
  root.classList.remove('view-enter');
  void root.offsetWidth;
  root.classList.add('view-enter');
  document.getElementById('tip').classList.add('hidden');
  const r = views[view](root, params);
  if (r && typeof r.then === 'function') r.then((c) => { state.cleanup = c; }); else state.cleanup = r;
}

export function rerender() { go(state.view, state.params); }

// ---------- chrome ----------
function renderAccountSwitch() {
  const box = document.getElementById('acct-switch');
  box.innerHTML = state.accounts.map((a) => `<div class="acct-chip ${a.id === state.activeAccountId ? 'active' : ''}" style="--c:${a.color}" data-acct="${a.id}" title="${esc(a.email || a.configDir)}"><i></i>${esc(a.name)}</div>`).join('');
  box.querySelectorAll('[data-acct]').forEach((n) => n.onclick = () => switchAccount(n.dataset.acct));
}

export async function switchAccount(id) {
  if (id === state.activeAccountId) return;
  state.activeAccountId = await call(api.accounts.setActive, id);
  renderAccountSwitch();
  const a = activeAccount();
  toast(`Context follows you. ${state.model.sessions.length} sessions and your vault stay linked.`, `SWITCHED TO ${a.name}`, a.color);
  if (state.view === 'bridge' || state.view === 'nexus') rerender();
}

function renderRailStat() {
  const m = state.model;
  if (!m) return;
  document.getElementById('rail-stat').innerHTML = `${m.totals.sessions} sessions · ${m.projects.length} projects<br>${m.totals.files} transcripts · scan ${m.scanMs}ms<br>MTD <span style="color:var(--yellow)">${money(m.month.cost)}</span>`;
}

export async function rescan(quiet) {
  const btn = document.getElementById('rescan');
  btn.disabled = true;
  try {
    applySnapshot(await call(api.scan));
    if (!quiet) toast(`${state.model.totals.sessions} sessions indexed in ${state.model.scanMs}ms`, 'SCAN COMPLETE', 'var(--green)');
    rerender();
  } finally { btn.disabled = false; }
}

// ---------- command palette ----------
function paletteItems(q) {
  const m = state.model;
  const items = [
    ...Object.entries({ nexus: 'Open Nexus dashboard', projects: 'Open Projects', recordings: 'Open Recordings', vault: 'Open Memory Vault', fusion: 'Open Fusion capsules', bridge: 'Open Account Bridge', settings: 'Open System settings' })
      .map(([v, t]) => ({ k: 'GO', t, run: () => go(v) })),
    { k: 'ACTION', t: 'Rescan all accounts', run: () => rescan() },
    { k: 'ACTION', t: 'New memory note', run: () => go('vault', { new: true }) },
    { k: 'ACTION', t: 'Sync sessions across accounts', run: () => go('bridge', { autosync: true }) },
    ...state.accounts.map((a) => ({ k: 'ACCOUNT', t: `Switch to ${a.name}`, x: a.email || '', run: () => switchAccount(a.id) })),
    ...m.projects.map((p) => ({ k: 'PROJECT', t: p.name, x: money(p.cost), run: () => go('project', { key: p.key, label: p.name }) })),
    ...m.sessions.slice(0, 400).map((s) => ({ k: 'SESSION', t: s.title, x: `${s.projectName} · ${money(s.cost)}`, run: () => go('replay', { id: s.id, label: s.title }) })),
  ];
  if (!q) return items.slice(0, 12);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => terms.every((t) => (i.t + ' ' + (i.x || '') + ' ' + i.k).toLowerCase().includes(t))).slice(0, 40);
}

function openPalette() {
  const p = document.getElementById('palette');
  const input = document.getElementById('palette-input');
  const list = document.getElementById('palette-list');
  let items = [];
  let sel = 0;
  const draw = () => {
    items = paletteItems(input.value.trim());
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = items.map((i, n) => `<li class="${n === sel ? 'on' : ''}" data-n="${n}"><span class="k">${i.k}</span><span class="t">${esc(i.t)}</span><span class="x">${esc(i.x || '')}</span></li>`).join('') || '<li><span class="t muted">No matches</span></li>';
    list.querySelectorAll('li[data-n]').forEach((li) => { li.onclick = () => run(+li.dataset.n); });
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (n) => { const it = items[n]; close(); if (it) it.run(); };
  const close = () => { p.classList.add('hidden'); input.onkeydown = null; };
  input.value = '';
  p.classList.remove('hidden');
  input.focus();
  input.oninput = () => { sel = 0; draw(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') run(sel);
    else if (e.key === 'Escape') close();
  };
  p.onclick = (e) => { if (e.target === p) close(); };
  draw();
}

// ---------- boot ----------
async function bootSequence(snapshot) {
  const log = document.getElementById('boot-log');
  const bar = document.querySelector('.boot-bar i');
  const m = snapshot.model;
  const lines = [
    `[<b>OK</b>] neural lattice online`,
    `[<b>OK</b>] ${snapshot.accounts.length} account link${snapshot.accounts.length === 1 ? '' : 's'} established`,
    `[<b>OK</b>] ${m.totals.files} transcripts decoded · ${m.totals.messages.toLocaleString()} messages deduped`,
    `[<b>OK</b>] cost matrix resolved · ${money(m.totals.cost)} across ${m.projects.length} projects`,
    `[<b>OK</b>] memory vault mounted · ${snapshot.notesCount} engrams`,
    `[<b>OK</b>] ENGRAM ready`,
  ];
  const fast = snapshot.settings.effects === 'off' || new URLSearchParams(location.search).has('nosplash');
  for (let i = 0; i < lines.length; i++) {
    log.innerHTML += lines[i] + '\n';
    bar.style.right = `${100 - ((i + 1) / lines.length) * 100}%`;
    if (!fast) await new Promise((r) => setTimeout(r, 170));
  }
  if (!fast) await new Promise((r) => setTimeout(r, 250));
  document.getElementById('boot').classList.add('done');
}

async function init() {
  const snap = await call(api.init);
  state.demo = snap.demo;
  state.platform = snap.platform;
  applySnapshot(snap);
  document.getElementById('ver').textContent = 'v' + snap.version;
  if (snap.demo) document.querySelector('.rail-foot').insertAdjacentHTML('afterbegin', '<div class="demo-flag">DEMO DATA</div>');

  startBackground(document.getElementById('bg'), () => state.settings.effects || 'full');

  document.querySelectorAll('#rail a').forEach((a) => { a.onclick = () => go(a.dataset.view); });
  document.querySelectorAll('[data-win]').forEach((b) => { b.onclick = () => api.win[b.dataset.win](); });
  document.getElementById('rescan').onclick = () => rescan();
  document.getElementById('palette-open').onclick = openPalette;
  document.getElementById('rescan').innerHTML = `${icon('refresh')}RESCAN`;
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); rescan(); }
    if (e.key === 'Escape') { document.getElementById('modal-root').innerHTML = ''; }
  });
  api.onModel((s) => {
    applySnapshot(s);
    const lbl = document.getElementById('live-label');
    lbl.textContent = 'SYNCED ' + new Date().toLocaleTimeString();
    if (['nexus', 'projects', 'recordings'].includes(state.view)) rerender();
  });

  const params = new URLSearchParams(location.search);
  go(params.get('view') || 'nexus');
  await bootSequence(snap);
}

init().catch((e) => {
  document.getElementById('boot-log').textContent = 'BOOT FAILURE: ' + e.message;
});
