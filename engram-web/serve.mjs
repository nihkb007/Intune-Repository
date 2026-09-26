// Local server for dist/ plus the api/ functions, the same way Vercel serves them.
// The File System Access API needs http://localhost or https.
//   npm run serve                          (no login: presets stay in the browser)
//   ENGRAM_USERS=... ENGRAM_SESSION_SECRET=... ENGRAM_STORE=memory npm run serve
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' };

export function serve(port = Number(process.env.PORT) || 5173, { api = true } = {}) {
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const fn = pathname.match(/^\/api\/([a-z-]+)$/);
    if (fn) {
      const file = path.join(here, 'api', `${fn[1]}.js`);
      if (!api || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
      try { await require(file)(req, res); } catch (err) { res.writeHead(500); res.end(String(err.message)); }
      return;
    }
    const rel = pathname.replace(/^\/+/, '') || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  serve().then((s) => console.log(`ENGRAM Web on http://localhost:${s.address().port}`));
}
