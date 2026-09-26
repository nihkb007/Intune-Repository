#!/usr/bin/env node
'use strict';
// Packs dist/win-unpacked into a portable zip:
//   ENGRAM/ENGRAM.exe + runtime
//   ENGRAM/ENGRAM-data/      <- its presence switches the app into portable mode
//   ENGRAM/START-HERE.txt
// Usage: electron-builder --win dir && node scripts/make-portable.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { path7za } = require('7zip-bin');

const ROOT = path.join(__dirname, '..');
const { version } = require(path.join(ROOT, 'package.json'));
const src = path.join(ROOT, 'dist', 'win-unpacked');
const stage = path.join(ROOT, 'dist', 'portable-stage');
const app = path.join(stage, 'ENGRAM');
const out = path.join(ROOT, 'dist', `ENGRAM-Portable-${version}-win-x64.zip`);

if (!fs.existsSync(path.join(src, 'ENGRAM.exe'))) {
  console.error('dist/win-unpacked/ENGRAM.exe not found. Run: npx electron-builder --win dir');
  process.exit(1);
}
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(out, { force: true });
fs.cpSync(src, app, { recursive: true });
fs.mkdirSync(path.join(app, 'ENGRAM-data'));
fs.writeFileSync(path.join(app, 'ENGRAM-data', 'README.txt'),
  'ENGRAM keeps its vault, archived recordings and settings in this folder while it exists.\r\n' +
  'Delete or rename this folder to make ENGRAM use %APPDATA%\\ENGRAM instead.\r\n');
// Pre-built connection: ENGRAM_LINK_FOLDER=\\NAS\engram bakes the shared folder in, so
// ENGRAM links itself on first launch. Without it, ship an example to copy.
const example = { linkFolder: '\\\\NAS\\engram', mode: 'full' };
fs.writeFileSync(path.join(app, 'engram.config.example.json'), JSON.stringify(example, null, 2) + '\n');
if (process.env.ENGRAM_LINK_FOLDER) {
  fs.writeFileSync(path.join(app, 'engram.config.json'), JSON.stringify({ linkFolder: process.env.ENGRAM_LINK_FOLDER, mode: 'full' }, null, 2) + '\n');
  console.log(`portable: pre-linked to ${process.env.ENGRAM_LINK_FOLDER}`);
}
fs.writeFileSync(path.join(app, 'START-HERE.txt'), [
  `ENGRAM ${version} - portable edition`,
  '',
  '1. Keep this whole ENGRAM folder together (e.g. C:\\Tools\\ENGRAM or a USB drive).',
  '2. Double-click ENGRAM.exe.',
  '3. If Windows shows "Windows protected your PC": click More info -> Run anyway.',
  '   (Or, before extracting, right-click the zip -> Properties -> tick Unblock -> OK.)',
  '4. ENGRAM finds this laptop\'s Claude accounts by itself on first run.',
  '',
  'THUMB DRIVE: put this whole ENGRAM folder on the drive and run ENGRAM.exe from there on',
  'each laptop. Each laptop adds its history to ENGRAM-data and sees the others\'.',
  'Close ENGRAM before unplugging. Claude Code itself still has to be installed on each laptop.',
  '',
  'NAS: rename engram.config.example.json to engram.config.json and put your NAS path in it',
  '(e.g. \\\\NAS\\engram). ENGRAM then syncs there automatically. Do this on each laptop.',
  '',
  'Everything ENGRAM stores lives in ENGRAM-data\\ next to the exe. Nothing is installed,',
  'nothing is written to the registry. To remove it, delete the folder.',
  '',
].join('\r\n'));
execFileSync(path7za, ['a', '-tzip', '-mx=7', out, 'ENGRAM'], { cwd: stage, stdio: 'ignore' });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`portable: ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
