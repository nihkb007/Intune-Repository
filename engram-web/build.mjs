// Builds ENGRAM Web into dist/: one static folder for GitHub Pages, Vercel, or a drive.
// Reuses the desktop app's HTML, styles, renderer and engine; swaps Electron for the browser.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const app = path.join(here, '..', 'engram');
const out = path.join(here, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });

const shim = (n) => path.join(here, 'src', 'shims', n);

await build({
  entryPoints: [path.join(here, 'src', 'boot.js')],
  bundle: true,
  format: 'iife', // one classic script: also works when opened straight from a drive (file://)
  platform: 'browser',
  target: ['chrome110', 'edge110'],
  minify: true,
  sourcemap: false,
  outfile: path.join(out, 'engram-web.js'),
  alias: { fs: shim('fs.js'), path: shim('path.js'), os: shim('os.js'), crypto: shim('crypto.js'), child_process: shim('empty.js') },
  inject: [shim('process.js')],
  nodePaths: [path.join(here, 'node_modules')],
  logLevel: 'warning',
});

// Styles: fonts + the app's stylesheet + web additions.
const cssEntry = path.join(os.tmpdir(), 'engram-web-entry.css');
const font = (pkg, f) => path.join(here, 'node_modules', '@fontsource', pkg, f);
fs.writeFileSync(cssEntry, [
  font('orbitron', 'latin-500.css'), font('orbitron', 'latin-700.css'), font('orbitron', 'latin-900.css'),
  font('rajdhani', 'latin-400.css'), font('rajdhani', 'latin-500.css'), font('rajdhani', 'latin-600.css'), font('rajdhani', 'latin-700.css'),
  font('jetbrains-mono', 'latin-400.css'), font('jetbrains-mono', 'latin-600.css'),
  path.join(app, 'src', 'renderer', 'styles.css'), path.join(here, 'src', 'web.css'),
].map((f) => `@import ${JSON.stringify(f)};`).join('\n'));
await build({ entryPoints: [cssEntry], bundle: true, minify: true, outfile: path.join(out, 'engram-web.css'), loader: { '.woff2': 'file', '.woff': 'file' }, assetNames: 'fonts/[name]-[hash]', logLevel: 'warning' });

// Markdown renderer + sanitizer, loaded as globals exactly like in the desktop app.
const mod = (p) => path.join(here, 'node_modules', p);
fs.copyFileSync(mod('marked/lib/marked.umd.js'), path.join(out, 'vendor', 'marked.umd.js'));
fs.copyFileSync(mod('dompurify/dist/purify.js'), path.join(out, 'vendor', 'purify.js'));

// Page: the desktop app's index.html with web asset paths.
let html = fs.readFileSync(path.join(app, 'src', 'renderer', 'index.html'), 'utf8');
html = html
  .replace(/\s*<link rel="stylesheet" href="\.\.\/\.\.\/node_modules\/@fontsource[^>]*>/g, '')
  .replace('<link rel="stylesheet" href="styles.css" />', '<link rel="stylesheet" href="engram-web.css" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <meta name="description" content="ENGRAM Web: Claude Code costs, session replays and memory for sessions on your drive. Runs in your browser; nothing is uploaded." />\n  <link rel="icon" href="icon.png" />')
  .replace('../../node_modules/marked/lib/marked.umd.js', 'vendor/marked.umd.js')
  .replace('../../node_modules/dompurify/dist/purify.js', 'vendor/purify.js')
  .replace('<script type="module" src="app.js"></script>', '<script src="engram-web.js" defer></script>')
  .replace('<title>ENGRAM</title>', '<title>ENGRAM Web</title>');
if (html.includes('node_modules') || !html.includes('engram-web.js')) throw new Error('index.html transform failed');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.copyFileSync(path.join(app, 'build', 'icon.png'), path.join(out, 'icon.png'));

// Demo data: the desktop app's generator, packed into one JSON file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-web-demo-'));
require(path.join(app, 'scripts', 'make-demo-data.js')).main(tmp);
const files = {};
for (const acct of ['.claude', '.claude-personal']) {
  const root = path.join(tmp, 'home', acct, 'projects');
  for (const slug of fs.readdirSync(root)) {
    for (const f of fs.readdirSync(path.join(root, slug))) {
      if (f.endsWith('.jsonl')) files[`/${slug}/${f}`] = fs.readFileSync(path.join(root, slug, f), 'utf8');
    }
  }
}
const demoVault = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'engram.json'), 'utf8'));
const vault = { notes: demoVault.notes, capsules: [], settings: { monthlyBudget: demoVault.settings.monthlyBudget } };
fs.writeFileSync(path.join(out, 'demo-pack.json'), JSON.stringify({ files, vault }));
fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(path.join(out, '.nojekyll'), '');

const kb = (f) => (fs.statSync(path.join(out, f)).size / 1024).toFixed(0) + ' KB';
console.log(`built dist/: engram-web.js ${kb('engram-web.js')}, engram-web.css ${kb('engram-web.css')}, demo-pack.json ${kb('demo-pack.json')} (${Object.keys(files).length} demo sessions)`);
