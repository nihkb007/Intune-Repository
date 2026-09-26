'use strict';
// Scans every registered account's transcripts (plus ENGRAM's own archive of recordings),
// dedupes API messages globally and produces the analytics model the UI renders.

const fs = require('fs');
const path = require('path');
const { parseTranscript, listTranscriptFiles, slugToPath, projectNameFrom } = require('./transcripts');
const { costOf, modelLabel, DEFAULT_PRICING } = require('./pricing');
const { gitRemote, codeRoots, findCheckouts, identity } = require('./sync');

const emptyTokens = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const addTokens = (t, u) => {
  t.input += u.input_tokens || 0;
  t.output += u.output_tokens || 0;
  t.cacheWrite += u.cache_creation_input_tokens || 0;
  t.cacheRead += u.cache_read_input_tokens || 0;
};
const tokSum = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;

class Scanner {
  constructor({ store, dataDir }) {
    this.store = store;
    this.archiveDir = path.join(dataDir, 'recordings');
    this.cache = new Map(); // file -> { size, mtimeMs, parsed }
    this.details = new Map(); // sessionId -> detail
    this.model = null;
    // Sessions from other laptops (see sync.js): [{ account, files, foreign: {sid: Set(keys)} }]
    this.extraSources = [];
    this.checkouts = null; // Map(remote -> local path), refreshed when remote projects need it
  }

  pricing() {
    return { ...DEFAULT_PRICING, ...(this.store.data.settings.pricingOverrides || {}) };
  }

  _parseFile(f) {
    const hit = this.cache.get(f.file);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return hit.parsed;
    let text;
    try { text = fs.readFileSync(f.file, 'utf8'); } catch { return null; }
    const parsed = parseTranscript(text);
    this.cache.set(f.file, { size: f.size, mtimeMs: f.mtimeMs, parsed });
    return parsed;
  }

  _archive(sessionId, accountId, f) {
    if (!this.store.data.settings.autoArchive || !sessionId || f.nested) return;
    const rec = this.store.data.recordings[sessionId];
    if (rec && rec.size === f.size && rec.source === f.file) return;
    // Transcripts only grow: never replace a more complete recording (e.g. one another
    // laptop continued) with a shorter copy.
    if (rec && rec.size > f.size) return;
    fs.mkdirSync(this.archiveDir, { recursive: true });
    const dest = path.join(this.archiveDir, `${sessionId}.jsonl`);
    try {
      fs.copyFileSync(f.file, dest);
      this.store.data.recordings[sessionId] = {
        accountId, source: f.file, slug: f.slug, size: f.size, archivedAt: new Date().toISOString(),
      };
    } catch { /* source vanished mid-scan */ }
  }

