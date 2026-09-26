'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../lib/auth');
const { sanitizePresets } = require('../lib/presets');

const SECRET = 's'.repeat(40);
let users;

async function call(name, { method = 'GET', body, cookie, headers = {}, ip = '1.2.3.4' } = {}) {
  const handler = require(`../api/${name}.js`);
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  const req = { method, body, headers: { host: 'engram.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}), ...headers } };
  await handler(req, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, cookie: res.headers['set-cookie'] };
}
const W = { 'x-engram': '1' };

test.before(async () => {
  users = `nihko:${await auth.hashPassword('correct horse battery')},other:${await auth.hashPassword('another long password')}`;
});
const withEnv = (env) => { for (const k of ['ENGRAM_USERS', 'ENGRAM_SESSION_SECRET', 'ENGRAM_STORE', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[k]; Object.assign(process.env, env); };

test('without login configured the portal runs open and keeps presets in the browser', async () => {
  withEnv({});
  assert.deepEqual((await call('me')).json, { auth: false, misconfigured: false, store: 'none' });
  assert.equal((await call('presets')).status, 403);
  withEnv({ ENGRAM_USERS: users, ENGRAM_SESSION_SECRET: 'short' });
  assert.equal((await call('me')).json.misconfigured, true, 'short secret is reported, not silently accepted');
});

test('sign in, session cookie, sign out', async () => {
  withEnv({ ENGRAM_USERS: users, ENGRAM_SESSION_SECRET: SECRET, ENGRAM_STORE: 'memory' });
  assert.equal((await call('me')).status, 401);
  assert.equal((await call('login', { method: 'POST', body: { username: 'nihko', password: 'x' }, headers: W, ip: '9.9.9.1' })).status, 401);
  assert.equal((await call('login', { method: 'POST', body: { username: 'ghost', password: 'correct horse battery' }, headers: W, ip: '9.9.9.1' })).status, 401);
  assert.equal((await call('login', { method: 'POST', body: { username: 'nihko', password: 'correct horse battery' }, ip: '9.9.9.1' })).status, 403, 'cross-site form posts are refused');
  const ok = await call('login', { method: 'POST', body: { username: 'NIHKO', password: 'correct horse battery' }, headers: W, ip: '9.9.9.1' });
  assert.equal(ok.status, 200);
  assert.match(ok.cookie, /^engram_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000$/);
  const cookie = ok.cookie.split(';')[0];
  assert.deepEqual((await call('me', { cookie })).json, { auth: true, user: 'nihko', store: 'memory' });
  const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal((await call('me', { cookie: tampered })).status, 401, 'tampered cookie rejected');
  const out = await call('logout', { method: 'POST', headers: W, cookie });
  assert.match(out.cookie, /Max-Age=0/);
});

test('repeated wrong passwords are locked out for 15 minutes', async () => {
  withEnv({ ENGRAM_USERS: users, ENGRAM_SESSION_SECRET: SECRET, ENGRAM_STORE: 'memory' });
  for (let i = 0; i < 8; i++) assert.equal((await call('login', { method: 'POST', body: { username: 'nihko', password: 'bad' }, headers: W, ip: '7.7.7.7' })).status, 401);
  const blocked = await call('login', { method: 'POST', body: { username: 'nihko', password: 'correct horse battery' }, headers: W, ip: '7.7.7.7' });
  assert.equal(blocked.status, 429, 'even the right password waits');
  assert.equal((await call('login', { method: 'POST', body: { username: 'nihko', password: 'correct horse battery' }, headers: W, ip: '7.7.7.8' })).status, 200, 'other addresses unaffected');
});

test('presets are per user, validated, and writes need the same-origin header', async () => {
  withEnv({ ENGRAM_USERS: users, ENGRAM_SESSION_SECRET: SECRET, ENGRAM_STORE: 'memory' });
  const a = (await call('login', { method: 'POST', body: { username: 'nihko', password: 'correct horse battery' }, headers: W, ip: '5.5.5.1' })).cookie.split(';')[0];
  const b = (await call('login', { method: 'POST', body: { username: 'other', password: 'another long password' }, headers: W, ip: '5.5.5.2' })).cookie.split(';')[0];
  assert.equal((await call('presets')).status, 401);
  assert.deepEqual((await call('presets', { cookie: a })).json, { presets: [] });
  const list = [{ id: 'p_work1', name: 'WORK LAPTOP', laptop: 'WORK', drive: 'e', view: 'resume', color: '#00f0ff' }];
  assert.equal((await call('presets', { method: 'PUT', cookie: a, body: { presets: list } })).status, 403);
  const saved = await call('presets', { method: 'PUT', cookie: a, body: { presets: list }, headers: W });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.presets[0].drive, 'E');
  assert.equal(saved.json.presets[0].folder, 'E:\\claude-sessions');
  assert.equal((await call('presets', { cookie: a })).json.presets[0].name, 'WORK LAPTOP');
  assert.deepEqual((await call('presets', { cookie: b })).json, { presets: [] }, 'other user sees nothing');
  assert.equal((await call('presets', { method: 'PUT', cookie: a, body: { presets: 'nope' }, headers: W })).status, 400);
});

test('preset sanitising', () => {
  const [p] = sanitizePresets([{ name: 'x'.repeat(500), drive: '9', view: 'evil', color: 'red', folder: '' }]);
  assert.equal(p.name.length, 60);
  assert.equal(p.drive, 'E');
  assert.equal(p.view, 'nexus');
  assert.equal(p.folder, 'E:\\claude-sessions');
  assert.throws(() => sanitizePresets(Array(31).fill({})), /at most 30/);
});

test('Upstash/Vercel Redis REST adapter sends plain Redis commands', async () => {
  withEnv({ KV_REST_API_URL: 'https://kv.example.com/', KV_REST_API_TOKEN: 'tok' });
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, init) => { calls.push([url, init.headers.Authorization, JSON.parse(init.body)]); return { ok: true, json: async () => ({ result: calls.length === 1 ? 'OK' : JSON.stringify({ a: 1 }) }) }; };
  try {
    const store = require('../lib/store').createStore();
    assert.equal(store.kind, 'redis');
    await store.set('k', { a: 1 });
    assert.deepEqual(await store.get('k'), { a: 1 });
    assert.deepEqual(calls[0], ['https://kv.example.com', 'Bearer tok', ['SET', 'k', '{"a":1}']]);
    assert.deepEqual(calls[1][2], ['GET', 'k']);
  } finally { global.fetch = real; }
});
