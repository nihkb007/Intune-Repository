'use strict';
const { app, BrowserWindow, ipcMain, clipboard, shell, dialog, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('../core/store');
const { Scanner } = require('../core/scanner');
const { fuse } = require('../core/fusion');
const bridge = require('../core/bridge');

const DEMO = process.argv.includes('--demo') || process.env.ENGRAM_DEMO === '1';
const APP_ROOT = path.join(__dirname, '..', '..');

if (process.env.ENGRAM_HOME) app.setPath('userData', process.env.ENGRAM_HOME);
const demoRoot = app.isPackaged ? path.join(app.getPath('userData'), 'demo') : path.join(APP_ROOT, 'demo');
const dataDir = DEMO ? path.join(demoRoot, 'data') : path.join(app.getPath('userData'), 'vault');

let store;
let scanner;
let win;
let watchers = [];
let rescanTimer = null;

function boot() {
  if (DEMO && !fs.existsSync(path.join(dataDir, 'engram.json'))) require('../../scripts/make-demo-data').main(demoRoot);
  store = new Store(dataDir);
  scanner = new Scanner({ store, dataDir });
  if (!store.data.accounts.length && !DEMO) {
    for (const a of bridge.detectAccounts()) store.upsertAccount(a);
    store.save(true);
  }
}

function pushModel() {
  if (win && !win.isDestroyed()) win.webContents.send('model:update', snapshot(scanner.scan()));
}

function snapshot(model) {
  const d = store.data;
  return { model, accounts: d.accounts, activeAccountId: d.activeAccountId, settings: d.settings, capsules: d.capsules, notesCount: d.notes.length };
}

function watchAccounts() {
  for (const w of watchers) try { w.close(); } catch {}
  watchers = [];
  for (const a of store.data.accounts) {
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
  const a = store.data.accounts.find((x) => x.id === (id || store.data.activeAccountId));
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
  handle('app:init', () => ({ ...snapshot(scanner.model || scanner.scan()), demo: DEMO, platform: process.platform, version: app.getVersion(), dataDir }));
  handle('scan:run', () => snapshot(scanner.scan()));
  handle('session:detail', (id) => scanner.detail(id));
  handle('session:replay', (id) => scanner.replay(id));

  handle('notes:list', (filter) => store.listNotes(filter || {}));
  handle('notes:upsert', (n) => store.upsertNote(n));
  handle('notes:delete', (id) => store.deleteNote(id));

  handle('fusion:create', ({ ids, title }) => {
    const details = ids.map((id) => scanner.detail(id)).filter(Boolean);
    const projects = new Set(details.map((d) => d.projectPath));
    const notes = store.data.notes.filter((n) => n.scope === 'global' || projects.has(n.project));
    const cap = fuse(details, { notes, accounts: store.data.accounts, title });
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
  handle('accounts:upsert', (a) => { const r = store.upsertAccount(a); store.save(true); watchAccounts(); return r; });
  handle('accounts:remove', (id) => { store.removeAccount(id); watchAccounts(); return true; });
  handle('accounts:setActive', (id) => store.setActiveAccount(id));

  handle('bridge:plan', () => bridge.syncSessions(store.data.accounts, store.data.bridgeLedger, { dryRun: true }).plan);
  handle('bridge:sync', () => {
    const r = bridge.syncSessions(store.data.accounts, store.data.bridgeLedger);
    store.data.bridgeLedger = r.ledger;
    store.save(true);
    return { copied: r.copied, plan: r.plan };
  });
  handle('bridge:memory', () => bridge.syncMemory(store.data.accounts, globalDirectivesMarkdown()));

  handle('launch:command', ({ accountId, projectPath, resumeId }) => bridge.launchCommand(accountById(accountId), { projectPath, resumeId }));
  handle('launch:terminal', ({ accountId, projectPath, resumeId }) => {
    const acct = accountById(accountId);
    if (resumeId) {
      // Make sure the session exists on this account before resuming it there.
      const r = bridge.syncSessions(store.data.accounts, store.data.bridgeLedger, { only: [resumeId] });
      store.data.bridgeLedger = r.ledger;
      store.save(true);
    }
    return bridge.launchTerminal(acct, { projectPath: projectPath && fs.existsSync(projectPath) ? projectPath : undefined, resumeId });
  });

  handle('settings:update', (patch) => store.updateSettings(patch));
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
    registerIpc();
    createWindow();
    watchAccounts();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => {
    if (store) store.save(true);
    if (process.platform !== 'darwin') app.quit();
  });
}
