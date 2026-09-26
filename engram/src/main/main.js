'use strict';
const { app, BrowserWindow, ipcMain, clipboard, shell, dialog, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('../core/store');
const { Scanner } = require('../core/scanner');
const { fuse } = require('../core/fusion');
const bridge = require('../core/bridge');
const sync = require('../core/sync');

const DEMO = process.argv.includes('--demo') || process.env.ENGRAM_DEMO === '1';
const APP_ROOT = path.join(__dirname, '..', '..');

// Portable mode: an "ENGRAM-data" folder next to ENGRAM.exe holds everything the app
// stores (vault, archived recordings, settings, browser cache), so nothing goes to %APPDATA%.
const portableDir = app.isPackaged ? path.join(path.dirname(process.execPath), 'ENGRAM-data') : null;
const PORTABLE = !!portableDir && fs.existsSync(portableDir);
if (process.env.ENGRAM_HOME) app.setPath('userData', process.env.ENGRAM_HOME);
else if (PORTABLE) app.setPath('userData', portableDir);
const demoRoot = app.isPackaged ? path.join(app.getPath('userData'), 'demo') : path.join(APP_ROOT, 'demo');
const dataDir = DEMO ? path.join(demoRoot, 'data') : path.join(app.getPath('userData'), 'vault');

let store;
let scanner;
let win;
let watchers = [];
let rescanTimer = null;
let syncTimer = null;
let syncInfo = { machines: [], error: null, merged: 0, pushed: null };

function boot() {
  if (DEMO && !fs.existsSync(path.join(dataDir, 'engram.json'))) require('../../scripts/make-demo-data').main(demoRoot);
  store = new Store(dataDir);
  scanner = new Scanner({ store, dataDir });
  // Register this laptop; on its first run, link the Claude accounts found on it.
  sync.adoptThisMachine(store, DEMO ? [] : bridge.detectAccounts());
  applyConfigFile();
}

/**
 * Optional engram.config.json, next to ENGRAM.exe or in the app data folder, lets a build
 * come pre-connected:  { "linkFolder": "\\\\NAS\\engram", "machineName": "WORK-LAPTOP" }
 * It only fills settings the user has not set, so changes made in the app always win.
 */
function applyConfigFile() {
  const candidates = [app.isPackaged && path.join(path.dirname(process.execPath), 'engram.config.json'), path.join(app.getPath('userData'), 'engram.config.json')].filter(Boolean);
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { syncInfo.error = `engram.config.json is not valid JSON: ${err.message}`; return; }
  const s = store.data.settings.sync;
  if (cfg.linkFolder && !s.folder && !s.folderClearedByUser) s.folder = String(cfg.linkFolder);
  if (cfg.mode === 'memory' || cfg.mode === 'full') s.mode = s.mode || cfg.mode;
  const me = sync.identity(store);
  // On a shared drive the config file is shared too, so a fixed name would label every
  // laptop the same; there each laptop keeps its own computer name.
  if (cfg.machineName && !PORTABLE && !store.data.machines[me.id]?.renamed) store.data.machines[me.id].name = String(cfg.machineName).slice(0, 40);
  store.save(true);
}

const localAccounts = () => sync.localAccounts(store);

// ---- shared-folder lock (portable copy on a drive or NAS share) ---------------------------
// One vault file must not be written by two laptops at once. While ENGRAM runs from a
// portable folder it keeps a heartbeat lock there; another laptop opening the same folder
// is warned first.
const LOCK_STALE_MS = 3 * 60000;
let lockTimer = null;
const lockFile = () => path.join(app.getPath('userData'), 'in-use.lock');

function otherLaptopHoldingLock() {
  try {
    const l = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    const me = sync.identity(store).id;
    if (l.machineId !== me && Date.now() - Date.parse(l.at) < LOCK_STALE_MS) return l;
  } catch { /* no lock */ }
  return null;
}

function holdLock() {
  const write = () => {
    try { fs.writeFileSync(lockFile(), JSON.stringify({ machineId: sync.identity(store).id, name: sync.identity(store).name, at: new Date().toISOString() })); } catch { /* drive unplugged */ }
  };
  write();
  lockTimer = setInterval(write, 60000);
}

function releaseLock() {
  clearInterval(lockTimer);
  try {
    const l = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    if (l.machineId === sync.identity(store).id) fs.unlinkSync(lockFile());
  } catch { /* nothing to release */ }
}

/** Scan, and when a shared folder is linked: pull other laptops first, push this one after. */
function cycle() {
  const folder = store.data.settings.sync?.folder;
  if (!folder) {
    scanner.extraSources = [];
    return scanner.scan();
  }
  syncInfo.error = null;
  try {
    if (!fs.existsSync(folder)) throw new Error(`Shared folder not reachable: ${folder}`);
    const imp = sync.importMachines(store, folder);
    scanner.extraSources = imp.sources;
    syncInfo.machines = imp.machines;
    syncInfo.merged = imp.merged;
  } catch (err) {
    syncInfo.error = err.message;
  }
  const model = scanner.scan();
  if (!syncInfo.error) {
    try { syncInfo.pushed = sync.exportMachine(store, model, folder); } catch (err) { syncInfo.error = err.message; }
  }
  return model;
}

function pushModel() {
  if (win && !win.isDestroyed()) win.webContents.send('model:update', snapshot(cycle()));
}

function scheduleSync() {
  clearInterval(syncTimer);
  if (store.data.settings.sync?.folder) syncTimer = setInterval(pushModel, 3 * 60000);
}

function syncStatus() {
  const me = sync.identity(store);
  const cfg = store.data.settings.sync;
  const others = Object.entries(store.data.machines || {}).filter(([id]) => id !== me.id).map(([id, m]) => ({ id, ...m }));
  return { ...syncInfo, portable: PORTABLE, driveLaptops: others, machine: me, folder: cfg.folder || null, mode: cfg.mode || 'full', projects: Array.isArray(cfg.projects) ? cfg.projects : null, lastPush: cfg.lastPush || null, lastPull: cfg.lastPull || null };
}

function snapshot(model) {
  const d = store.data;
  return { model, accounts: localAccounts(), activeAccountId: d.activeAccountId, settings: d.settings, capsules: d.capsules, notesCount: d.notes.length, sync: syncStatus() };
}

function watchAccounts() {
  for (const w of watchers) try { w.close(); } catch {}
  watchers = [];
  for (const a of localAccounts()) {
    const dir = path.join(a.configDir, 'projects');
    if (!fs.existsSync(dir)) continue;
    try {
      watchers.push(fs.watch(dir, { recursive: true }, (_ev, file) => {
        if (file && !String(file).endsWith('.jsonl')) return;
        clearTimeout(rescanTimer);
        rescanTimer = setTimeout(pushModel, 1500);
      }));
    } catch { /* recursive watch unsupported: manual rescan still works */ }
  }
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: '#05060b',
    show: false,
    title: 'ENGRAM',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

function accountById(id) {
  const a = localAccounts().find((x) => x.id === (id || store.data.activeAccountId));
  if (!a) throw new Error('No account selected. Add one in BRIDGE.');
  return a;
}

function globalDirectivesMarkdown() {
  const notes = store.data.notes.filter((n) => n.scope === 'global' && (n.pinned || n.kind === 'directive'));
  const lines = ['# ENGRAM global memory', '', '_Synced to every linked Claude account by ENGRAM._', ''];
  for (const n of notes) lines.push(`## ${n.title}`, '', n.body.trim(), '');
  return lines.join('\n');
}

function registerIpc() {
  handle('app:init', () => ({ ...snapshot(scanner.model || cycle()), demo: DEMO, portable: PORTABLE, platform: process.platform, version: app.getVersion(), dataDir }));
  handle('scan:run', () => snapshot(cycle()));
  handle('session:detail', (id) => scanner.detail(id));
  handle('session:replay', (id) => scanner.replay(id));

  handle('notes:list', (filter) => store.listNotes(filter || {}));
  handle('notes:upsert', (n) => store.upsertNote(n));
  handle('notes:delete', (id) => store.deleteNote(id));

  handle('fusion:create', ({ ids, title }) => {
    const details = ids.map((id) => scanner.detail(id)).filter(Boolean);
    const projs = scanner.model.projects.filter((p) => details.some((d) => d.projectKey === p.key));
    const keys = new Set(projs.flatMap((p) => [p.key, ...p.paths]));
    const notes = store.data.notes.filter((n) => n.scope === 'global' || keys.has(n.project));
    const cap = fuse(details, { notes, accounts: scanner.model.accounts, title });
    // Inject targets must be folders on this laptop.
    cap.projects = [...new Set(cap.projects.map((root) => projs.find((p) => p.paths.includes(root))?.localPath || root))];
    return store.addCapsule(cap);
  });
  handle('fusion:inject', ({ id, projectPath }) => {
    const cap = store.data.capsules.find((c) => c.id === id);
    if (!cap) throw new Error('Capsule not found');
    const target = projectPath || cap.projects[0];
    return bridge.injectProject(target, cap.markdown);
  });
  handle('fusion:delete', (id) => store.deleteCapsule(id));
  handle('fusion:export', async (id) => {
    const cap = store.data.capsules.find((c) => c.id === id);
    if (!cap) throw new Error('Capsule not found');
    const res = await dialog.showSaveDialog(win, { defaultPath: 'engram-capsule.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, cap.markdown);
    return res.filePath;
  });

  handle('accounts:detect', () => bridge.detectAccounts());
  handle('accounts:upsert', (a) => {
    const r = store.upsertAccount(a);
    r.machineId = r.machineId || sync.identity(store).id;
    store.save(true);
    watchAccounts();
    return r;
  });
  handle('accounts:remove', (id) => { store.removeAccount(id); watchAccounts(); return true; });
  handle('accounts:setActive', (id) => store.setActiveAccount(id));

  handle('bridge:plan', () => bridge.syncSessions(localAccounts(), store.data.bridgeLedger, { dryRun: true }).plan);
  handle('bridge:sync', () => {
    const r = bridge.syncSessions(localAccounts(), store.data.bridgeLedger);
    store.data.bridgeLedger = r.ledger;
    store.save(true);
    return { copied: r.copied, plan: r.plan };
  });
  handle('bridge:memory', () => bridge.syncMemory(localAccounts(), globalDirectivesMarkdown()));

  handle('launch:command', ({ accountId, projectPath, resumeId }) => bridge.launchCommand(accountById(accountId), { projectPath, resumeId }));
  handle('launch:terminal', ({ accountId, projectPath, resumeId }) => {
    const acct = accountById(accountId);
    if (resumeId) {
      // Make sure the session exists on this account before resuming it there.
      const r = bridge.syncSessions(localAccounts(), store.data.bridgeLedger, { only: [resumeId] });
      store.data.bridgeLedger = r.ledger;
      store.save(true);
    }
    return bridge.launchTerminal(acct, { projectPath: projectPath && fs.existsSync(projectPath) ? projectPath : undefined, resumeId });
  });

  handle('settings:update', (patch) => store.updateSettings(patch));

  handle('sync:status', () => syncStatus());
  handle('sync:update', (patch) => {
    const cfg = store.data.settings.sync;
    if ('folder' in patch) { cfg.folder = patch.folder || null; cfg.folderClearedByUser = !patch.folder; }
    if (patch.mode === 'full' || patch.mode === 'memory') cfg.mode = patch.mode;
    if ('projects' in patch) cfg.projects = Array.isArray(patch.projects) ? patch.projects : null;
    if (typeof patch.machineName === 'string' && patch.machineName.trim()) {
      const me = sync.identity(store);
      store.data.machines[me.id] = { ...store.data.machines[me.id], name: patch.machineName.trim().slice(0, 40), renamed: true };
    }
    store.save(true);
    scheduleSync();
    return snapshot(cycle());
  });
  handle('sync:now', () => snapshot(cycle()));
  handle('sync:bringHere', ({ sessionId, accountId, localPath }) => {
    const s = scanner.model.sessions.find((x) => x.id === sessionId);
    if (!s || !s.remote) throw new Error('That session is already on this laptop.');
    const proj = scanner.model.projects.find((p) => p.key === s.projectKey);
    const target = localPath || proj?.localPath;
    if (!target) return { needFolder: true, project: s.projectName };
    const acct = accountById(accountId);
    const src = scanner.extraSources.find((x) => x.files.some((f) => f.file === s.file));
    sync.bringHere(store, { file: s.file, sessionId, remotePath: s.projectPath, localPath: target, account: acct, machineId: src?.account.machineId, sourceAccountId: s.accountId });
    if (localPath && proj?.remote) {
      // Remember the folder for next time.
      store.data.settings.sync.codeRoots = [...new Set([...(store.data.settings.sync.codeRoots || []), path.dirname(localPath)])];
      scanner.checkouts = null;
    }
    setTimeout(pushModel, 500);
    try {
      return { cmd: bridge.launchTerminal(acct, { projectPath: target, resumeId: sessionId }), path: target };
    } catch (err) {
      // The session is here either way; hand over the command if no terminal could open.
      const cmd = bridge.launchCommand(acct, { projectPath: target, resumeId: sessionId });
      clipboard.writeText(cmd);
      return { cmd, path: target, launchError: err.message };
    }
  });
  handle('clipboard:write', (text) => { clipboard.writeText(String(text)); return true; });
  handle('shell:openPath', (p) => shell.openPath(p));
  handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'showHiddenFiles'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('win:minimize', () => win.minimize());
  handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  handle('win:close', () => win.close());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    boot();
    if (PORTABLE) {
      const other = otherLaptopHoldingLock();
      if (other) {
        const choice = dialog.showMessageBoxSync({
          type: 'warning',
          title: 'ENGRAM is open on another laptop',
          message: `ENGRAM is already open on ${other.name}.`,
          detail: 'Both laptops are using the same ENGRAM-data folder. Using it on both at once can overwrite changes. Close ENGRAM on the other laptop first (or wait a few minutes if it was closed without shutting down properly).',
          buttons: ['Quit', 'Open anyway'],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice === 0) { app.quit(); return; }
      }
      holdLock();
    }
    registerIpc();
    createWindow();
    watchAccounts();
    scheduleSync();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // Runs for every way of quitting (window closed, app.quit, Alt+F4, shutdown).
  app.on('will-quit', () => {
    if (store) store.save(true);
    if (PORTABLE && store) releaseLock();
  });
}
