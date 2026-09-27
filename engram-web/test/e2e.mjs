// End-to-end in real Chromium, against the local server that serves api/ like Vercel:
//  A) portal with login: create the account on the first-run page, create presets, start one (folder = Chromium's private
//     file system; same browser API as a real drive), resume the latest session, a second
//     laptop on the same folder, switch preset, sign out, sign in again
//  B) no account (no storage, or static hosting): open the drive, presets saved on it, a
//     second laptop sees them; the demo
// Writes screenshots to docs/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { serve } from '../serve.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const shots = path.join(here, '..', 'docs');
const exe = process.env.CHROMIUM_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A fresh deployment: storage connected, setup code set, no account yet.
Object.assign(process.env, { ENGRAM_ACCOUNT: 'on', ENGRAM_STORE: 'memory', ENGRAM_SETUP_CODE: 'E2E1-SETU-PCOD-E234' });
const server = await serve(0);
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'], headless: process.env.E2E_HEADFUL !== '1' });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1480, height: 920 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
const watch = (p) => {
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  p.on('dialog', (d) => d.accept());
  p.on('crash', () => errors.push('page crashed'));
  return p;
};
let page = watch(await context.newPage());
// On failure, show what the page had on screen (CI has no screenshots to look at).
process.on('uncaughtException', async (err) => {
  console.error(err);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 600)).catch((e) => `(page unavailable: ${e.message})`);
  console.error('--- page text ---\n' + text + '\n--- page errors ---\n' + JSON.stringify(errors));
  process.exit(1);
});
const shot = async (n) => { await page.screenshot({ path: path.join(shots, `${n}.png`) }); console.log('  ✓', n); };
const nav = async (v) => { await page.click(`#rail a[data-view="${v}"]`); await wait(1200); };

// Test sessions folder in Chromium's private file system, used instead of the folder picker.
const session = (id, prompt, input, key) => [
  { type: 'user', sessionId: id, cwd: 'E:\\code\\app', timestamp: '2026-09-20T10:00:00Z', message: { role: 'user', content: prompt } },
  { type: 'assistant', sessionId: id, cwd: 'E:\\code\\app', timestamp: '2026-09-20T10:01:00Z', requestId: `req_${key}`, message: { id: `msg_${key}`, role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: `done: ${prompt}` }], usage: { input_tokens: input, output_tokens: 0 } } },
].map((x) => JSON.stringify(x)).join('\n') + '\n';
const writeFile = (rel, text, append = false) => page.evaluate(async ({ rel, text, append }) => {
  const root = await navigator.storage.getDirectory();
  let dir = await root.getDirectoryHandle('claude-sessions', { create: true });
  const parts = rel.split('/').filter(Boolean);
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const fh = await dir.getFileHandle(parts.at(-1), { create: true });
  const before = append ? await (await fh.getFile()).text() : '';
  const w = await fh.createWritable();
  await w.write(before + text);
  await w.close();
}, { rel, text, append });
const usePrivateFolder = () => page.addInitScript(() => {
  window.__engramPickFolder = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('claude-sessions', { create: true });
});

// ---------------- A) portal with login ----------------
await usePrivateFolder();
await page.goto(url);
await page.evaluate(async () => { const r = await navigator.storage.getDirectory(); for await (const [n] of r.entries()) await r.removeEntry(n, { recursive: true }); localStorage.clear(); });
await writeFile('/E--code-app/s1.jsonl', session('s1', 'first task on the work laptop', 1_000_000, 'w1'));
await page.reload();
await page.waitForSelector('#su-form');
assert.equal(await page.locator('.cx-state.ok').count(), 2, 'storage and setup code both detected');
await page.fill('#su-user', 'nihko');
await page.fill('#su-pass', 'correct horse battery');
await page.fill('#su-pass2', 'correct horse battery');
await page.fill('#su-code', 'wrong-code');
await shot('web-00-first-run');
await page.click('#su-go');
await page.waitForFunction(() => document.querySelector('#su-err').textContent.includes('doesn’t match'));
await page.fill('#su-code', 'e2e1 setu pcod e234');
await page.click('#su-go');
await page.waitForSelector('#pr-list');
assert.ok(!(await page.evaluate(() => document.cookie)).includes('engram_session'), 'session cookie is HttpOnly');
assert.match(await page.textContent('#portal'), /Saved to your account/);

