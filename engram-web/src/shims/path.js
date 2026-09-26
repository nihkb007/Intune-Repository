'use strict';
// path-browserify is POSIX only; ENGRAM also reads Windows paths from transcripts
// (E:\code\app), so add the few win32 helpers it uses.
const posix = require('path-browserify');

const split = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]+/);
const win32 = {
  sep: '\\',
  isAbsolute: (p) => /^[A-Za-z]:[\\/]|^\\\\/.test(String(p)),
  relative(from, to) {
    const a = split(from);
    const b = split(to);
    let i = 0;
    while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
    if (i === 0) return String(to);
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('\\');
  },
  dirname(p) { const parts = split(p); return parts.length > 1 ? parts.slice(0, -1).join('\\') : String(p); },
  basename(p) { return split(p).pop(); },
  join(...ps) { return ps.filter(Boolean).join('\\').replace(/[\\/]+/g, '\\'); },
};

module.exports = { ...posix, posix, win32 };
