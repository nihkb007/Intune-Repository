'use strict';
const { json, session } = require('../lib/http');
const { storeConfig } = require('../lib/store');

// Tells the portal whether login is on, who is signed in, and where presets are kept.
module.exports = async (req, res) => {
  const { cfg, user } = await session(req);
  const store = storeConfig().kind;
  if (!cfg.enabled) return json(res, 200, { auth: false, misconfigured: cfg.misconfigured, store });
  if (!user) return json(res, 401, { auth: true, store });
  return json(res, 200, { auth: true, user, store });
};
