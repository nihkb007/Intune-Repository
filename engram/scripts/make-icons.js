'use strict';
// Renders ENGRAM's app icon and NSIS installer artwork with Electron's offscreen renderer.
// Run with:  npx electron scripts/make-icons.js
// Writes build/icon.png (1024), build/icon.ico, build/installerSidebar.bmp (164x314),
// build/installerHeader.bmp (150x57).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build');
const fontDir = path.join(__dirname, '..', 'node_modules', '@fontsource', 'orbitron', 'files');
const fontFile = fs.readdirSync(fontDir).find((f) => /latin-900-normal\.woff2$/.test(f));
const font = `@font-face{font-family:Orbitron;font-weight:900;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(fontDir, fontFile)).toString('base64')})}`;

const MARK = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 32 32" style="filter:drop-shadow(0 0 ${s / 30}px #00f0ff)">
  <path d="M16 2 29 9.5v13L16 30 3 22.5v-13Z" fill="none" stroke="#00f0ff" stroke-width="1.6"/>
  <path d="M16 8v16M10 11.5l6 3.5 6-3.5M10 20.5l6-3.5 6 3.5" fill="none" stroke="#ff2bd6" stroke-width="1.6"/>
  <circle cx="16" cy="16" r="2.2" fill="#fff"/></svg>`;

const ICON = `<div style="width:1024px;height:1024px;display:grid;place-items:center;background:transparent">
  <div style="width:880px;height:880px;border-radius:190px;display:grid;place-items:center;
    background:radial-gradient(circle at 50% 38%,#1a1f45,#05060b 70%);box-shadow:inset 0 0 0 10px rgba(0,240,255,.35),inset 0 0 120px rgba(255,43,214,.25)">${MARK(640)}</div></div>`;

const grid = (w, h) => `<svg width="${w}" height="${h}" style="position:absolute;inset:0">${Array.from({ length: 16 }, (_, i) => `<line x1="${w / 2 + (i - 8) * 6}" y1="${h * 0.62}" x2="${w / 2 + (i - 8) * 60}" y2="${h}" stroke="rgba(0,240,255,.35)" stroke-width="1"/>`).join('')}${Array.from({ length: 8 }, (_, k) => { const y = h * 0.62 + Math.pow(k / 8, 2) * h * 0.38; return `<line x1="0" x2="${w}" y1="${y}" y2="${y}" stroke="rgba(255,43,214,${0.2 + k * 0.08})"/>`; }).join('')}</svg>`;

const SIDEBAR = `<div style="position:relative;width:164px;height:314px;overflow:hidden;background:linear-gradient(180deg,#0b1024,#05060b 55%,#1a0620)">
  ${grid(164, 314)}
  <div style="position:absolute;top:44px;left:0;right:0;text-align:center">${MARK(72)}</div>
  <div style="position:absolute;top:134px;left:0;right:0;text-align:center;font:900 22px Orbitron;letter-spacing:3px;color:#00f0ff;text-shadow:0 0 10px #00f0ff">ENGRAM</div>
  <div style="position:absolute;top:166px;left:0;right:0;text-align:center;font:900 7px Orbitron;letter-spacing:2.5px;color:#ff2bd6">CLAUDE COMMAND CENTER</div></div>`;

const HEADER = `<div style="position:relative;width:150px;height:57px;background:#05060b;display:flex;align-items:center;gap:8px;padding-left:10px;box-sizing:border-box">
  ${MARK(36)}<div style="font:900 15px Orbitron;letter-spacing:2px;color:#00f0ff;text-shadow:0 0 6px #00f0ff">ENGRAM</div></div>`;

function bmp24(img) {
  const { width: w, height: h } = img.getSize();
  const bgra = img.toBitmap();
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = 54 + (h - 1 - y) * row + x * 3;
      buf[d] = bgra[s]; buf[d + 1] = bgra[s + 1]; buf[d + 2] = bgra[s + 2];
    }
  }
  return buf;
}

/** PNG-in-ICO container (Vista+), sizes 16..256. */
function ico(pngs) {
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

async function render(html, w, h) {
  const win = new BrowserWindow({ width: w, height: h, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const tmp = path.join(require('os').tmpdir(), `engram-art-${w}x${h}.html`);
  fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8"><style>${font}html,body{margin:0;background:transparent}</style>${html}`);
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  win.destroy();
  return img.getSize().width === w ? img : img.resize({ width: w, height: h, quality: 'best' });
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // keep running between renders
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const icon = await render(ICON, 1024, 1024);
  fs.writeFileSync(path.join(OUT, 'icon.png'), icon.toPNG());
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(sizes.map((size) => ({ size, data: icon.resize({ width: size, height: size, quality: 'best' }).toPNG() }))));
  fs.writeFileSync(path.join(OUT, 'installerSidebar.bmp'), bmp24(await render(SIDEBAR, 164, 314)));
  fs.writeFileSync(path.join(OUT, 'installerHeader.bmp'), bmp24(await render(HEADER, 150, 57)));
  console.log('icons written to', OUT);
  app.quit();
});
