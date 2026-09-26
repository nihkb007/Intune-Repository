'use strict';
// Just what ENGRAM's engine uses: short random ids and a stable (non-security) hash.
function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return { toString: () => [...b].map((x) => x.toString(16).padStart(2, '0')).join('') };
}
function createHash() {
  let s = '';
  return {
    update(x) { s += String(x); return this; },
    digest() {
      // two FNV-1a 32-bit lanes -> 16 hex chars
      let h1 = 0x811c9dc5; let h2 = 0x01000193;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
        h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
      }
      return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
    },
  };
}
module.exports = { randomBytes, createHash };
