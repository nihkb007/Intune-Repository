'use strict';
const { json, isSecure, sameOriginWrite, readBody } = require('../lib/http');
const { authConfig, verifyPassword, signSession, sessionCookie } = require('../lib/auth');
const { createStore } = require('../lib/store');

const WINDOW = 15 * 60;
const MAX_TRIES = 8;
// Checked when the user name is unknown, so both cases take the same time.
const DUMMY = 'pbkdf2$310000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!sameOriginWrite(req)) return json(res, 403, { error: 'Bad request origin' });
  const cfg = authConfig();
  if (!cfg.enabled) return json(res, 400, { error: 'Login is not set up on this deployment.' });
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'Invalid request' }); }
  const user = String(body.username || '').trim().toLowerCase().slice(0, 64);
  const password = String(body.password || '').slice(0, 256);
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
  const store = createStore();
  const key = `login-fail:${ip}`;
  const tries = await store.hit(key, WINDOW).catch(() => 0);
  if (tries > MAX_TRIES) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
  const ok = await verifyPassword(password, cfg.users.get(user) || DUMMY) && cfg.users.has(user);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 400));
    return json(res, 401, { error: 'Wrong user name or password.' });
  }
  await store.clear(key).catch(() => {});
  res.setHeader('Set-Cookie', sessionCookie(await signSession(user, cfg.secret), { secure: isSecure(req) }));
  return json(res, 200, { user });
};
