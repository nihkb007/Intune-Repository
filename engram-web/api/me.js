'use strict';
const { json, session } = require('../lib/http');

// Tells the portal whether login is on, who is signed in, where presets are kept, and (on a
// fresh site) what's still missing before the account can be made.
module.exports = async (req, res) => {
  const { cfg, user } = await session(req);
  const store = cfg.store.kind;
  if (!cfg.enabled) {
    const setup = cfg.setupOpen ? { storage: store !== 'none', code: cfg.hasSetupCode } : null;
    return json(res, 200, { auth: false, misconfigured: cfg.misconfigured, store, setup, ...(cfg.storeError ? { storeError: cfg.storeError } : {}) });
  }
  if (!user) return json(res, 401, { auth: true, store });
  return json(res, 200, { auth: true, user, store });
};
