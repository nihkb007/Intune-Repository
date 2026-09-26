'use strict';
// Each browser profile is one "laptop": a random id kept in localStorage.
function host() {
  try {
    let h = localStorage.getItem('engram.host');
    if (!h) { h = 'browser-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('engram.host', h); }
    return h;
  } catch { return 'browser'; }
}
module.exports = { hostname: host, userInfo: () => ({ username: '' }), homedir: () => '/home', tmpdir: () => '/tmp', platform: () => 'web' };
