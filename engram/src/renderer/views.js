import { state, call, go, toast, modal, acct, activeAccount, applySnapshot, rerender, rescan } from './app.js';
import { esc, money, tokens, ago, dur, when, icon, md, countUp } from './util.js';
import { stackedArea, donut, sparkline, gauge, heatmap, SERIES, showTip, hideTip } from './charts.js';

const api = window.engram;
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => [...root.querySelectorAll(sel)];

function lastNDays(n) {
  const out = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getTime() - i * 86400000);
    out.push(x.toISOString().slice(0, 10));
  }
  return out;
}

function accountSeries() {
  // Local accounts always; other laptops' accounts once they have spend.
  return state.model.accounts.filter((a) => !a.remote || a.cost > 0).map((a) => ({ id: a.id, name: a.name, color: a.color }));
}

/** Notes belong to a project by key (git remote) or by any folder path it has had. */
const projectOfNote = (n) => state.model.projects.find((p) => p.key === n.project || (p.paths || []).includes(n.project));

function modelColor(label, allLabels) {
  const i = allLabels.indexOf(label);
  return SERIES[(i < 0 ? 0 : i) % SERIES.length];
}

function head(kicker, title, desc, actions = '') {
  return `<div class="page-head"><div><h1><small>${kicker}</small>${title}</h1>${desc ? `<p>${desc}</p>` : ''}</div><div class="actions">${actions}</div></div>`;
}

function panelHead(n, title, tools = '') {
  return `<div class="panel-h"><h3><b>${n}</b>${title}</h3><div class="tools">${tools}</div></div>`;
}

// ---------- insights: what ENGRAM would tell you ----------
function insights() {
  const m = state.model;
  const out = [];
  const d = state.drive || {};
  if (d.available && d.letter && !d.letter.ok) {
    out.push({ c: 'var(--yellow)', i: 'alert', t: `Drive is ${d.letter.actual} here, ${d.letter.expected} on your other laptop`, p: 'Give it the same letter on both laptops so Claude Code matches your project paths and sessions.', act: { label: 'HOW TO FIX', run: () => go('bridge') } });
  }
  if (d.available && !d.shared) {
    out.push({ c: 'var(--green)', i: 'folder', t: 'Keep Claude sessions on this drive', p: 'One click and both laptops, on either account, continue the same Claude Code sessions.', act: { label: 'SHARE SESSIONS ON THIS DRIVE', run: () => shareOnDrive() } });
  }
  if (m.totals.saved > 0) {
    out.push({ c: 'var(--green)', i: 'bolt', t: `Prompt caching saved ${money(m.totals.saved)}`, p: `${(m.totals.cacheEfficiency * 100).toFixed(0)}% of input-equivalent spend was served from cache. Keep sessions warm and avoid editing early context.` });
  }
  const { cost, projected, budget } = m.month;
  if (budget && projected > budget) {
    out.push({ c: 'var(--red)', i: 'alert', t: `On pace for ${money(projected, 0)} this month`, p: `That is ${((projected / budget - 1) * 100).toFixed(0)}% over your ${money(budget, 0)} budget. Largest driver: ${m.projects[0]?.name || '—'}.` });
  } else if (budget) {
    out.push({ c: 'var(--cyan)', i: 'check', t: `Within budget: ${money(cost)} of ${money(budget, 0)}`, p: `Projected month end ${money(projected, 0)} (${((projected / budget) * 100).toFixed(0)}% of budget).` });
  }
  const top = m.models[0];
  const share = top && m.totals.cost ? top.cost / m.totals.cost : 0;
  if (top && share > 0.3 && /Opus|Fable|Mythos/.test(top.label)) {
    out.push({ c: 'var(--yellow)', i: 'bolt', t: `${top.label} drives ${(share * 100).toFixed(0)}% of spend`, p: `Routine edits and searches run well on Sonnet 5 at a fraction of the price. Reserve ${top.label} for hard reasoning.` });
  }
  const errProj = [...m.projects].sort((a, b) => b.errors - a.errors)[0];
  if (errProj && errProj.errors >= 5) {
    out.push({ c: 'var(--magenta)', i: 'fusion', t: `${errProj.name}: ${errProj.errors} tool errors recorded`, p: 'Fuse its sessions into a capsule so the next run starts with the known pitfalls instead of rediscovering them.', act: { label: 'FUSE PROJECT', run: () => fuseProject(errProj.key) } });
  }
  const multi = m.projects.filter((p) => Object.keys(p.accounts).length > 1);
  if (multi.length && state.accounts.length > 1) {
    out.push({ c: 'var(--violet)', i: 'bridge', t: `${multi.length} project${multi.length > 1 ? 's span' : ' spans'} both accounts`, p: 'Run the session bridge so either account can resume any conversation with full context.', act: { label: 'OPEN BRIDGE', run: () => go('bridge') } });
  }
  return out;
}

async function fuseProject(key, title) {
  const ids = state.model.sessions.filter((s) => s.projectKey === key).map((s) => s.id);
  if (!ids.length) return toast('No sessions for that project', 'FUSION', 'var(--red)');
  const cap = await call(api.fusion.create, { ids, title });
  state.capsules.unshift(cap);
  toast(`${ids.length} sessions fused · ${cap.stats.capsuleTokens.toLocaleString()} tokens`, 'CAPSULE FORGED', 'var(--magenta)');
  go('fusion', { id: cap.id });
}

async function launch(opts = {}) {
  if (state.web) return copyLaunch(opts); // a web page cannot open a terminal
  const a = acct(opts.accountId || state.activeAccountId);
  try {
    const cmd = await call(api.launch.terminal, { accountId: a.id, projectPath: opts.projectPath, resumeId: opts.resumeId });
    toast(cmd, `LAUNCHED ON ${a.name}`, a.color);
  } catch { /* toast already shown */ }
}

async function copyLaunch(opts = {}) {
  const cmd = await call(api.launch.command, { accountId: opts.accountId || state.activeAccountId, projectPath: opts.projectPath, resumeId: opts.resumeId });
  await call(api.clipboard, cmd);
  toast(cmd, 'COMMAND COPIED', 'var(--green)');
}

/** Copy a session from another laptop into the active account here, then resume it. */
async function bringHere(s, localPath) {
  const a = activeAccount();
  const r = await call(api.sync.bringHere, { sessionId: s.id, accountId: a.id, localPath });
  if (r.needFolder) {
    toast(`Pick the folder where ${r.project} is checked out on this laptop.`, 'WHERE IS THIS PROJECT?', 'var(--yellow)');
    const dir = await call(api.pickFolder);
    if (dir) return bringHere(s, dir);
    return;
  }
  if (r.launchError) toast(`Session copied to this laptop. Paste the command (already copied) into a terminal: ${r.cmd}`, 'READY TO RESUME', 'var(--yellow)');
  else toast(r.cmd, `RESUMED ON ${a.name}`, a.color);
  setTimeout(() => rescan(true), 900);
}

