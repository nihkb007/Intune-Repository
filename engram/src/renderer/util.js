export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function money(v, digits) {
  const n = Number(v) || 0;
  const d = digits ?? (Math.abs(n) >= 1000 ? 0 : 2);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function tokens(v) {
  const n = Number(v) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export function ago(ts) {
  if (!ts) return '—';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

export function dur(ms) {
  if (!ms || ms < 0) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

export function when(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function icon(id, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 24 24"><use href="#i-${id}"/></svg>`;
}

export function md(src) {
  const html = window.marked ? window.marked.parse(String(src || ''), { gfm: true, breaks: false }) : esc(src);
  return window.DOMPurify ? window.DOMPurify.sanitize(html) : esc(src);
}

export function countUp(node, to, format, ms = 1100) {
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / ms);
    const e = 1 - Math.pow(1 - p, 4);
    node.textContent = format(to * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Text scramble effect for headings. */
export function scramble(node, text, ms = 500) {
  const chars = '!<>-_\\/[]{}—=+*^?#01ABCDEF';
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / ms);
    const n = Math.floor(text.length * p);
    node.textContent = text.slice(0, n) + Array.from(text.slice(n), (c) => (c === ' ' ? ' ' : chars[Math.floor(Math.random() * chars.length)])).join('');
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
