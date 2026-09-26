'use strict';
const { json, isSecure, sameOriginWrite, readBody } = require('../lib/http');
const { signSession, sessionCookie } = require('../lib/auth');
const { createFirstAccount, SetupError } = require('../lib/accounts');

// First run: make the site's account (needs storage and the setup code), then sign in.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!sameOriginWrite(req)) return json(res, 403, { error: 'Bad request origin' });
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'Invalid request' }); }
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
  try {
    const { user, secret } = await createFirstAccount({ username: body.username, password: body.password, code: body.code, ip });
    res.setHeader('Set-Cookie', sessionCookie(await signSession(user, secret), { secure: isSecure(req) }));
    return json(res, 200, { user });
  } catch (err) {
    if (err instanceof SetupError) return json(res, err.status, { error: err.message });
    return json(res, 500, { error: 'Could not create the account.' });
  }
};