  scan() {
    const t0 = Date.now();
    const { bridgeLedger } = this.store.data;
    // Only this laptop's Claude folders are scanned. Accounts that belong to another laptop
    // (the vault can travel on a thumb drive) are seen through their archived recordings.
    const me = identity(this.store).id;
    const accounts = this.store.data.accounts.filter((a) => !a.machineId || a.machineId === me);
    const otherMachine = (accountId) => {
      const a = this.store.data.accounts.find((x) => x.id === accountId);
      return a && a.machineId && a.machineId !== me ? (this.store.data.machines?.[a.machineId]?.name || 'other laptop') : null;
    };
    const pricing = this.pricing();
    const bridgedCopies = new Set(Object.values(bridgeLedger).flatMap((l) => l.copies || []));
    const seenMsg = new Set();
    // Sessions brought over from another laptop: their original messages stay credited
    // to the account that ran them there.
    const imported = new Map(Object.entries(this.store.data.syncState?.imported || {})
      .filter(([, v]) => v.accountId).map(([sid, v]) => [sid, { keys: new Set(v.keys || []), accountId: v.accountId }]));
    const sessions = new Map();
    const sourceSeen = new Set();
    let files = 0;

    const ingest = (parsed, accountId, f, archived, skip) => {
      const s = parsed.session;
      const id = s.id || path.basename(f.file, '.jsonl');
      const origin = bridgeLedger[id]?.origin;
      let rec = sessions.get(id);
      if (!rec) {
        rec = {
          id,
          accountId: origin || accountId,
          file: f.file,
          archived: !!archived,
          projectPath: f.projectPath || s.projectPath || (f.slug ? slugToPath(f.slug) : null),
          remote: f.remoteMachine || null,
          projectKey: f.projectKey || null,
          gitRemote: f.gitRemote || null,
          localAccountId: null,
          title: s.title,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          gitBranch: s.gitBranch,
          version: s.version,
          cost: 0,
          saved: 0,
          tokens: emptyTokens(),
          models: {},
          daily: {},
          hours: [],
          turns: { user: 0, assistant: 0 },
          tools: {},
          fileCount: 0,
          errorCount: 0,
          subagents: 0,
          contextTokens: 0,
          _ctxTs: '',
          bridged: !!bridgeLedger[id],
          accountCost: {},
          dailyAcct: {},
        };
        sessions.set(id, rec);
        this.details.set(id, { prompts: [], files: {}, commands: [], errors: [], lastAssistantText: '' });
      }
      if (f.nested) rec.subagents++;
      if (!f.remoteMachine && !f.nested && !rec.localAccountId) {
        // Present on this laptop (possibly brought over from another one): use the local copy.
        rec.localAccountId = accountId;
        rec.file = f.file;
        rec.archived = !!archived;
        if (rec.remote) { rec.remote = null; rec.projectPath = s.projectPath || rec.projectPath; rec.projectKey = null; }
      }
      const d = this.details.get(id);
      if (!f.nested) {
        if (s.title && (!rec.title || rec.title === 'Untitled session')) rec.title = s.title;
        d.prompts.push(...s.prompts);
        if (s.lastAssistantText) d.lastAssistantText = s.lastAssistantText;
      }
      if (s.startedAt && (!rec.startedAt || s.startedAt < rec.startedAt)) rec.startedAt = s.startedAt;
      if (s.endedAt && (!rec.endedAt || s.endedAt > rec.endedAt)) rec.endedAt = s.endedAt;
      rec.turns.user += s.turns.user;
      for (const [k, v] of Object.entries(s.tools)) rec.tools[k] = (rec.tools[k] || 0) + v;
      for (const [fp, v] of Object.entries(s.files)) {
        const cur = (d.files[fp] = d.files[fp] || { read: 0, edit: 0, write: 0 });
        cur.read += v.read; cur.edit += v.edit; cur.write += v.write;
      }
      d.commands.push(...s.commands);
      d.errors.push(...s.errors);

      for (const u of parsed.usageEntries) {
        if (seenMsg.has(u.key) || (skip && skip.has(u.key))) continue;
        seenMsg.add(u.key);
        rec.turns.assistant++;
        const c = costOf(u.usage, u.model, pricing);
        const imp = imported.get(id);
        const acctId = bridgeLedger[id]?.attrib?.[u.key] || (imp && imp.keys.has(u.key) ? imp.accountId : accountId);
        rec.accountCost[acctId] = (rec.accountCost[acctId] || 0) + c.total;
        rec.cost += c.total;
        rec.saved += c.saved;
        addTokens(rec.tokens, u.usage);
        if (!u.side && u.ts && u.ts >= rec._ctxTs) {
          // Context window at the latest main-chain turn = what resuming this session reloads.
          rec._ctxTs = u.ts;
          rec.contextTokens = (u.usage.input_tokens || 0) + (u.usage.cache_read_input_tokens || 0) + (u.usage.cache_creation_input_tokens || 0);
        }
        const m = (rec.models[u.model] = rec.models[u.model] || { cost: 0, tokens: emptyTokens() });
        m.cost += c.total;
        addTokens(m.tokens, u.usage);
        if (u.ts) {
          const day = u.ts.slice(0, 10);
          rec.daily[day] = (rec.daily[day] || 0) + c.total;
          const da = (rec.dailyAcct[day] = rec.dailyAcct[day] || {});
          da[acctId] = (da[acctId] || 0) + c.total;
          const dt = new Date(u.ts);
          rec.hours.push([dt.getDay(), dt.getHours(), c.total]);
        }
      }
      rec.fileCount = Object.keys(d.files).length;
      rec.errorCount = d.errors.length;
    };

    // Other laptops first: a session brought here from another laptop is credited to the
    // account that ran it there (its "foreign" keys are skipped in re-exports coming back).
    for (const src of this.extraSources) {
      for (const f of src.files) {
        files++;
        const parsed = this._parseFile(f);
        if (!parsed) continue;
        ingest(parsed, src.account.id, { ...f, remoteMachine: src.account.machine }, false, src.foreign[parsed.session.id]);
      }
    }

    // Originals first, bridged copies after: a message only counts once, and messages that
    // exist solely in a copy were produced on that copy's account.
    const queue = accounts.flatMap((acct) => listTranscriptFiles(acct.configDir).map((f) => ({ acct, f })));
    queue.sort((x, y) => bridgedCopies.has(x.f.file) - bridgedCopies.has(y.f.file));
    for (const { acct, f } of queue) {
      files++;
      const parsed = this._parseFile(f);
      if (!parsed) continue;
      ingest(parsed, acct.id, f, false);
      const sid = parsed.session.id;
      if (sid && !f.nested) {
        sourceSeen.add(sid);
        if (!bridgedCopies.has(f.file)) this._archive(sid, acct.id, f);
      }
    }

    // Recordings whose original transcript is gone (Claude Code prunes old sessions):
    for (const [sid, rec] of Object.entries(this.store.data.recordings)) {
      // Also read recordings another laptop archived for a session we have locally: it may
      // hold that laptop's continuation (duplicated messages are skipped).
      if (sourceSeen.has(sid) && !otherMachine(rec.accountId)) continue;
      const file = path.join(this.archiveDir, `${sid}.jsonl`);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const machine = otherMachine(rec.accountId);
      const f = { file, slug: rec.slug, size: st.size, mtimeMs: st.mtimeMs, nested: false, remoteMachine: machine || undefined, projectPath: rec.projectPath };
      const parsed = this._parseFile(f);
      if (parsed) { files++; ingest(parsed, rec.accountId, f, !machine); }
    }
    this.store.save();

    this.model = this._aggregate([...sessions.values()], files, Date.now() - t0);
    return this.model;
  }