// =====================================================================
// NEXUS
// =====================================================================
function nexus(root) {
  const m = state.model;
  const days = lastNDays(45);
  const byDay = Object.fromEntries(m.daily.map((d) => [d.date, d]));
  const series = accountSeries();
  const chartDays = days.map((d) => ({ date: d, values: byDay[d]?.byAccount || {} }));
  const spark30 = days.slice(-30).map((d) => byDay[d]?.cost || 0);
  const week = days.slice(-7).reduce((a, d) => a + (byDay[d]?.cost || 0), 0);
  const prevWeek = days.slice(-14, -7).reduce((a, d) => a + (byDay[d]?.cost || 0), 0);
  const wow = prevWeek ? (week / prevWeek - 1) * 100 : 0;
  const budgetFrac = m.month.budget ? m.month.cost / m.month.budget : 0;
  const modelLabels = m.models.map((x) => x.label);
  const a = activeAccount();

  root.innerHTML = `
    ${head('CLAUDE COMMAND CENTER', 'NEXUS', `Every token, every session, every account — one memory. Signed in as <b style="color:${a.color}">${esc(a.name)}</b>.`,
      `<button class="btn ghost" id="nx-fuse">${icon('fusion')}FUSE LAST 5</button><button class="btn" id="nx-launch">${icon('term')}LAUNCH CLAUDE</button>`)}
    <div class="grid g-kpi">
      <div class="panel kpi hero"><div class="label">TOTAL SPEND</div><div class="value" data-count="${m.totals.cost}" data-fmt="money">$0</div><div class="sub">${m.totals.messages.toLocaleString()} API calls</div>${sparkline(spark30, { color: '#00f0ff' })}</div>
      <div class="panel kpi mag"><div class="gauge-wrap">${gauge(budgetFrac, { color: '#ff2bd6', label: 'BUDGET' })}<div><div class="label">MONTH TO DATE</div><div class="value" style="font-size:26px" data-count="${m.month.cost}" data-fmt="money">$0</div><div class="sub">of ${money(m.month.budget, 0)} · proj. ${money(m.month.projected, 0)}</div></div></div></div>
      <div class="panel kpi grn"><div class="label">CACHE SAVINGS</div><div class="value" style="color:var(--green);text-shadow:0 0 14px rgba(61,255,154,.45)" data-count="${m.totals.saved}" data-fmt="money">$0</div><div class="sub">${(m.totals.cacheEfficiency * 100).toFixed(1)}% efficiency</div></div>
      <div class="panel kpi vio"><div class="label">TOKENS PROCESSED</div><div class="value" data-count="${m.totals.totalTokens}" data-fmt="tok">0</div><div class="sub">${tokens(m.totals.tokens.output)} out · ${tokens(m.totals.tokens.cacheRead)} cached</div></div>
      <div class="panel kpi yel"><div class="label">LAST 7 DAYS</div><div class="value" data-count="${week}" data-fmt="money">$0</div><div class="sub"><span class="${wow > 0 ? 'up' : 'down'}">${wow > 0 ? '▲' : '▼'} ${Math.abs(wow).toFixed(0)}%</span> vs prior week · ${m.totals.sessions} sessions</div></div>
    </div>
    <div class="grid g-2" style="margin-top:18px">
      <div class="panel">${panelHead('01', 'SPEND VECTOR · 45 DAYS', `<div class="legend">${series.map((s) => `<span><i style="--c:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`)}<div class="chart" id="nx-area"></div></div>
      <div class="panel" style="--pc:var(--magenta)">${panelHead('02', 'NEURAL FEED')}<div class="feed" id="nx-feed"></div></div>
    </div>
    <div class="grid g-3" style="margin-top:18px">
      <div class="panel">${panelHead('03', 'PROJECT BURN', '<button class="btn ghost small" data-go="projects">ALL</button>')}<div class="bars" id="nx-bars"></div></div>
      <div class="panel" style="--pc:var(--violet)">${panelHead('04', 'MODEL MIX')}<div class="row-flex" style="gap:22px"><div id="nx-donut"></div><div class="legend" style="flex-direction:column;gap:9px">${m.models.map((x) => `<span><i style="--c:${modelColor(x.label, modelLabels)}"></i>${esc(x.label)} <b style="margin-left:auto;padding-left:12px;color:var(--ink)">${money(x.cost)}</b></span>`).join('')}</div></div></div>
      <div class="panel" style="--pc:var(--green)">${panelHead('05', 'ACTIVITY MATRIX')}<div id="nx-heat"></div><div class="muted" style="font-size:12px;margin-top:10px">Spend by weekday and hour (local time).</div></div>
    </div>
    <div class="panel" style="margin-top:18px">${panelHead('06', 'LATEST RECORDINGS', '<button class="btn ghost small" data-go="recordings">ALL RECORDINGS</button>')}<div class="recent" id="nx-recent"></div></div>`;

  $$(root, '[data-count]').forEach((n) => countUp(n, +n.dataset.count, n.dataset.fmt === 'money' ? (v) => money(v) : (v) => tokens(Math.round(v))));

  const feed = $(root, '#nx-feed');
  insights().forEach((it) => {
    const d = document.createElement('div');
    d.className = 'insight';
    d.style.setProperty('--c', it.c);
    d.innerHTML = `${icon(it.i)}<div><b>${esc(it.t)}</b><p>${esc(it.p)}</p>${it.act ? `<div class="act"><button class="btn ghost small">${it.act.label}</button></div>` : ''}</div>`;
    if (it.act) d.querySelector('button').onclick = it.act.run;
    feed.appendChild(d);
  });

  stackedArea($(root, '#nx-area'), chartDays, series, { height: Math.max(270, feed.offsetHeight - 22) });

  const maxP = m.projects[0]?.cost || 1;
  $(root, '#nx-bars').innerHTML = m.projects.slice(0, 6).map((p, i) => {
    const segs = m.accounts.map((a) => ({ c: a.color, v: p.accounts[a.id] || 0, n: a.name })).filter((x) => x.v > 0);
    return `<div class="bar-row" data-key="${esc(p.key)}" data-label="${esc(p.name)}"><span class="name">${esc(p.name)}</span><span class="track">${segs.map((s) => `<i style="width:${(s.v / maxP) * 100}%;background:${s.c};box-shadow:0 0 8px ${s.c};animation-delay:${i * 80}ms" data-tip="${esc(s.n)}: ${money(s.v)}"></i>`).join('')}</span><span class="val">${money(p.cost)}</span></div>`;
  }).join('') || '<div class="empty">No projects yet</div>';
  $$(root, '.bar-row').forEach((r) => { r.onclick = () => go('project', { key: r.dataset.key, label: r.dataset.label }); });
  $$(root, '.bar-row i').forEach((i) => { i.onmousemove = (e) => showTip(`<div class="row">${esc(i.dataset.tip)}</div>`, e.clientX, e.clientY); i.onmouseleave = hideTip; });

  donut($(root, '#nx-donut'), m.models.map((x) => ({ label: x.label, value: x.cost, color: modelColor(x.label, modelLabels) })), { center: String(m.models.length), sub: 'MODELS', fmt: (v) => money(v) });
  heatmap($(root, '#nx-heat'), m.heat, (v) => money(v));

  $(root, '#nx-recent').innerHTML = m.sessions.slice(0, 7).map((s) => `<div class="recent-row" data-id="${s.id}" data-label="${esc(s.title)}"><span class="dot" style="--c:${acct(s.accountId).color}"></span><span class="t">${esc(s.title)}<small>${esc(s.projectName)} · ${ago(s.endedAt)} · ${dur(s.durationMs)}</small></span><span class="tag">${esc(Object.keys(s.modelMix)[0] || '')}</span><span class="cost">${money(s.cost)}</span></div>`).join('');
  $$(root, '.recent-row').forEach((r) => { r.onclick = () => go('replay', { id: r.dataset.id, label: r.dataset.label }); });
  $$(root, '[data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go); });
  $(root, '#nx-launch').onclick = () => launch();
  if (state.web) $(root, '#nx-launch').remove(); // needs a project folder: use RESUME in a recording
  $(root, '#nx-fuse').onclick = async () => {
    const ids = m.sessions.slice(0, 5).map((s) => s.id);
    const cap = await call(api.fusion.create, { ids, title: 'Latest 5 sessions — fused context' });
    state.capsules.unshift(cap);
    go('fusion', { id: cap.id });
  };
}

// =====================================================================
// PROJECTS
// =====================================================================
function projects(root) {
  const m = state.model;
  const days = lastNDays(30);
  root.innerHTML = `
    ${head('COST INTELLIGENCE', 'PROJECTS', 'Spend, tokens and memory per codebase — across every linked account.')}
    <div class="toolbar"><input class="input grow" id="pj-q" placeholder="Filter projects…" /><select class="select" id="pj-sort"><option value="cost">Sort: spend</option><option value="recent">Sort: recent</option><option value="sessions">Sort: sessions</option><option value="name">Sort: name</option></select></div>
    <div class="cards" id="pj-cards"></div>`;
  const draw = () => {
    const q = $(root, '#pj-q').value.toLowerCase();
    const sort = $(root, '#pj-sort').value;
    const list = m.projects.filter((p) => (p.name + ' ' + p.path).toLowerCase().includes(q)).sort((a, b) =>
      sort === 'recent' ? (b.lastActive || '').localeCompare(a.lastActive || '') : sort === 'sessions' ? b.sessions - a.sessions : sort === 'name' ? a.name.localeCompare(b.name) : b.cost - a.cost);
    $(root, '#pj-cards').innerHTML = list.map((p, i) => {
      const segs = m.accounts.map((a) => ({ c: a.color, v: p.accounts[a.id] || 0 })).filter((x) => x.v > 0);
      return `<div class="panel pcard" data-key="${esc(p.key)}" data-label="${esc(p.name)}" style="animation-delay:${i * 40}ms">
        <div class="rank">${String(i + 1).padStart(2, '0')}</div>
        <h4>${esc(p.name)}</h4><div class="path">${esc(p.path || '')}</div>
        <div class="row"><div><div class="big">${money(p.cost)}</div><div class="meta"><span>${p.sessions} sessions · ${tokens(p.totalTokens)} tok</span><span>${p.fileCount} files · active ${ago(p.lastActive)}</span></div></div>${sparkline(days.map((d) => p.daily[d] || 0), { color: '#ff2bd6' })}</div>
        <div class="split">${segs.map((s) => `<i style="flex:${s.v};--c:${s.c}"></i>`).join('')}</div></div>`;
    }).join('') || '<div class="empty"><h4>NO PROJECTS</h4>Run Claude Code in a project, or add an account in BRIDGE.</div>';
    $$(root, '.pcard').forEach((c) => { c.onclick = () => go('project', { key: c.dataset.key, label: c.dataset.label }); });
  };
  $(root, '#pj-q').oninput = draw;
  $(root, '#pj-sort').onchange = draw;
  draw();
}

async function project(root, { key }) {
  const m = state.model;
  const p = m.projects.find((x) => x.key === key);
  if (!p) { go('projects'); return; }
  const sessions = m.sessions.filter((s) => s.projectKey === key);
  const notes = (await call(api.notes.list, {})).filter((n) => n.scope === 'global' || projectOfNote(n)?.key === key);
  const days = lastNDays(45);
  const series = accountSeries();
  const chartDays = days.map((d) => {
    const values = {};
    for (const s of sessions) if (s.daily[d]) {
      for (const [aid, c] of Object.entries(s.accountCost)) values[aid] = (values[aid] || 0) + (s.daily[d] * c) / (s.cost || 1);
    }
    return { date: d, values };
  });
  const labels = Object.keys(p.models).sort((a, b) => p.models[b] - p.models[a]);
  const allLabels = m.models.map((x) => x.label);

  root.innerHTML = `
    ${head('PROJECT DOSSIER', esc(p.name), `<span class="mono" style="font-size:12px">${esc(p.path || '')}</span>`,
      `<button class="btn ghost" id="pd-back">${icon('back')}BACK</button><button class="btn ghost" id="pd-open">${icon('folder')}OPEN</button><button class="btn ghost" id="pd-note">${icon('plus')}DIRECTIVE</button><button class="btn mag" id="pd-fuse">${icon('fusion')}FUSE ALL</button><button class="btn" id="pd-launch">${icon('term')}LAUNCH HERE</button>`)}
    <div class="grid g-kpi">
      <div class="panel kpi hero"><div class="label">SPEND</div><div class="value">${money(p.cost)}</div><div class="sub">${((p.cost / (m.totals.cost || 1)) * 100).toFixed(1)}% of total</div></div>
      <div class="panel kpi mag"><div class="label">SESSIONS</div><div class="value">${p.sessions}</div><div class="sub">avg ${money(p.cost / (p.sessions || 1))} / session</div></div>
      <div class="panel kpi grn"><div class="label">CACHE SAVED</div><div class="value" style="color:var(--green)">${money(p.saved)}</div><div class="sub">${tokens(p.tokens.cacheRead)} cached reads</div></div>
      <div class="panel kpi vio"><div class="label">TOKENS</div><div class="value">${tokens(p.totalTokens)}</div><div class="sub">${tokens(p.tokens.output)} generated</div></div>
      <div class="panel kpi yel"><div class="label">ERRORS HIT</div><div class="value" style="color:${p.errors ? 'var(--red)' : 'var(--ink)'}">${p.errors}</div><div class="sub">${p.fileCount} files touched</div></div>
    </div>
    <div class="grid g-2" style="margin-top:18px">
      <div class="panel">${panelHead('01', 'SPEND BY ACCOUNT · 45 DAYS', `<div class="legend">${series.map((s) => `<span><i style="--c:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`)}<div class="chart" id="pd-area"></div></div>
      <div class="panel" style="--pc:var(--violet)">${panelHead('02', 'MODEL MIX')}<div class="row-flex" style="gap:20px"><div id="pd-donut"></div><div class="legend" style="flex-direction:column;gap:9px">${labels.map((l) => `<span><i style="--c:${modelColor(l, allLabels)}"></i>${esc(l)}<b style="margin-left:auto;padding-left:12px;color:var(--ink)">${money(p.models[l])}</b></span>`).join('')}</div></div></div>
    </div>
    <div class="grid g-2" style="margin-top:18px">
      <div class="panel">${panelHead('03', 'SESSIONS')}<div class="scroll" style="max-height:420px;overflow:auto"><table class="table"><thead><tr><th>SESSION</th><th>ACCT</th><th>WHEN</th><th class="num">TOKENS</th><th class="num">COST</th></tr></thead><tbody>
        ${sessions.map((s) => `<tr data-id="${s.id}" data-label="${esc(s.title)}"><td class="title-cell"><b>${esc(s.title)}</b><small>${dur(s.durationMs)} · ${s.turns.user} prompts · ${s.errorCount} errors</small></td><td><span class="dot" style="--c:${acct(s.accountId).color}"></span></td><td class="mono" style="font-size:12px">${when(s.startedAt)}</td><td class="num">${tokens(s.totalTokens)}</td><td class="num cost">${money(s.cost)}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div class="panel" style="--pc:var(--magenta)">${panelHead('04', 'PROJECT MEMORY', `<span class="tag m">${notes.length} ENGRAMS</span>`)}<div class="feed">${notes.map((n) => `<div class="insight kind-${n.kind}" data-note="${n.id}" style="cursor:pointer">${icon(n.pinned ? 'pin' : 'vault')}<div><b>${esc(n.title)}</b><p>${esc(n.body.replace(/[#*`>]/g, '').slice(0, 140))}</p></div></div>`).join('') || '<div class="empty"><h4>NO MEMORY YET</h4>Add directives so Claude never forgets how this project works.</div>'}</div></div>
    </div>`;

  stackedArea($(root, '#pd-area'), chartDays, series, { height: 240 });
  donut($(root, '#pd-donut'), labels.map((l) => ({ label: l, value: p.models[l], color: modelColor(l, allLabels) })), { center: money(p.cost, 0), sub: 'SPEND', fmt: (v) => money(v), size: 170 });
  $$(root, 'tr[data-id]').forEach((r) => { r.onclick = () => go('replay', { id: r.dataset.id, label: r.dataset.label }); });
  $$(root, '[data-note]').forEach((n) => { n.onclick = () => go('vault', { id: n.dataset.note }); });
  $(root, '#pd-back').onclick = () => go('projects');
  $(root, '#pd-open').onclick = () => api.openPath(p.path);
  if (state.web) $(root, '#pd-open').remove();
  $(root, '#pd-fuse').onclick = () => fuseProject(key, `${p.name} — project memory capsule`);
  $(root, '#pd-launch').onclick = () => launch({ projectPath: p.path });
  $(root, '#pd-note').onclick = () => go('vault', { new: true, project: key, kind: 'directive' });
  if (!p.localPath) { $(root, '#pd-launch').disabled = true; $(root, '#pd-open').disabled = true; $(root, '#pd-launch').title = 'Not checked out on this laptop'; }
}

// =====================================================================
// RECORDINGS
// =====================================================================
function recordings(root, params) {
  const m = state.model;
  const sel = state.selected;
  root.innerHTML = `
    ${head('SESSION ARCHIVE', 'RECORDINGS', 'Every Claude Code session from every account — archived by ENGRAM so nothing is lost when transcripts expire. Select several to fuse them.')}
    <div class="toolbar">
      <input class="input grow" id="rc-q" placeholder="Search prompts, titles, branches…" value="${esc(params.q || '')}" />
      <select class="select" id="rc-proj"><option value="">All projects</option>${m.projects.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}</select>
      <select class="select" id="rc-acct"><option value="">All accounts</option>${m.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
    </div>
    <div class="panel" style="padding:6px 8px 10px"><div class="scroll" style="max-height:calc(100vh - 330px);overflow:auto"><table class="table" id="rc-table"><thead><tr>
      <th style="width:34px"></th><th data-sort="title">SESSION</th><th data-sort="projectName">PROJECT</th><th>ACCOUNT</th><th>MODELS</th><th data-sort="startedAt">STARTED</th><th data-sort="durationMs" class="num">DURATION</th><th data-sort="totalTokens" class="num">TOKENS</th><th data-sort="cost" class="num">COST</th></tr></thead><tbody></tbody></table></div></div>
    <div id="rc-selbar"></div>`;
  let sortKey = 'startedAt';
  let dir = -1;
  const draw = () => {
    const q = $(root, '#rc-q').value.toLowerCase();
    const pj = $(root, '#rc-proj').value;
    const ac = $(root, '#rc-acct').value;
    const list = m.sessions.filter((s) => (!pj || s.projectKey === pj) && (!ac || s.accounts.includes(ac) || s.accountId === ac)
      && (!q || (s.title + ' ' + s.projectName + ' ' + (s.gitBranch || '')).toLowerCase().includes(q)))
      .sort((a, b) => { const x = a[sortKey], y = b[sortKey]; return (typeof x === 'number' ? x - y : String(x || '').localeCompare(String(y || ''))) * dir; });
    $$(root, 'th[data-sort]').forEach((th) => th.classList.toggle('sorted', th.dataset.sort === sortKey));
    $(root, '#rc-table tbody').innerHTML = list.slice(0, 500).map((s) => `<tr data-id="${s.id}" data-label="${esc(s.title)}" class="${sel.has(s.id) ? 'sel' : ''}">
      <td><label class="check"><input type="checkbox" data-pick="${s.id}" ${sel.has(s.id) ? 'checked' : ''}/></label></td>
      <td class="title-cell"><b>${esc(s.title)}</b><small>${esc(s.gitBranch || '')}${s.remote ? ` · <span style="color:var(--green)">@ ${esc(s.remote)}</span>` : ''}${s.archived ? ' · <span style="color:var(--yellow)">ARCHIVED</span>' : ''}${s.bridged ? ' · <span style="color:var(--violet)">BRIDGED</span>' : ''}${s.subagents ? ` · ${s.subagents} subagent` : ''}</small></td>
      <td class="nw">${esc(s.projectName)}</td>
      <td>${s.accounts.map((id) => `<span class="dot" title="${esc(acct(id).name)}" style="--c:${acct(id).color};margin-right:6px"></span>`).join('')}</td>
      <td class="nw">${Object.keys(s.modelMix).map((l) => `<span class="tag ${/Opus/.test(l) ? 'c' : /Fable|Mythos/.test(l) ? 'm' : /Sonnet/.test(l) ? 'v' : 'g'}" style="margin-right:4px">${esc(l)}</span>`).join('')}</td>
      <td class="mono" style="font-size:12px">${when(s.startedAt)}</td><td class="num">${dur(s.durationMs)}</td><td class="num">${tokens(s.totalTokens)}</td><td class="num cost">${money(s.cost)}</td></tr>`).join('');
    $$(root, 'tr[data-id]').forEach((r) => { r.onclick = (e) => { if (e.target.closest('.check')) return; go('replay', { id: r.dataset.id, label: r.dataset.label }); }; });
    $$(root, '[data-pick]').forEach((c) => { c.onchange = () => { c.checked ? sel.add(c.dataset.pick) : sel.delete(c.dataset.pick); c.closest('tr').classList.toggle('sel', c.checked); drawSel(); }; });
  };
  const drawSel = () => {
    const bar = $(root, '#rc-selbar');
    if (!sel.size) { bar.innerHTML = ''; return; }
    const cost = m.sessions.filter((s) => sel.has(s.id)).reduce((a, s) => a + s.cost, 0);
    bar.innerHTML = `<div class="sel-bar"><b>${sel.size} SELECTED</b><span class="muted">${money(cost)} of history</span><span class="sp"></span><button class="btn ghost small" id="rc-clear">CLEAR</button><button class="btn mag" id="rc-fuse">${icon('fusion')}FUSE INTO CAPSULE</button></div>`;
    $(bar, '#rc-clear').onclick = () => { sel.clear(); draw(); drawSel(); };
    $(bar, '#rc-fuse').onclick = async () => {
      const cap = await call(api.fusion.create, { ids: [...sel] });
      state.capsules.unshift(cap);
      sel.clear();
      toast(`${cap.stats.sessions} sessions → ${cap.stats.capsuleTokens.toLocaleString()} tokens`, 'CAPSULE FORGED', 'var(--magenta)');
      go('fusion', { id: cap.id });
    };
  };
  $$(root, 'th[data-sort]').forEach((th) => { th.onclick = () => { if (sortKey === th.dataset.sort) dir = -dir; else { sortKey = th.dataset.sort; dir = -1; } draw(); }; });
  $(root, '#rc-q').oninput = draw;
  $(root, '#rc-proj').onchange = draw;
  $(root, '#rc-acct').onchange = draw;
  draw();
  drawSel();
}

// =====================================================================
// REPLAY
// =====================================================================
async function replay(root, { id, autoplay = true, atEnd = false }) {
  const [rep, det] = await Promise.all([call(api.sessionReplay, id), call(api.sessionDetail, id)]);
  if (!rep) { root.innerHTML = '<div class="empty"><h4>RECORDING UNAVAILABLE</h4></div>'; return; }
  const s = rep.session;
  const events = rep.events;
  const a = acct(s.accountId);
  const act = activeAccount();
  const relP = (p) => (s.projectPath && p.startsWith(s.projectPath) ? p.slice(s.projectPath.length).replace(/^[\\/]/, '') : p);
  const files = Object.entries(det.files).map(([p, v]) => ({ p: relP(p), ...v, n: v.read + v.edit + v.write })).sort((x, y) => (y.edit + y.write) - (x.edit + x.write) || y.n - x.n);

  root.innerHTML = `
    ${head(`SESSION RECORDING · ${esc(s.projectName)}`, esc(s.title.length > 60 ? s.title.slice(0, 58) + '…' : s.title), `<span class="mono" style="font-size:12px">${esc(s.id)} · ${when(s.startedAt)} · recorded on <b style="color:${a.color}">${esc(a.name)}</b></span>`,
      `<button class="btn ghost" id="rp-back">${icon('back')}BACK</button>${s.remote || state.web ? '' : `<button class="btn ghost" id="rp-copy">${icon('copy')}RESUME CMD</button>`}<button class="btn mag" id="rp-fuse">${icon('fusion')}FUSE</button><button class="btn" id="rp-resume" style="background:${act.color};box-shadow:0 0 14px ${act.color}">${icon('term')}${state.web ? 'COPY RESUME COMMAND' : `${s.remote ? 'BRING HERE &amp; RESUME ON' : 'RESUME ON'} ${esc(act.name)}`}</button>`)}
    <div class="replay">
      <div class="panel stream">
        <div class="transport">
          <button class="play" id="rp-play">${icon('pause')}</button>
          <input type="range" class="scrub" id="rp-scrub" min="0" max="${events.length}" value="0" />
          <div class="speed" id="rp-speed">${[1, 4, 16, 64].map((x) => `<button data-s="${x}" class="${x === 4 ? 'on' : ''}">${x}×</button>`).join('')}</div>
          <button class="btn ghost small" id="rp-end">END</button>
          <div class="clock" id="rp-clock">0 / ${events.length}</div>
        </div>
        <div class="events" id="rp-events"></div>
      </div>
      <div class="side-stats">
        <div class="panel" style="--pc:var(--yellow)">${panelHead('01', 'TELEMETRY')}
          <div class="stat-grid">
            <div><label>COST</label><b style="color:var(--yellow)">${money(s.cost)}</b></div>
            <div><label>CACHE SAVED</label><b style="color:var(--green)">${money(s.saved)}</b></div>
            <div><label>TOKENS</label><b>${tokens(s.totalTokens)}</b></div>
            <div><label>CONTEXT</label><b>${tokens(s.contextTokens)}</b></div>
            <div><label>DURATION</label><b>${dur(s.durationMs)}</b></div>
            <div><label>API CALLS</label><b>${s.turns.assistant}</b></div>
          </div>
          <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">${Object.entries(s.modelMix).map(([l, c]) => `<span class="tag c">${esc(l)} · ${money(c)}</span>`).join('')}${s.accounts.map((id) => `<span class="tag" style="color:${acct(id).color};border-color:${acct(id).color}">${esc(acct(id).name)} · ${money(s.accountCost[id])}</span>`).join('')}</div>
        </div>
        <div class="panel" style="--pc:var(--violet)">${panelHead('02', `FILES TOUCHED · ${files.length}`)}<div class="filelist">${files.slice(0, 14).map((f) => `<div><span class="p" title="${esc(f.p)}">${esc(f.p)}</span>${f.write ? `<span class="tag g">W${f.write}</span>` : ''}${f.edit ? `<span class="tag y">E${f.edit}</span>` : ''}${f.read ? `<span class="tag">R${f.read}</span>` : ''}</div>`).join('') || '<span class="muted">No file operations</span>'}</div></div>
        <div class="panel" style="--pc:var(--red)">${panelHead('03', `PITFALLS · ${det.errors.length}`)}<div class="filelist">${det.errors.slice(0, 6).map((e) => `<div style="color:#ffb3c0;direction:ltr">${e.tool ? `<span class="tag r">${esc(e.tool)}</span>` : ''}<span style="flex:1">${esc(e.text.slice(0, 120))}</span></div>`).join('') || '<span class="muted">Clean run — no tool errors</span>'}</div></div>
      </div>
    </div>`;

  $(root, '.page-head h1').classList.add('sm');
  const box = $(root, '#rp-events');
  const scrub = $(root, '#rp-scrub');
  const clock = $(root, '#rp-clock');
  const playBtn = $(root, '#rp-play');
  let pos = atEnd ? events.length : 0; // atEnd: show the whole conversation (resume view)
  let speed = 4;
  let playing = autoplay && !atEnd;
  let timer = null;

  const evNode = (e, animate) => {
    const d = document.createElement('div');
    const kind = e.kind === 'text' ? e.role : e.kind;
    d.className = `ev ${kind}${e.isError ? ' err' : ''}${e.sidechain ? ' side' : ''}`;
    if (!animate) d.style.animation = 'none';
    const who = e.kind === 'tool_use' ? 'TOOL' : e.kind === 'tool_result' ? (e.isError ? 'ERROR' : 'RESULT') : e.role === 'user' ? 'OPERATOR' : 'CLAUDE';
    d.innerHTML = `<div class="who">${who}${e.sidechain ? '<br><span style="color:var(--muted)">AGENT</span>' : ''}</div><div class="body">${e.tool ? `<span class="tl">${esc(e.tool)}</span>` : ''}${esc(e.text)}</div>`;
    return d;
  };
  const typeInto = (node, full) => {
    const body = node.querySelector('.body');
    const prefix = body.querySelector('.tl')?.outerHTML || '';
    const chars = Math.max(1, Math.ceil(full.length / (30 / Math.sqrt(speed))));
    let i = 0;
    body.classList.add('cursor');
    const tick = () => {
      i = Math.min(full.length, i + chars);
      body.innerHTML = prefix + esc(full.slice(0, i));
      if (i < full.length && playing) requestAnimationFrame(tick);
      else { body.innerHTML = prefix + esc(full); body.classList.remove('cursor'); }
    };
    tick();
  };
  const update = () => {
    scrub.value = pos;
    scrub.style.setProperty('--p', (pos / Math.max(1, events.length)) * 100 + '%');
    const e = events[Math.max(0, pos - 1)];
    clock.textContent = `${pos} / ${events.length}${e && e.ts ? ' · ' + new Date(e.ts).toLocaleTimeString() : ''}`;
    playBtn.innerHTML = icon(playing ? 'pause' : 'play');
  };
  const rebuild = () => {
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    events.slice(0, pos).forEach((e) => frag.appendChild(evNode(e, false)));
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
    update();
  };
  const step = () => {
    if (pos >= events.length) { playing = false; update(); return; }
    const e = events[pos++];
    const n = evNode(e, true);
    box.appendChild(n);
    if (e.kind === 'text' && speed <= 16) typeInto(n, e.text);
    box.scrollTop = box.scrollHeight;
    update();
  };
  const loop = () => {
    clearTimeout(timer);
    if (!playing) return;
    step();
    const e = events[pos - 1];
    const base = e && e.kind === 'text' ? 900 : 380;
    timer = setTimeout(loop, base / speed);
  };
  playBtn.onclick = () => { playing = !playing; if (pos >= events.length && playing) { pos = 0; rebuild(); } update(); loop(); };
  scrub.oninput = () => { pos = +scrub.value; rebuild(); };
  $(root, '#rp-end').onclick = () => { playing = false; pos = events.length; rebuild(); };
  $$(root, '#rp-speed button').forEach((b) => { b.onclick = () => { speed = +b.dataset.s; $$(root, '#rp-speed button').forEach((x) => x.classList.toggle('on', x === b)); }; });
  $(root, '#rp-back').onclick = () => history.length && go('recordings');
  $(root, '#rp-resume').onclick = () => (s.remote ? bringHere(s) : launch({ projectPath: s.projectPath, resumeId: s.id }));
  if (!s.remote && !state.web) $(root, '#rp-copy').onclick = () => copyLaunch({ projectPath: s.projectPath, resumeId: s.id });
  $(root, '#rp-fuse').onclick = async () => { const cap = await call(api.fusion.create, { ids: [s.id] }); state.capsules.unshift(cap); go('fusion', { id: cap.id }); };
  if (atEnd) rebuild(); else update();
  loop();
  return () => { playing = false; clearTimeout(timer); };
}

// =====================================================================
// VAULT
// =====================================================================
async function vault(root, params) {
  const m = state.model;
  let notes = await call(api.notes.list, {});
  let current = null;
  const projOpts = (sel) => `<option value="">— none —</option>${m.projects.map((p) => `<option value="${esc(p.key)}" ${p.key === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;

  root.innerHTML = `
    ${head('MEMORY VAULT', 'VAULT', 'Directives, decisions and lessons. Everything defined here is remembered — injected into capsules and synced to every account.', `<button class="btn" id="vt-new">${icon('plus')}NEW ENGRAM</button>`)}
    <div class="vault">
      <div class="panel note-list">
        <input class="input" id="vt-q" placeholder="Search memory…" />
        <div class="row-flex" style="margin-top:10px"><select class="select" id="vt-kind"><option value="">All kinds</option><option value="directive">Directives</option><option value="decision">Decisions</option><option value="lesson">Lessons</option><option value="note">Notes</option></select><select class="select" id="vt-proj"><option value="">All projects</option>${m.projects.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}<option value="__global">Global</option></select></div>
        <div class="items" id="vt-items"></div>
      </div>
      <div class="panel editor" id="vt-editor" style="--pc:var(--magenta)"></div>
    </div>`;

  const drawList = () => {
    const q = $(root, '#vt-q').value.toLowerCase();
    const k = $(root, '#vt-kind').value;
    const pj = $(root, '#vt-proj').value;
    const list = notes.filter((n) => (!k || n.kind === k) && (!pj || (pj === '__global' ? n.scope === 'global' : projectOfNote(n)?.key === pj))
      && (!q || (n.title + ' ' + n.body + ' ' + n.tags.join(' ')).toLowerCase().includes(q)));
    $(root, '#vt-items').innerHTML = list.map((n) => `<div class="note-item kind-${n.kind} ${current && current.id === n.id ? 'active' : ''}" data-id="${n.id}">
      <h5>${n.pinned ? icon('pin') : ''}${esc(n.title)}</h5><p>${esc(n.body.replace(/[#*`>\n]/g, ' ').slice(0, 90))}</p>
      <div class="tags"><span class="tag ${n.kind === 'directive' ? 'm' : n.kind === 'decision' ? 'c' : n.kind === 'lesson' ? 'y' : 'v'}">${n.kind.toUpperCase()}</span>${n.scope === 'global' ? '<span class="tag g">GLOBAL</span>' : `<span class="tag">${esc((projectOfNote(n) || {}).name || 'unlinked')}</span>`}${n.tags.slice(0, 3).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div></div>`).join('') || '<div class="empty"><h4>EMPTY</h4>No engrams match.</div>';
    $$(root, '.note-item').forEach((it) => { it.onclick = () => edit(notes.find((n) => n.id === it.dataset.id)); });
  };

  const edit = (n) => {
    current = n;
    drawList();
    const ed = $(root, '#vt-editor');
    ed.innerHTML = `
      <input class="input title-input" id="ed-title" placeholder="Title" value="${esc(n.title)}" />
      <div class="row">
        <select class="select" id="ed-kind" style="width:150px">${['directive', 'decision', 'lesson', 'note'].map((k) => `<option ${n.kind === k ? 'selected' : ''} value="${k}">${k.toUpperCase()}</option>`).join('')}</select>
        <select class="select" id="ed-scope" style="width:150px"><option value="project" ${n.scope !== 'global' ? 'selected' : ''}>PROJECT</option><option value="global" ${n.scope === 'global' ? 'selected' : ''}>GLOBAL</option></select>
        <select class="select" id="ed-proj" style="width:210px">${projOpts(projectOfNote(n)?.key || n.project)}</select>
        <input class="input" id="ed-tags" style="flex:1;min-width:160px" placeholder="tags, comma separated" value="${esc(n.tags.join(', '))}" />
        <button class="icon-btn ${n.pinned ? 'on' : ''}" id="ed-pin" title="Pin">${icon('pin')}</button>
        ${n.id ? `<button class="icon-btn" id="ed-del" title="Delete">${icon('trash')}</button>` : ''}
        <button class="btn mag" id="ed-save">${icon('check')}SAVE</button>
      </div>
      <div class="split"><textarea class="input" id="ed-body" placeholder="Write in Markdown…">${esc(n.body)}</textarea><div class="md" id="ed-prev"></div></div>`;
    const prev = $(ed, '#ed-prev');
    const body = $(ed, '#ed-body');
    const renderPrev = () => { prev.innerHTML = md(body.value) || '<p class="muted">Preview</p>'; };
    body.oninput = renderPrev;
    renderPrev();
    let pinned = n.pinned;
    $(ed, '#ed-pin').onclick = (e) => { pinned = !pinned; e.currentTarget.classList.toggle('on', pinned); };
    const save = async () => {
      const saved = await call(api.notes.upsert, {
        id: n.id, title: $(ed, '#ed-title').value, body: body.value, kind: $(ed, '#ed-kind').value, scope: $(ed, '#ed-scope').value,
        project: $(ed, '#ed-proj').value || null, tags: $(ed, '#ed-tags').value.split(',').map((t) => t.trim()).filter(Boolean), pinned,
      });
      notes = await call(api.notes.list, {});
      toast(saved.title, 'ENGRAM STORED', 'var(--magenta)');
      edit(notes.find((x) => x.id === saved.id));
    };
    $(ed, '#ed-save').onclick = save;
    body.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } };
    const del = $(ed, '#ed-del');
    if (del) del.onclick = () => modal('DELETE ENGRAM', `<p>Permanently forget <b>${esc(n.title)}</b>?</p>`, { okLabel: 'DELETE', onOk: async () => {
      await call(api.notes.remove, n.id);
      notes = await call(api.notes.list, {});
      current = null;
      drawList();
      if (notes[0]) edit(notes[0]); else newNote();
    } });
  };
  const newNote = (o = {}) => edit({ title: '', body: '', kind: o.kind || 'note', scope: 'project', project: o.project || null, tags: [], pinned: false });

  $(root, '#vt-q').oninput = drawList;
  $(root, '#vt-kind').onchange = drawList;
  $(root, '#vt-proj').onchange = drawList;
  $(root, '#vt-new').onclick = () => newNote();
  if (params.new) newNote(params);
  else edit(notes.find((n) => n.id === params.id) || notes[0] || { title: '', body: '', kind: 'note', scope: 'project', project: null, tags: [], pinned: false });
}

// =====================================================================
// FUSION
// =====================================================================
function fusion(root, params) {
  const caps = state.capsules;
  let current = caps.find((c) => c.id === params.id) || caps[0];
  root.innerHTML = `
    ${head('CONTEXT FUSION', 'FUSION', 'Combine sessions from any account into one distilled context capsule. Start the next session with the capsule instead of re-reading history — fewer tokens, fewer repeated mistakes.',
      `<button class="btn" id="fz-new">${icon('plus')}NEW CAPSULE</button>`)}
    <div class="fusion">
      <div class="panel" style="--pc:var(--magenta)">${panelHead('01', `CAPSULES · ${caps.length}`)}<div id="fz-list"></div></div>
      <div id="fz-view"></div>
    </div>`;
  const drawList = () => {
    $(root, '#fz-list').innerHTML = caps.map((c) => `<div class="capsule-item ${current && c.id === current.id ? 'active' : ''}" data-id="${c.id}"><b>${esc(c.title)}</b><small>${c.stats.sessions} sessions · ${c.stats.capsuleTokens.toLocaleString()} tok · ${ago(c.createdAt)}</small></div>`).join('') || '<div class="empty"><h4>NO CAPSULES</h4>Select sessions in RECORDINGS, or forge one from a project.</div>';
    $$(root, '.capsule-item').forEach((n) => { n.onclick = () => { current = caps.find((c) => c.id === n.dataset.id); drawList(); drawView(); }; });
  };
  const drawView = () => {
    const v = $(root, '#fz-view');
    if (!current) { v.innerHTML = `<div class="panel"><div class="empty">${icon('fusion')}<h4>FORGE YOUR FIRST CAPSULE</h4>Pick sessions to fuse. ENGRAM keeps directives, goals, key files, commands and known pitfalls — and drops the noise.</div></div>`; return; }
    const st = current.stats;
    const ratio = st.rawTokens ? Math.min(1, st.capsuleTokens / st.rawTokens) : 1;
    const perLoad = (st.rawTokens - st.capsuleTokens) * (4 / 1e6); // Opus 5.5 input rate, uncached
    v.innerHTML = `<div class="panel">
      ${panelHead('02', esc(current.title.toUpperCase()), `<button class="icon-btn" id="fz-copy" title="Copy">${icon('copy')}</button><button class="btn ghost small" id="fz-export">EXPORT .MD</button><button class="btn mag small" id="fz-inject">${icon('inject')}INJECT INTO CLAUDE.md</button><button class="icon-btn" id="fz-del" title="Delete">${icon('trash')}</button>`)}
      <div class="compress">
        <div><label>RESUME CONTEXT</label><b>${tokens(st.rawTokens)}</b></div>
        <div><label>CAPSULE</label><b style="color:var(--cyan)">${tokens(st.capsuleTokens)}</b></div>
        <div><label>COMPRESSION</label><b style="color:var(--magenta)">${st.compression ? st.compression.toFixed(1) + '×' : '—'}</b></div>
        <div><label>SAVED PER LOAD</label><b style="color:var(--green)">${perLoad > 0 ? money(perLoad) : '—'}</b></div>
      </div>
      <div class="ratio-bar"><i style="width:${Math.max(1.5, ratio * 100)}%"></i></div>
      <div class="row-flex" style="gap:8px;margin-bottom:14px;flex-wrap:wrap">${current.accounts.map((id) => `<span class="tag" style="color:${acct(id).color};border-color:${acct(id).color}">${esc(acct(id).name)}</span>`).join('')}<span class="tag y">${st.prompts} goals</span><span class="tag v">${st.files} files</span><span class="tag c">${st.commands} commands</span><span class="tag r">${st.errors} pitfalls</span><span class="tag">${money(st.sourceCost)} of source history</span></div>
      <div class="md" style="max-height:calc(100vh - 470px);min-height:260px">${md(current.markdown)}</div></div>`;
    $(v, '#fz-copy').onclick = async () => { await call(api.clipboard, current.markdown); toast('Paste it as the first message of a new session.', 'CAPSULE COPIED', 'var(--green)'); };
    $(v, '#fz-export').onclick = async () => { const f = await call(api.fusion.export, current.id); if (f) toast(f, 'EXPORTED', 'var(--green)'); };
    $(v, '#fz-inject').onclick = () => {
      const opts = current.projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
      modal('INJECT INTO PROJECT MEMORY', `<p class="muted">Writes the capsule into <b>CLAUDE.md</b> inside an ENGRAM-managed block. Claude Code loads it automatically on <b>every</b> account that opens this project. Your own content in the file is kept.</p><div class="field"><span>PROJECT</span><select class="select" id="inj-p">${opts}</select></div>`, {
        okLabel: 'INJECT', onOk: async (r) => { const file = await call(api.fusion.inject, { id: current.id, projectPath: r.querySelector('#inj-p').value }); toast(file, 'MEMORY INJECTED', 'var(--magenta)'); },
      });
    };
    $(v, '#fz-del').onclick = async () => { await call(api.fusion.remove, current.id); state.capsules = state.capsules.filter((c) => c.id !== current.id); go('fusion'); };
  };
  $(root, '#fz-new').onclick = () => {
    const m = state.model;
    modal('FORGE CAPSULE', `<div class="form">
      <div class="field"><span>SOURCE</span><select class="select" id="nc-src"><option value="proj">All sessions of a project</option><option value="recent">Most recent sessions (any project)</option><option value="pick">Pick sessions manually…</option></select></div>
      <div class="field" id="nc-proj-f"><span>PROJECT</span><select class="select" id="nc-proj">${m.projects.map((p) => `<option value="${esc(p.key)}">${esc(p.name)} · ${p.sessions} sessions</option>`).join('')}</select></div>
      <div class="field"><span>HOW MANY (most recent)</span><input class="input" id="nc-n" type="number" min="1" max="200" value="10" /></div>
      <div class="field"><span>TITLE (optional)</span><input class="input" id="nc-title" placeholder="e.g. Checkout rewrite — handoff" /></div></div>`, {
      okLabel: 'FORGE', onOk: async (r) => {
        const src = r.querySelector('#nc-src').value;
        if (src === 'pick') { go('recordings'); toast('Tick sessions, then FUSE INTO CAPSULE.', 'SELECT SESSIONS'); return; }
        const n = +r.querySelector('#nc-n').value || 10;
        const pool = src === 'proj' ? m.sessions.filter((s) => s.projectKey === r.querySelector('#nc-proj').value) : m.sessions;
        const cap = await call(api.fusion.create, { ids: pool.slice(0, n).map((s) => s.id), title: r.querySelector('#nc-title').value || undefined });
        state.capsules.unshift(cap);
        go('fusion', { id: cap.id });
      },
    });
  };
  drawList();
  drawView();
}

// =====================================================================
// BRIDGE
// =====================================================================
function bridgeView(root, params) {
  const m = state.model;
  const accts = m.accounts.filter((a) => !a.remote);
  const remotes = m.accounts.filter((a) => a.remote);
  const W = 900;
  let nodes;
  let H = 220;
  if (remotes.length) {
    // This laptop's accounts on the left, other laptops' accounts on the right.
    H = Math.max(240, 170 * Math.max(accts.length, remotes.length) + 20);
    const col = (list, x) => list.map((a, i) => ({ ...a, x, y: (H / (list.length + 1)) * (i + 1) }));
    nodes = [...col(accts, 150), ...col(remotes, W - 150)];
  } else {
    nodes = accts.map((a, i) => ({ ...a, x: i % 2 === 0 ? 150 : W - 150, y: accts.length <= 2 ? H / 2 : 50 + Math.floor(i / 2) * 110 }));
  }

  root.innerHTML = `
    ${head('MULTI-ACCOUNT CONTEXT BRIDGE', 'BRIDGE', 'Switch Claude accounts without losing context. Sessions mirror across accounts so any of them can resume any conversation, and global directives sync into each account\'s memory.',
      `<button class="btn ghost" id="br-detect">${icon('search')}DETECT</button><button class="btn" id="br-add">${icon('plus')}LINK ACCOUNT</button>`)}
    <div class="panel" id="br-drive" style="margin-bottom:18px;--pc:var(--green)"></div>
    <div class="panel" style="margin-bottom:18px">
      <svg class="link-map" viewBox="0 0 ${W} ${H}" style="height:${H}px">
        <defs><radialGradient id="core-g"><stop offset="0" stop-color="#00f0ff" stop-opacity=".9"/><stop offset=".5" stop-color="#8b7bff" stop-opacity=".35"/><stop offset="1" stop-color="#ff2bd6" stop-opacity="0"/></radialGradient></defs>
        ${nodes.map((n) => `<path d="M${n.x},${n.y} C${(n.x + W / 2) / 2},${n.y} ${(n.x + W / 2) / 2},${H / 2} ${W / 2},${H / 2}" stroke="${n.color}" stroke-width="1.5" fill="none" opacity=".3"/><path class="flow" d="M${n.x},${n.y} C${(n.x + W / 2) / 2},${n.y} ${(n.x + W / 2) / 2},${H / 2} ${W / 2},${H / 2}" stroke="${n.color}" stroke-width="2" fill="none" style="filter:drop-shadow(0 0 4px ${n.color})"/>`).join('')}
        <circle cx="${W / 2}" cy="${H / 2}" r="70" fill="url(#core-g)"><animate attributeName="r" values="62;74;62" dur="3s" repeatCount="indefinite"/></circle>
        <g transform="translate(${W / 2 - 22},${H / 2 - 22}) scale(1.4)" style="color:#e6f1ff;filter:drop-shadow(0 0 8px #00f0ff)"><use href="#i-engram" width="32" height="32"/></g>
        <text x="${W / 2}" y="${H / 2 + 50}" text-anchor="middle" style="font:700 10px Orbitron;letter-spacing:4px;fill:#a9b8d6">SHARED MEMORY</text>
        ${nodes.map((n) => `<g transform="translate(${n.x},${n.y})"><polygon points="0,-30 26,-15 26,15 0,30 -26,15 -26,-15" fill="#05060b" stroke="${n.color}" stroke-width="2" style="filter:drop-shadow(0 0 10px ${n.color})"/><text y="5" text-anchor="middle" style="font:900 15px Orbitron;fill:${n.color}">${esc(n.name[0] || '?')}</text><text y="50" text-anchor="middle" style="font:700 11px Orbitron;letter-spacing:2px;fill:#e6f1ff">${esc(n.name.toUpperCase())}</text><text y="66" text-anchor="middle" style="font:11px 'JetBrains Mono';fill:#6c7a98">${money(n.cost)} · ${n.sessions} sessions${n.remote ? ' · other laptop' : ''}</text></g>`).join('')}
      </svg>
    </div>
    <div class="accounts">${accts.map((a) => `
      <div class="panel acct-card ${a.id === state.activeAccountId ? 'active-acct' : ''}" style="--c:${a.color}">
        <div class="top"><div class="avatar">${esc(a.name[0] || '?')}</div><div><h4>${esc(a.name)}</h4><div class="email">${esc(a.email || 'email unknown')}${a.plan ? ` · ${esc(a.plan).toUpperCase()}` : ''}</div></div>${a.id === state.activeAccountId ? '<span class="active-badge">ACTIVE</span>' : ''}</div>
        <div class="dir">${esc(a.configDir)}</div>
        <div class="nums"><div><label>SPEND</label><b style="color:var(--yellow)">${money(a.cost)}</b></div><div><label>SESSIONS</label><b>${a.sessions}</b></div><div><label>TOKENS</label><b>${tokens(a.tokens)}</b></div></div>
        <div class="btns">${a.id === state.activeAccountId ? '' : `<button class="btn small" data-switch="${a.id}" style="background:${a.color};box-shadow:0 0 12px ${a.color}">${icon('sync')}SWITCH</button>`}<button class="btn ghost small" data-launch="${a.id}">${icon('term')}TERMINAL</button><button class="btn ghost small" data-cmd="${a.id}">${icon('copy')}CMD</button><button class="btn ghost small" data-edit="${a.id}">EDIT</button><button class="btn danger small" data-unlink="${a.id}">UNLINK</button></div>
      </div>`).join('') || '<div class="panel"><div class="empty"><h4>NO ACCOUNTS LINKED</h4>Press DETECT to find Claude Code config folders.</div></div>'}</div>
    <div class="grid g-2e" style="margin-top:18px">
      <div class="panel" style="--pc:var(--violet)">${panelHead('01', 'SESSION BRIDGE', `<button class="btn ghost small" id="br-plan">PREVIEW</button><button class="btn small" id="br-sync">${icon('sync')}SYNC NOW</button>`)}
        <p class="muted" style="margin-top:0">Mirrors every transcript into every linked account's <span class="mono">projects/</span> folder. The most complete copy wins; costs stay attributed to the account that actually spent them.</p>
        <div class="plan-list" id="br-planlist"></div></div>
      <div class="panel" style="--pc:var(--green)">${panelHead('02', 'MEMORY SYNC', `<button class="btn small" id="br-mem" style="background:var(--green);box-shadow:0 0 12px var(--green)">${icon('vault')}SYNC MEMORY</button>`)}
        <p class="muted" style="margin-top:0">Writes your <b>global</b> pinned directives from the VAULT into each account's user-level <span class="mono">CLAUDE.md</span> (inside an ENGRAM block). Whatever account you sign into, Claude starts with the same rules.</p>
        <div class="cmd"><span id="br-cmd">…</span><button class="icon-btn" id="br-cmd-copy">${icon('copy')}</button></div>
        <p class="muted" style="font-size:12px">Launch command for the active account.</p></div>
    </div>
    <div class="panel" id="br-link" style="margin-top:18px;--pc:var(--yellow)"></div>`;
  drawLink($(root, '#br-link'));
  drawDrive($(root, '#br-drive'));

  call(api.launch.command, {}).then((c) => { $(root, '#br-cmd').textContent = c; }).catch(() => {});
  $(root, '#br-cmd-copy').onclick = () => copyLaunch();
  $$(root, '[data-switch]').forEach((b) => { b.onclick = async () => { const { switchAccount } = await import('./app.js'); await switchAccount(b.dataset.switch); go('bridge'); }; });
  $$(root, '[data-launch]').forEach((b) => { b.onclick = () => launch({ accountId: b.dataset.launch }); });
  $$(root, '[data-cmd]').forEach((b) => { b.onclick = () => copyLaunch({ accountId: b.dataset.cmd }); });
  $$(root, '[data-unlink]').forEach((b) => { b.onclick = () => modal('UNLINK ACCOUNT', '<p>ENGRAM stops scanning this account. Nothing on disk is deleted, and archived recordings stay in the vault.</p>', { okLabel: 'UNLINK', onOk: async () => { await call(api.accounts.remove, b.dataset.unlink); await rescan(true); } }); });
  $$(root, '[data-edit]').forEach((b) => { b.onclick = () => accountForm(accts.find((a) => a.id === b.dataset.edit)); });
  $(root, '#br-add').onclick = () => accountForm({});
  $(root, '#br-detect').onclick = async () => {
    const found = await call(api.accounts.detect);
    const fresh = found.filter((f) => !state.accounts.some((a) => a.configDir === f.configDir));
    if (!fresh.length) return toast(`${found.length} config folder(s) found — all already linked.`, 'DETECT');
    for (const f of fresh) await call(api.accounts.upsert, f);
    toast(`${fresh.length} new account(s) linked`, 'DETECT', 'var(--green)');
    await rescan(true);
  };
  const drawPlan = (plan, done) => {
    $(root, '#br-planlist').innerHTML = plan.length ? plan.slice(0, 200).map((p) => `<div><span class="dot" style="--c:${acct(p.from).color}"></span>→<span class="dot" style="--c:${acct(p.to).color}"></span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.sessionId)}</span><span class="tag ${p.reason === 'missing' ? 'v' : 'y'}">${p.reason.toUpperCase()}</span>${done ? '<span class="tag g">OK</span>' : ''}</div>`).join('') + (plan.length > 200 ? `<div class="muted">… ${plan.length - 200} more</div>` : '')
      : '<div style="color:var(--green)">✓ All accounts hold every session. Fully bridged.</div>';
  };
  $(root, '#br-plan').onclick = async () => drawPlan(await call(api.bridge.plan));
  const sync = async () => {
    const r = await call(api.bridge.sync);
    drawPlan(r.plan, true);
    toast(`${r.copied} transcript copies written`, 'SESSIONS BRIDGED', 'var(--violet)');
    await rescan(true);
  };
  $(root, '#br-sync').onclick = sync;
  $(root, '#br-mem').onclick = async () => {
    const r = await call(api.bridge.memory);
    toast(`${r.filter((x) => x.changed).length} of ${r.length} account memories updated`, 'MEMORY SYNCED', 'var(--green)');
  };
  if (params.autosync) sync(); else $(root, '#br-plan').click();
}

// ---------- SESSIONS ON THIS DRIVE ----------
export async function shareOnDrive() {
  const r = await call(api.drive.share);
  applySnapshot(r.snapshot);
  const moved = r.results.reduce((n, x) => n + (x.copied || 0), 0);
  toast(`${r.results.map((x) => x.name).join(', ')} now save${r.results.length === 1 ? 's' : ''} sessions to ${state.drive.target}. ${moved} existing session file(s) copied; originals kept as a backup.`, 'SESSIONS ON DRIVE', 'var(--green)');
  if (!r.letter.ok) toast(`This drive is ${r.letter.actual} here but was set up as ${r.letter.expected}. Change it to ${r.letter.expected} so project paths match.`, 'DRIVE LETTER', 'var(--yellow)');
  rerender();
}

function drawDrive(box) {
  const d = state.drive || {};
  if (!d.available) {
    box.innerHTML = `${panelHead('00', 'SESSIONS ON YOUR DRIVE')}
      <p style="margin-top:0">Keep your projects <b>and</b> your Claude Code sessions on your external drive. Then either laptop and either account can continue the same sessions.</p>
      <p class="muted" style="font-size:13px">Run ENGRAM from the drive and this is detected automatically, or choose the drive here.</p>
      <button class="btn" id="dv-choose">${icon('folder')}CHOOSE MY DRIVE</button>`;
    $(box, '#dv-choose').onclick = async () => { applySnapshot(await call(api.drive.choose)); rerender(); };
    return;
  }
  const letterBad = d.letter && !d.letter.ok;
  const rows = d.accounts.map((a) => {
    const label = { shared: '<span class="tag g">ON DRIVE</span>', local: '<span class="tag">ON THIS LAPTOP</span>', unplugged: '<span class="tag r">DRIVE UNPLUGGED</span>', 'other-link': '<span class="tag y">LINKED ELSEWHERE</span>', none: '<span class="tag">NO SESSIONS YET</span>' }[a.state] || a.state;
    return `<div class="set-row"><div><b>${esc(a.name)}</b><small class="mono" style="display:block">${esc(a.projects)}</small></div>${label}</div>`;
  }).join('');
  box.innerHTML = `${panelHead('00', 'SESSIONS ON THIS DRIVE', d.shared ? '<span class="tag g">READY</span>' : '')}
    ${letterBad ? `<div class="insight" style="--c:var(--yellow);margin-bottom:12px">${icon('alert')}<div><b>Drive letter is ${esc(d.letter.actual)} here, but ${esc(d.letter.expected)} on your other laptop</b><p>Claude Code finds sessions by the project's full path, so the drive needs the same letter everywhere. In Disk Management, right-click the drive → <i>Change Drive Letter and Paths…</i> → choose ${esc(d.letter.expected)}.</p><div class="act"><button class="btn ghost small" id="dv-disk">OPEN DISK MANAGEMENT</button></div></div></div>` : ''}
    <p style="margin-top:0">${d.shared
      ? `Claude Code on this laptop saves its conversations to <span class="mono">${esc(d.target)}</span>. Open a project on the drive and run <span class="mono">claude --continue</span> or <span class="mono">claude --resume</span> to pick up where either laptop left off.`
      : `One click makes Claude Code on this laptop save its conversations to <span class="mono">${esc(d.target)}</span>, next to your projects. It copies this laptop's existing sessions onto the drive (the originals are kept as a backup), links Claude Code to the drive, and tells Claude Code to keep sessions for 10 years instead of 30 days. Do it once on each laptop.`}</p>
    ${rows}
    <div class="row-flex" style="margin-top:14px;gap:10px;flex-wrap:wrap">
      ${d.shared ? '<button class="btn danger small" id="dv-unshare">STOP SHARING ON THIS LAPTOP</button>' : `<button class="btn" id="dv-share" style="background:var(--green);box-shadow:0 0 16px var(--green)">${icon('check')}SHARE SESSIONS ON THIS DRIVE</button>`}
      <span class="muted" style="font-size:12px">Close Claude Code first. Keep the drive plugged in while using Claude.</span>
    </div>`;
  const share = $(box, '#dv-share');
  if (share) share.onclick = async () => { share.disabled = true; try { await shareOnDrive(); } finally { share.disabled = false; } };
  const un = $(box, '#dv-unshare');
  if (un) un.onclick = () => modal('STOP SHARING ON THIS LAPTOP', '<p>Claude Code on this laptop goes back to a normal local folder, with copies of the sessions currently on the drive. Nothing on the drive is deleted.</p>', { okLabel: 'STOP SHARING', onOk: async () => { const r = await call(api.drive.unshare); applySnapshot(r.snapshot); rerender(); } });
  const disk = $(box, '#dv-disk');
  if (disk) disk.onclick = () => call(api.drive.diskManagement);
}

// ---------- LAPTOP LINK ----------
function drawLink(box) {
  const st = state.sync || {};
  const m = state.model;
  const localProjects = m.projects.filter((p) => p.localPath);
  const shared = st.projects ? localProjects.filter((p) => st.projects.includes(p.key)).length : localProjects.length;
  const tools = st.folder ? `<button class="btn small yel" id="lk-now">${icon('sync')}SYNC NOW</button>` : '';
  const seenAgo = (t) => (t ? ago(t) : 'never');
  // Portable copy (e.g. on a thumb drive): the vault itself travels between laptops.
  const drive = st.portable ? `
      <div class="insight" style="--c:var(--green);margin-bottom:14px">${icon('folder')}<div><b>Portable drive mode: no setup needed</b>
        <p>This copy of ENGRAM keeps everything in its own <span class="mono">ENGRAM-data</span> folder. Every laptop you run it on adds its sessions and history there, and sees the other laptops' history.</p>
        <p style="margin-top:6px">${(st.driveLaptops || []).length ? `Also used on: ${st.driveLaptops.map((x) => `<b>${esc(x.name)}</b> (last ${seenAgo(x.lastSeen)})`).join(', ')}` : 'Only this laptop so far. Run it from the drive on your other laptop to add that one.'}</p></div></div>
      <div class="set-row"><div><b>This laptop</b><small>How this laptop is labelled in the shared history.</small></div><input class="input" id="lk-name" style="width:220px" value="${esc(st.machine?.name || '')}" /></div>` : '';
  if (!st.folder) {
    box.innerHTML = `${panelHead('03', 'LAPTOP LINK')}${drive}
      ${st.portable ? '<h4 style="font:700 10px var(--f-display);letter-spacing:.25em;color:var(--muted);margin:18px 0 8px">OPTIONAL: ALSO SYNC THROUGH A NAS OR CLOUD FOLDER</h4>' : ''}
      <p style="margin-top:0">Share your history, sessions, vault and capsules with your <b>other laptop</b>. Pick a folder that <b>both</b> laptops can reach, such as a <b>NAS share</b> (for example <span class="mono">\\\\NAS\\engram</span>), a OneDrive, Dropbox or Google Drive folder, or a Syncthing folder. Then pick the <b>same</b> folder in ENGRAM on the other laptop.</p>
      <p class="muted" style="font-size:13px">Each laptop only writes its own sub-folder. Secrets like API keys, tokens and passwords are masked before anything is written. You choose which projects are shared.</p>
      <button class="btn yel" id="lk-folder">${icon('folder')}CHOOSE SHARED FOLDER</button>`;
  } else {
    const seen = seenAgo;
    box.innerHTML = `${panelHead('03', 'LAPTOP LINK', tools)}
      ${st.error ? `<div class="insight" style="--c:var(--red);margin-bottom:12px">${icon('alert')}<div><b>Sync problem</b><p>${esc(st.error)}</p></div></div>` : ''}
      ${drive || `<div class="set-row"><div><b>This laptop</b><small>Shown as this name on your other laptop.</small></div><input class="input" id="lk-name" style="width:220px" value="${esc(st.machine?.name || '')}" /></div>`}
      <div class="set-row"><div><b>Shared folder</b><small class="mono" style="display:block">${esc(st.folder)}</small></div><button class="btn ghost small" id="lk-folder">${icon('folder')}CHANGE</button><button class="btn danger small" id="lk-off">UNLINK</button></div>
      <div class="set-row"><div><b>What to share</b><small>Full history lets you replay and resume sessions from either laptop. Rules &amp; capsules shares only your vault and capsules.</small></div>
        <select class="select" id="lk-mode" style="width:210px"><option value="full" ${st.mode === 'full' ? 'selected' : ''}>FULL HISTORY</option><option value="memory" ${st.mode === 'memory' ? 'selected' : ''}>RULES &amp; CAPSULES ONLY</option></select></div>
      <div class="set-row"><div><b>Projects shared from this laptop</b><small>${st.projects ? `${shared} of ${localProjects.length} selected` : `All ${localProjects.length}, including new ones`}</small></div><button class="btn ghost small" id="lk-proj">CHOOSE</button></div>
      <div class="set-row"><div><b>Secrets</b><small>API keys, tokens, private keys and passwords are replaced with [REDACTED] in everything that leaves this laptop.</small></div><span class="tag g">MASKED</span></div>
      <div class="set-row"><div><b>Last sync</b><small>Sent ${seen(st.lastPush)} · received ${seen(st.lastPull)}${st.pushed ? ` · ${st.pushed.sessions} sessions shared` : ''}. Syncs automatically every 3 minutes.</small></div></div>
      <h4 style="font:700 10px var(--f-display);letter-spacing:.25em;color:var(--muted);margin:18px 0 8px">OTHER LAPTOPS</h4>
      ${(st.machines || []).length ? st.machines.map((x) => `<div class="recent-row" style="grid-template-columns:10px 1fr auto auto;cursor:default"><span class="dot" style="--c:${x.accounts[0]?.color || 'var(--yellow)'}"></span><span class="t">${esc(x.name)}<small>${esc(x.platform || '')} · ${x.accounts.map((a) => esc(a.name.split(' @ ')[0])).join(', ')} · ${x.projects.length} projects</small></span><span class="tag ${x.mode === 'memory' ? 'v' : 'g'}">${x.mode === 'memory' ? 'RULES ONLY' : `${x.sessions} SESSIONS`}</span><span class="muted mono" style="font-size:12px">seen ${seen(x.pushedAt)}</span></div>`).join('')
        : '<p class="muted" style="margin:0">No other laptop yet. In ENGRAM on your other laptop, open BRIDGE → LAPTOP LINK and pick this same shared folder.</p>'}`;
  }
  const apply = async (patch) => {
    applySnapshot(await call(api.sync.update, patch));
    rerender();
  };
  const pick = $(box, '#lk-folder');
  if (pick) pick.onclick = async () => {
    const dir = await call(api.pickFolder);
    if (dir) { await apply({ folder: dir }); toast(dir, 'LAPTOP LINK ON', 'var(--yellow)'); }
  };
  const nameBox = $(box, '#lk-name');
  if (nameBox) nameBox.onchange = (e) => apply({ machineName: e.target.value });
  if (!st.folder) return;
  $(box, '#lk-now').onclick = async () => { applySnapshot(await call(api.sync.now)); toast(`${(state.sync.machines || []).length} other laptop(s) · ${state.sync.pushed?.sessions ?? 0} sessions shared`, 'SYNCED', 'var(--yellow)'); rerender(); };
  $(box, '#lk-mode').onchange = (e) => apply({ mode: e.target.value });
  $(box, '#lk-off').onclick = () => modal('UNLINK LAPTOPS', '<p>This laptop stops syncing. Files already in the shared folder stay there, and your vault on this laptop keeps everything it received.</p>', { okLabel: 'UNLINK', onOk: () => apply({ folder: null }) });
  $(box, '#lk-proj').onclick = () => {
    const all = !st.projects;
    const r = modal('PROJECTS TO SHARE', `<div class="form">
      <label class="check"><input type="checkbox" id="pp-all" ${all ? 'checked' : ''}/> <span>All projects, including new ones</span></label>
      <div id="pp-list" class="scroll" style="max-height:320px;overflow:auto;display:grid;gap:8px;padding:6px 2px">${localProjects.map((p) => `<label class="check"><input type="checkbox" data-k="${esc(p.key)}" ${all || st.projects.includes(p.key) ? 'checked' : ''}/> <span>${esc(p.name)} <span class="muted mono" style="font-size:11px">${esc(p.localPath)}</span></span></label>`).join('') || '<span class="muted">No projects on this laptop yet.</span>'}</div>
      <p class="muted" style="font-size:12px;margin:0">Unticked projects' sessions are removed from the shared folder at the next sync.</p></div>`, {
      okLabel: 'SAVE', onOk: async (root) => {
        const keys = [...root.querySelectorAll('[data-k]')].filter((c) => c.checked).map((c) => c.dataset.k);
        await apply({ projects: root.querySelector('#pp-all').checked ? null : keys });
      },
    });
    const allBox = r.querySelector('#pp-all');
    const sync = () => r.querySelectorAll('[data-k]').forEach((c) => { c.disabled = allBox.checked; if (allBox.checked) c.checked = true; });
    allBox.onchange = sync;
    sync();
  };
}

function accountForm(a) {
  const colors = ['#00f0ff', '#ff2bd6', '#fcee0a', '#8b7bff', '#3dff9a', '#ff8a3d'];
  const r = modal(a.id ? 'EDIT ACCOUNT' : 'LINK CLAUDE ACCOUNT', `<div class="form">
    <div class="field"><span>NAME</span><input class="input" id="af-name" value="${esc(a.name || '')}" placeholder="e.g. WORK" /></div>
    <div class="field"><span>CLAUDE CONFIG FOLDER</span><div class="row-flex"><input class="input" id="af-dir" value="${esc(a.configDir || '')}" placeholder="C:\\Users\\you\\.claude-work" /><button class="btn ghost" id="af-pick">${icon('folder')}BROWSE</button></div>
      <small class="muted">Each account uses its own folder. Run <span class="mono">claude</span> with <span class="mono">CLAUDE_CONFIG_DIR</span> pointing at it once to sign in.</small></div>
    <div class="field"><span>COLOR</span><div class="row-flex" id="af-colors">${colors.map((c) => `<button class="icon-btn" data-c="${c}" style="background:${c};width:28px;height:28px;box-shadow:${(a.color || colors[0]) === c ? `0 0 0 2px #05060b, 0 0 0 4px ${c}` : 'none'}"></button>`).join('')}</div></div></div>`, {
    okLabel: a.id ? 'SAVE' : 'LINK', onOk: async (root) => {
      const configDir = root.querySelector('#af-dir').value.trim();
      if (!configDir) { toast('Choose a config folder', 'LINK', 'var(--red)'); return false; }
      await call(api.accounts.upsert, { ...a, name: root.querySelector('#af-name').value.trim() || 'ACCOUNT', configDir, color: chosen });
      await rescan(true);
    },
  });
  let chosen = a.color || colors[0];
  r.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => { chosen = b.dataset.c; r.querySelectorAll('[data-c]').forEach((x) => { x.style.boxShadow = x === b ? `0 0 0 2px #05060b, 0 0 0 4px ${x.dataset.c}` : 'none'; }); }; });
  r.querySelector('#af-pick').onclick = async () => { const d = await call(api.pickFolder); if (d) r.querySelector('#af-dir').value = d; };
}

// =====================================================================
// SETTINGS
// =====================================================================
async function settings(root) {
  const s = state.settings;
  const pricingRows = [
    ['claude-fable-5-1', 10, 50, 0.25], ['claude-opus-5-5', 4, 20, 0.2], ['claude-opus-5', 5, 25, 0.5], ['claude-sonnet-5', 2, 10, 0.2], ['claude-haiku-4-5', 1, 5, 0.1],
  ];
  const ov = s.pricingOverrides || {};
  const init = await call(api.init);
  root.innerHTML = `
    ${head('CORE CONFIGURATION', 'SYSTEM', 'Budgets, pricing, archive and visual effects.')}
    <div class="settings-grid">
      <div class="panel">${panelHead('01', 'OPERATIONS')}
        <div class="set-row"><div><b>Monthly budget (USD)</b><small>Drives the budget gauge and overspend alerts.</small></div><input class="input" id="st-budget" type="number" min="0" style="width:120px" value="${s.monthlyBudget}" /></div>
        <div class="set-row"><div><b>Archive recordings</b><small>Copy every transcript into the vault. Claude Code deletes old sessions; ENGRAM keeps them.</small></div><input type="checkbox" class="switch" id="st-arch" ${s.autoArchive ? 'checked' : ''} /></div>
        <div class="set-row"><div><b>Visual effects</b><small>Animated grid, glitch and scanlines. Reduce on low-power machines.</small></div><select class="select" id="st-fx" style="width:150px">${['full', 'reduced', 'off'].map((x) => `<option ${s.effects === x ? 'selected' : ''} value="${x}">${x.toUpperCase()}</option>`).join('')}</select></div>
        <div class="set-row"><div><b>Vault location</b>${init.portable ? ' <span class="tag g">PORTABLE</span>' : ''}<small class="mono" style="display:block">${esc(init.dataDir)}</small></div><button class="btn ghost small" id="st-open">${icon('folder')}OPEN</button></div>
      </div>
      <div class="panel" style="--pc:var(--yellow)">${panelHead('02', 'PRICING MATRIX · USD / 1M TOKENS')}
        <table class="table price-table"><thead><tr><th>MODEL</th><th class="num">INPUT</th><th class="num">OUTPUT</th><th class="num">CACHE READ</th></tr></thead><tbody>
          ${pricingRows.map(([id, i, o, r]) => { const p = ov[id] || {}; return `<tr data-model="${id}"><td class="mono" style="font-size:12px">${id}</td><td class="num"><input data-f="input" value="${p.input ?? i}"/></td><td class="num"><input data-f="output" value="${p.output ?? o}"/></td><td class="num"><input data-f="cacheRead" value="${p.cacheRead ?? r}"/></td></tr>`; }).join('')}
        </tbody></table>
        <p class="muted" style="font-size:12px">Cache writes are priced at 1.25× input (5-minute) and 2× input (1-hour). Older models use built-in list prices.</p>
        <button class="btn yel small" id="st-price">SAVE PRICING &amp; RESCAN</button>
      </div>
      <div class="panel span-2" style="--pc:var(--magenta)">${panelHead('03', 'ABOUT')}
        <p style="margin:0">ENGRAM ${esc(init.version)} · Claude command center. Reads Claude Code transcripts locally — nothing leaves this machine. Shortcuts: <span class="mono">Ctrl+K</span> palette · <span class="mono">Ctrl+R</span> rescan · <span class="mono">Ctrl+S</span> save engram.</p>
        <p style="margin:10px 0 0">Built by <a href="https://butchermedia.cc" target="_blank" rel="noopener">butchermedia.cc</a></p>
      </div>
    </div>`;
  const save = async (patch) => { state.settings = await call(api.settings.update, patch); document.body.dataset.effects = state.settings.effects; };
  $(root, '#st-budget').onchange = async (e) => { await save({ monthlyBudget: Math.max(0, +e.target.value || 0) }); await rescan(true); };
  $(root, '#st-arch').onchange = (e) => save({ autoArchive: e.target.checked });
  $(root, '#st-fx').onchange = (e) => save({ effects: e.target.value });
  $(root, '#st-open').onclick = () => api.openPath(init.dataDir);
  if (state.web) $(root, '#st-open').remove();
  $(root, '#st-price').onclick = async () => {
    const overrides = {};
    $$(root, 'tr[data-model]').forEach((tr) => {
      const g = (f) => +tr.querySelector(`[data-f="${f}"]`).value;
      const input = g('input');
      overrides[tr.dataset.model] = { input, output: g('output'), cacheRead: g('cacheRead'), cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
    });
    await save({ pricingOverrides: overrides });
    await rescan();
  };
}

export const views = { nexus, projects, project, recordings, replay, vault, fusion, bridge: bridgeView, settings };