// Create presets
await page.click('#pr-new');
await page.fill('#pe-name', 'WORK LAPTOP');
await page.fill('#pe-laptop', 'WORK');
await shot('web-02-preset-editor');
await page.click('#pe-form button[type=submit]');
await page.waitForSelector('.cx-preset[data-id]');
await page.click('#pr-new');
await page.fill('#pe-name', 'PERSONAL LAPTOP');
await page.fill('#pe-laptop', 'PERSONAL');
await page.fill('#pe-drive', 'F');
assert.equal(await page.inputValue('#pe-folder'), 'F:\\claude-sessions', 'folder follows the drive letter');
await page.fill('#pe-drive', 'E');
await page.selectOption('#pe-view', 'recordings');
await page.click('#pe-form button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('.cx-preset[data-id]').length === 2);
await shot('web-03-presets');

// Start WORK (opens the latest session, ready to resume)
await page.click('.cx-preset[data-id]:nth-child(1) [data-act="start"]');
await page.waitForSelector('#boot.done', { state: 'attached', timeout: 20000 });
await page.waitForSelector('#rp-resume', { timeout: 10000 });
await wait(800);
assert.match(await page.textContent('#rp-resume'), /COPY RESUME COMMAND/);
assert.ok((await page.textContent('#rp-events')).includes('first task on the work laptop'), 'whole conversation shown');
await page.click('#rp-resume');
await wait(300);
assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Set-Location -LiteralPath 'E:\\code\\app'; claude --resume s1$/);
await shot('web-04-resume');

// Presets live on the server: a "second laptop" (fresh browser identity) sees them after sign-in.
await writeFile('/E--code-app/s1.jsonl', session('s1', 'continued on the personal laptop', 2_000_000, 'p1'), true);
await page.evaluate(() => { localStorage.clear(); return new Promise((r) => { const d = indexedDB.deleteDatabase('engram-web'); d.onsuccess = d.onerror = d.onblocked = r; }); });
await page.goto(url);
await page.waitForSelector('#pr-list');
assert.equal((await page.$$('.cx-preset[data-id]')).length, 2, 'presets come from the account');
await page.click('.cx-preset[data-id]:nth-child(2) [data-act="start"]');
await page.waitForSelector('#rc-table', { timeout: 20000 });
await nav('setup');
const setupText = await page.textContent('#view');
assert.match(setupText, /PERSONAL LAPTOP/);
assert.match(setupText, /PERSONAL[\s\S]*\$4\.00/, 'personal laptop credited for its turn');
assert.match(setupText, /WORK[\s\S]*other laptop[\s\S]*\$2\.00/, 'work laptop keeps its turn');
await shot('web-05-setup');

await page.click('#su-signout');
await page.waitForSelector('#lg-form');
await page.fill('#lg-user', 'nihko');
await page.fill('#lg-pass', 'wrong password');
await page.click('#lg-go');
await page.waitForFunction(() => document.querySelector('#lg-err').textContent.includes('Wrong'));
await shot('web-01-login');
await page.fill('#lg-pass', 'correct horse battery');
await page.click('#lg-go');
await page.waitForSelector('#pr-list');
assert.equal((await page.$$('.cx-preset[data-id]')).length, 2, 'signed back in to the same presets');

// ---------------- B) no account: presets on the drive ----------------
server.close();
const staticServer = await serve(0, { api: false });
const surl = `http://localhost:${staticServer.address().port}/`;
await page.goto(surl);
// (a new address has its own private file system: put a session on this "drive" too)
await writeFile('/E--code-app/s1.jsonl', session('s1', 'continued on the personal laptop', 2_000_000, 'p1'));
await page.reload();
await page.waitForSelector('#dr-open');
await shot('web-00-open-drive');
await page.click('#dr-open');
await page.waitForSelector('#pr-list');
assert.match(await page.textContent('#portal'), /Saved on your drive \(claude-sessions\)/);
await page.click('#pr-new');
await page.fill('#pe-name', 'WORK LAPTOP');
await page.fill('#pe-laptop', 'WORK');
await page.click('#pe-form button[type=submit]');
await page.waitForSelector('.cx-preset[data-id]');
const onDrive = await page.evaluate(async () => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('claude-sessions');
  return (await (await (await d.getDirectoryHandle('.engram')).getFileHandle('presets.json')).getFile()).text();
});
assert.match(onDrive, /WORK LAPTOP/, 'preset written to <drive>/claude-sessions/.engram/presets.json');
// The other laptop: nothing in its browser, same drive.
await page.evaluate(() => { localStorage.clear(); return new Promise((r) => { const d = indexedDB.deleteDatabase('engram-web'); d.onsuccess = d.onerror = d.onblocked = r; }); });
await page.reload();
await page.click('#dr-open');
await page.waitForSelector('.cx-preset[data-id]');
assert.equal((await page.$$('.cx-preset[data-id]')).length, 1, 'presets come from the drive');
await page.click('.cx-preset[data-id] [data-act="start"]');
await page.waitForSelector('#rp-resume', { timeout: 20000 });
assert.match(await page.textContent('#rp-events'), /continued on the personal laptop/);

// Demo in a fresh tab, after ENGRAM's delayed save to the folder has finished.
await wait(1500);
await page.close();
page = watch(await context.newPage());
await page.goto(surl);
await page.waitForSelector('#dr-open');
await page.click('#pr-demo');
await page.waitForSelector('#boot.done', { state: 'attached', timeout: 20000 });
await wait(1500);
assert.match(await page.textContent('.kpi.hero .value'), /^\$[\d,]+\.\d\d$/);
await shot('web-06-demo');

await browser.close();
staticServer.close();
assert.deepEqual(errors, [], 'no page errors');
console.log('web e2e: all assertions passed');