  _aggregate(sessionList, files, ms) {
    const me = identity(this.store).id;
    const accounts = [
      ...this.store.data.accounts.map((a) => (a.machineId && a.machineId !== me
        ? { ...a, remote: true, machine: this.store.data.machines?.[a.machineId]?.name || 'other laptop', name: `${a.name} @ ${this.store.data.machines?.[a.machineId]?.name || 'other laptop'}` }
        : a)),
      ...this.extraSources.map((x) => x.account),
    ];
    const projects = new Map();
    const daily = new Map();
    const models = new Map();
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
    const totals = { cost: 0, saved: 0, tokens: emptyTokens(), sessions: sessionList.length, messages: 0, files };
    const byAccount = {};

    for (const s of sessionList) {
      // The same repo can live at different paths on different laptops: group by git remote.
      const remoteUrl = s.remote ? (s.gitRemote || null) : gitRemote(s.projectPath);
      s.gitRemote = remoteUrl;
      s.projectKey = s.projectKey || (remoteUrl ? `git:${remoteUrl}` : s.projectPath || 'unknown');
      s.projectName = projectNameFrom(s.projectPath || remoteUrl);
      s.modelMix = Object.fromEntries(Object.entries(s.models).map(([k, v]) => [modelLabel(k), v.cost]));
      s.totalTokens = tokSum(s.tokens);
      s.durationMs = s.startedAt && s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.startedAt) : 0;
      totals.cost += s.cost;
      totals.saved += s.saved;
      totals.messages += s.turns.assistant;
      for (const k of Object.keys(totals.tokens)) totals.tokens[k] += s.tokens[k];
      const ba = (id) => (byAccount[id] = byAccount[id] || { cost: 0, sessions: 0, tokens: 0 });
      for (const [aid, c] of Object.entries(s.accountCost)) ba(aid).cost += c;
      ba(s.accountId).sessions++;
      ba(s.accountId).tokens += s.totalTokens;
      s.accounts = Object.keys(s.accountCost);

      const pk = s.projectKey;
      let p = projects.get(pk);
      if (!p) {
        p = { key: pk, path: s.projectPath, localPath: null, remote: remoteUrl, paths: [], name: s.projectName, cost: 0, saved: 0, tokens: emptyTokens(), sessions: 0, lastActive: null, firstActive: null, accounts: {}, models: {}, daily: {}, errors: 0, files: new Set() };
        projects.set(pk, p);
      }
      p.cost += s.cost;
      if (s.projectPath && !p.paths.includes(s.projectPath)) p.paths.push(s.projectPath);
      if (!s.remote && !p.localPath && s.projectPath && fs.existsSync(s.projectPath)) { p.localPath = s.projectPath; p.path = s.projectPath; }
      p.saved += s.saved;
      p.sessions++;
      p.errors += s.errorCount;
      for (const k of Object.keys(p.tokens)) p.tokens[k] += s.tokens[k];
      if (s.endedAt && (!p.lastActive || s.endedAt > p.lastActive)) p.lastActive = s.endedAt;
      if (s.startedAt && (!p.firstActive || s.startedAt < p.firstActive)) p.firstActive = s.startedAt;
      for (const [aid, c] of Object.entries(s.accountCost)) p.accounts[aid] = (p.accounts[aid] || 0) + c;
      for (const fp of Object.keys(this.details.get(s.id)?.files || {})) p.files.add(fp);

      for (const [m, v] of Object.entries(s.models)) {
        const label = modelLabel(m);
        p.models[label] = (p.models[label] || 0) + v.cost;
        const mm = models.get(label) || { label, ids: new Set(), cost: 0, tokens: 0, messages: 0 };
        mm.ids.add(m);
        mm.cost += v.cost;
        mm.tokens += tokSum(v.tokens);
        models.set(label, mm);
      }
      for (const [day, c] of Object.entries(s.daily)) {
        p.daily[day] = (p.daily[day] || 0) + c;
        const dd = daily.get(day) || { date: day, cost: 0, byAccount: {} };
        dd.cost += c;
        for (const [aid, ac] of Object.entries(s.dailyAcct[day] || {})) dd.byAccount[aid] = (dd.byAccount[aid] || 0) + ac;
        daily.set(day, dd);
      }
      for (const [dow, hr, c] of s.hours) heat[dow][hr] += c;
      delete s.hours;
      delete s.dailyAcct;
      delete s._ctxTs;
    }

