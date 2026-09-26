#!/usr/bin/env node
'use strict';
// End-to-end: launches the real Electron app on demo data, walks every view, asserts
// key content renders, and writes screenshots to docs/screenshots.
const path = require('path');
const assert = require('assert');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..', '..');
const OUT = process.env.ENGRAM_SHOTS || path.join(ROOT, 'docs', 'screenshots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ENGRAM_EXE=path/to/packaged/binary runs the same suite against an installed build.
  const packaged = process.env.ENGRAM_EXE;
  const app = await electron.launch({
    executablePath: packaged || require('electron'),
    args: [...(packaged ? [] : [ROOT]), '--demo', '--no-sandbox', '--disable-gpu-sandbox'],
    env: { ...process.env, ENGRAM_DEMO: '1', ...(packaged ? { ENGRAM_HOME: require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'engram-e2e-')) } : {}) },
  });
  const errors = [];
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.setViewportSize({ width: 1480, height: 920 });
  const shot = async (name) => { await win.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log('  ✓', name); };
  const nav = async (view) => { await win.click(`#rail a[data-view="${view}"]`); await wait(1500); };

  await wait(1150);
  await shot('00-boot');
  await win.waitForSelector('#boot.done', { state: 'attached', timeout: 15000 });
  await wait(1800);
  const kpi = await win.textContent('.kpi.hero .value');
  assert.match(kpi, /^\$[\d,]+\.\d\d$/, 'total spend renders as money');
  assert.ok(await win.$$eval('#nx-bars .bar-row', (n) => n.length) >= 3, 'project bars render');
  assert.ok(await win.$$eval('#nx-feed .insight', (n) => n.length) >= 2, 'insights render');
  await shot('01-nexus');

  await nav('projects');
  assert.ok(await win.$$eval('.pcard', (n) => n.length) === 5, 'five demo projects');
  await shot('02-projects');
  await win.click('.pcard');
  await wait(1800);
  await shot('03-project-dossier');

  await nav('recordings');
  const rows = await win.$$eval('#rc-table tbody tr', (n) => n.length);
  assert.ok(rows > 50, `recordings table lists sessions (${rows})`);
  for (const i of [1, 2, 3, 5]) await win.click(`#rc-table tbody tr:nth-child(${i}) .check input`);
  await wait(400);
  await shot('04-recordings');

  await win.click('#rc-table tbody tr:nth-child(2) td:nth-child(2)');
  await wait(4200);
  assert.ok(await win.$$eval('#rp-events .ev', (n) => n.length) > 3, 'replay streams events');
  await shot('05-replay');

  await nav('recordings');
  await win.click('#rc-table tbody tr:nth-child(1) .check input');
  await win.click('#rc-table tbody tr:nth-child(4) .check input');
  await win.click('#rc-fuse');
  await wait(1800);
  const md = await win.textContent('#fz-view .md');
  assert.ok(md.includes('What was asked'), 'capsule contains goals section');
  await shot('06-fusion');

  await nav('vault');
  await win.click('.note-item');
  await wait(600);
  await shot('07-vault');

  await nav('bridge');
  await wait(800);
  await shot('08-bridge');
  await win.click('#br-sync');
  await wait(2500);
  await shot('09-bridge-synced');

  await nav('settings');
  assert.equal(await win.getAttribute('.credit', 'href'), 'https://butchermedia.cc', 'rail credit links to butchermedia.cc');
  assert.ok(await win.$('.settings-grid a[href="https://butchermedia.cc"]'), 'About links to butchermedia.cc');
  await shot('10-system');

  await nav('nexus');
  await win.keyboard.press('Control+K');
  await win.keyboard.type('checkout');
  await wait(500);
  assert.ok(await win.$$eval('#palette-list li', (n) => n.length) > 1, 'palette finds sessions');
  await shot('11-command-palette');
  await win.keyboard.press('Escape');

  await app.close();
  const real = errors.filter((e) => !/Autofill|DevTools|GPU|gpu/.test(e));
  assert.deepStrictEqual(real, [], 'no renderer errors');
  console.log('e2e: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
