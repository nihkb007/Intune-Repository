// window.engram for the browser: the same interface the desktop app's screens use, backed by
// the Engine instead of Electron. Things a web page cannot do (open a terminal, touch
// folders it was not given) become "copy the command" or a clear message.
import { fuse, injectManagedBlock } from '../../engram/src/core/fusion.js';
import * as sync from '../../engram/src/core/sync.js';
import { resumeScript } from './setup-script.js';

const ok = (data) => ({ ok: true, data });
const fail = (err) => ({ ok: false, error: err?.message || String(err) });
const wrap = (fn) => async (...args) => { try { return ok(await fn(...args)); } catch (err) { return fail(err); } };
const notInBrowser = (what) => wrap(() => { throw new Error(`${what} is only available in the desktop app.`); });

function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

export function launchCommand({ projectPath, resumeId } = {}) {
  if (resumeId) return resumeScript({ id: resumeId, projectPath }); // works from any folder, on any laptop
  const parts = [];
  if (projectPath) parts.push(`Set-Location -LiteralPath ${psQuote(projectPath)}`);
  parts.push(`claude${resumeId ? ` --resume ${resumeId}` : ' --continue'}`);
  return parts.join('; ');
}

function download(name, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function createApi(engine, { onReconnect } = {}) {
  const listeners = new Set();
  const store = () => engine.store;
  const local = () => sync.localAccounts(engine.store);

  const snapshot = () => {
    const d = store().data;
    return {
      model: engine.model,
      accounts: local(),
      activeAccountId: d.activeAccountId,
      settings: d.settings,
      capsules: d.capsules,
      notesCount: d.notes.length,
      sync: null,
      drive: { available: false },
    };
  };

  // Browsers cannot watch folders: re-read changed files every 20 s while the tab is visible.
  const poll = async () => {
    if (document.hidden || engine.demo) return;
    try {
      if (await engine.refresh()) for (const fn of listeners) fn(snapshot());
    } catch { /* folder permission lost: next manual rescan will report it */ }
  };
  setInterval(poll, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  return {
    init: wrap(() => ({ ...snapshot(), demo: engine.demo, web: true, portable: false, platform: 'web', version: '1.0.0-web', dataDir: engine.demo ? 'demo data (in memory)' : `${engine.folderName}\\.engram` })),
    scan: wrap(async () => { await engine.load(); engine.scan(); return snapshot(); }),
    sessionDetail: wrap((id) => engine.scanner.detail(id)),
    sessionReplay: wrap((id) => engine.scanner.replay(id)),
    notes: {
      list: wrap((filter) => store().listNotes(filter || {})),
      upsert: wrap((n) => store().upsertNote(n)),
      remove: wrap((id) => store().deleteNote(id)),
    },
    fusion: {
      create: wrap(({ ids, title }) => {
        const details = ids.map((id) => engine.scanner.detail(id)).filter(Boolean);
        const projs = engine.model.projects.filter((p) => details.some((d) => d.projectKey === p.key));
        const keys = new Set(projs.flatMap((p) => [p.key, ...p.paths]));
        const notes = store().data.notes.filter((n) => n.scope === 'global' || keys.has(n.project));
        return store().addCapsule(fuse(details, { notes, accounts: engine.model.accounts, title }));
      }),
      // A web page may only write into folders you pick, so ask for the project folder.
      inject: wrap(async ({ id }) => {
        const cap = store().data.capsules.find((c) => c.id === id);
        if (!cap) throw new Error('Capsule not found');
        if (!window.showDirectoryPicker) throw new Error('Your browser cannot write to folders. Use Edge or Chrome, or export the capsule instead.');
        const dir = await window.showDirectoryPicker({ id: 'engram-project', mode: 'readwrite' });
        const fh = await dir.getFileHandle('CLAUDE.md', { create: true });
        const before = await (await fh.getFile()).text();
        const w = await fh.createWritable();
        await w.write(injectManagedBlock(before, cap.markdown));
        await w.close();
        return `${dir.name}\\CLAUDE.md`;
      }),
      remove: wrap((id) => store().deleteCapsule(id)),
      export: wrap((id) => {
        const cap = store().data.capsules.find((c) => c.id === id);
        if (!cap) throw new Error('Capsule not found');
        download('engram-capsule.md', cap.markdown);
        return 'engram-capsule.md (Downloads)';
      }),
    },
    accounts: {
      detect: wrap(() => []),
      upsert: wrap((a) => store().upsertAccount(a)),
      remove: notInBrowser('Unlinking accounts'),
      setActive: wrap((id) => store().setActiveAccount(id)),
    },
    bridge: { plan: wrap(() => []), sync: notInBrowser('Account bridging'), memory: notInBrowser('Memory sync') },
    launch: {
      command: wrap((o) => launchCommand(o)),
      terminal: wrap(async (o) => { const cmd = launchCommand(o); await navigator.clipboard.writeText(cmd); return cmd; }),
    },
    settings: { update: wrap((patch) => store().updateSettings(patch)) },
    sync: { status: wrap(() => null), update: notInBrowser('Laptop link'), now: wrap(() => snapshot()), bringHere: notInBrowser('Bring here') },
    drive: { status: wrap(() => ({ available: false })), share: notInBrowser('One-click sharing'), unshare: notInBrowser('Undo'), choose: wrap(() => snapshot()), dismiss: wrap(() => true), diskManagement: notInBrowser('Disk Management') },
    clipboard: wrap((text) => navigator.clipboard.writeText(String(text))),
    openPath: wrap(() => { throw new Error('A web page cannot open folders on your computer. Open it in File Explorer.'); }),
    pickFolder: wrap(() => null),
    reconnect: wrap(() => onReconnect && onReconnect()),
    win: { minimize: wrap(() => {}), maximize: wrap(() => document.documentElement.requestFullscreen?.()), close: wrap(() => {}) },
    onModel: (fn) => listeners.add(fn),
  };
}