    // Projects only seen on other laptops: look for a local checkout of the same repo.
    const missing = [...projects.values()].filter((p) => !p.localPath && p.remote);
    if (missing.length) {
      const stale = !this.checkouts || (missing.some((p) => !this.checkouts.has(p.remote)) && Date.now() - this._checkoutsAt > 10 * 60000);
      if (stale) { this.checkouts = findCheckouts(codeRoots(this.store)); this._checkoutsAt = Date.now(); }
      for (const p of missing) {
        const local = this.checkouts.get(p.remote);
        if (local) { p.localPath = local; p.path = local; }
      }
    }

    const now = new Date();
    const monthKey = now.toISOString().slice(0, 7);
    const mtd = [...daily.values()].filter((d) => d.date.startsWith(monthKey)).reduce((a, d) => a + d.cost, 0);
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const inputEquivalent = totals.cost + totals.saved;

    return {
      generatedAt: now.toISOString(),
      scanMs: ms,
      totals: { ...totals, totalTokens: tokSum(totals.tokens), cacheEfficiency: inputEquivalent ? totals.saved / inputEquivalent : 0 },
      month: { key: monthKey, cost: mtd, projected: dayOfMonth ? (mtd / dayOfMonth) * daysInMonth : 0, budget: this.store.data.settings.monthlyBudget },
      accounts: accounts.map((a) => ({ ...a, ...(byAccount[a.id] || { cost: 0, sessions: 0, tokens: 0 }) })),
      projects: [...projects.values()].map((p) => ({ ...p, fileCount: p.files.size, files: undefined, totalTokens: tokSum(p.tokens) })).sort((a, b) => b.cost - a.cost),
      sessions: sessionList.sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || '')),
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      models: [...models.values()].map((m) => ({ ...m, ids: [...m.ids] })).sort((a, b) => b.cost - a.cost),
      heat,
    };
  }

  detail(id) {
    const s = this.model?.sessions.find((x) => x.id === id);
    const d = this.details.get(id);
    if (!s || !d) return null;
    return { ...s, ...d };
  }

  /** Full replay timeline for a session (reads the transcript or its archived recording). */
  replay(id) {
    const s = this.model?.sessions.find((x) => x.id === id);
    if (!s) return null;
    let file = s.file;
    if (!fs.existsSync(file)) file = path.join(this.archiveDir, `${id}.jsonl`);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const { events } = parseTranscript(text, { events: true });
    return { session: s, events };
  }
}

module.exports = { Scanner };
