// End-to-end: serves dist/, drives real Chromium through the demo and through a real
// folder (Chromium's private file system stands in for the drive; same browser API),
// including a second "laptop" on the same folder. Writes screenshots to docs/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { serve } from '../serve.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const shots = path.join(here, '..', 'docs');
const exe = process.env.CHROMIUM_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serve(0);
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 1480, height: 920 } })).newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = async (n) => { await page.screenshot({ path: path.join(shots, `${n}.png`) }); console.log('  ✓', n); };
const nav = async (v) => { await page.click(`#rail a[data-view="${v}"]`); await wait(1200); };

// 1) Connect screen
await page.goto(url);
await page.waitForSelector('#connect');
assert.match(await page.textContent('#cx-script'), /New-Item -ItemType Junction/);
await page.fill('#cx-letter', 'F');
assert.match(await page.textContent('#cx-script'), /'F:\\claude-sessions'/, 'script follows the drive letter');
await page.fill('#cx-letter', 'E');
await shot('web-01-connect');

// 2) Demo
await page.click('#cx-demo');
await page.waitForSelector('#boot.done', { state: 'attached', timeout: 20000 });
await wait(1500);
assert.match(await page.textContent('.kpi.hero .value'), /^\$[\d,]+\.\d\d$/);
await shot('web-02-nexus');
await nav('recordings');
assert.ok((await page.$$('#rc-table tbody tr')).length > 50);
await page.click('#rc-table tbody tr:nth-child(2) td:nth-child(2)');
await wait(3500);
assert.match(await page.textContent('#rp-resume'), /COPY RESUME COMMAND/);
await shot('web-03-replay');
await nav('setup');
assert.match(await page.textContent('#su-script'), /Junction/);
await shot('web-04-setup');

// 3) Real folder: two laptops, one folder
const session = (id, prompt, input, key) => [
  { type: 'user', sessionId: id, cwd: 'E:\\code\\app', timestamp: '2026-09-20T10:00:00Z', message: { role: 'user', content: prompt } },
  { type: 'assistant', sessionId: id, cwd: 'E:\\code\\app', timestamp: '2026-09-20T10:01:00Z', requestId: `req_${key}`, message: { id: `msg_${key}`, role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: input, output_tokens: 0 } } },
].map((x) => JSON.stringify(x)).join('\n') + '\n';

const openFolder = async (laptop, freshLaptop) => {
  await page.goto(url);
  await page.evaluate(async ({ laptop, freshLaptop }) => {
    if (freshLaptop) localStorage.removeItem('engram.host'); // a different computer
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('claude-sessions', { create: true });
    await window.__engramConnect(dir, laptop);
  }, { laptop, freshLaptop });
  await page.waitForSelector('#boot.done', { state: 'attached', timeout: 20000 });
  await wait(800);
};
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

await page.goto(url);
await page.evaluate(async () => { const r = await navigator.storage.getDirectory(); for await (const [n] of r.entries()) await r.removeEntry(n, { recursive: true }); });
await writeFile('/E--code-app/s1.jsonl', session('s1', 'work laptop task', 1_000_000, 'w1'));
await openFolder('WORK', true);
assert.equal((await page.$$('#nx-recent .recent-row')).length, 1);

// ENGRAM saves its own data into <folder>/.engram/engram.json
await nav('vault');
await page.click('#vt-new');
await page.fill('#ed-title', 'Shared rule from the work laptop');
await page.fill('#ed-body', 'Always run tests first.');
await page.click('#ed-save');
await wait(1200);
const vaultText = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const d = await (await root.getDirectoryHandle('claude-sessions')).getDirectoryHandle('.engram');
  return (await (await d.getFileHandle('engram.json')).getFile()).text();
});
assert.ok(vaultText.includes('Shared rule from the work laptop'), 'vault saved on the drive');

// Second laptop continues the same session (Claude appends to the same file on the drive).
await writeFile('/E--code-app/s1.jsonl', session('s1', 'continued on personal laptop', 2_000_000, 'p1'), true);
await openFolder('PERSONAL', true);
await nav('vault');
assert.ok((await page.textContent('#vt-items')).includes('Shared rule from the work laptop'), 'notes follow the drive');
await nav('setup');
const setup = await page.textContent('#view');
assert.match(setup, /PERSONAL[\s\S]*\$4\.00/, 'personal laptop credited for its turn');
assert.match(setup, /WORK[\s\S]*other laptop[\s\S]*\$2\.00/, 'work laptop keeps its turn');
await shot('web-05-two-laptops');

await browser.close();
server.close();
const real = errors.filter((e) => !/favicon|DevTools/.test(e));
assert.deepEqual(real, [], 'no page errors');
console.log('web e2e: all assertions passed');
