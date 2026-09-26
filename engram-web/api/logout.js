'use strict';
const { json, isSecure, sameOriginWrite } = require('../lib/http');
const { sessionCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!sameOriginWrite(req)) return json(res, 403, { error: 'Bad request origin' });
  res.setHeader('Set-Cookie', sessionCookie('', { secure: isSecure(req), clear: true }));
  return json(res, 200, { ok: true });
};
