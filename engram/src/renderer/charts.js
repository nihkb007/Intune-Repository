// Hand-built SVG charts with hover layers. No dependencies.
// Categorical series palette (validated for dark surface, CVD-separated, fixed order).
export const SERIES = ['#00a3ba', '#e0602f', '#8b7bff', '#25a86b', '#e23aa6', '#b08c16'];

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const tipEl = () => document.getElementById('tip');
export function showTip(html, x, y) {
  const t = tipEl();
  t.innerHTML = html;
  t.classList.remove('hidden');
  const r = t.getBoundingClientRect();
  const nx = x + 16 + r.width > window.innerWidth ? x - r.width - 16 : x + 16;
  const ny = Math.min(window.innerHeight - r.height - 8, Math.max(8, y - r.height / 2));
  t.style.left = nx + 'px';
  t.style.top = ny + 'px';
}
export function hideTip() { tipEl().classList.add('hidden'); }

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/**
 * Stacked area chart. days: [{date, values:{seriesId: number}}]; series: [{id, name, color}]
 */
export function stackedArea(container, days, series, { height = 250, fmt = (v) => v.toFixed(2) } = {}) {
  container.innerHTML = '';
  const W = container.clientWidth || 800;
  const H = height;
  const m = { l: 44, r: 12, t: 12, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H });
  container.appendChild(svg);
  const defs = el('defs', {}, svg);
  const glow = el('filter', { id: 'glow', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
  el('feGaussianBlur', { stdDeviation: '3', result: 'b' }, glow);
  const merge = el('feMerge', {}, glow);
  el('feMergeNode', { in: 'b' }, merge);
  el('feMergeNode', { in: 'SourceGraphic' }, merge);

  if (!days.length) {
    el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#6c7a98', 'font-size': 12 }, svg).textContent = 'No spend recorded yet';
    return;
  }
  const totals = days.map((d) => series.reduce((a, s) => a + (d.values[s.id] || 0), 0));
  const max = niceMax(Math.max(...totals) * 1.1);
  const x = (i) => m.l + (days.length === 1 ? iw / 2 : (i / (days.length - 1)) * iw);
  const y = (v) => m.t + ih - (v / max) * ih;

  const axis = el('g', { class: 'axis' }, svg);
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'grid-line' }, axis);
    el('text', { x: m.l - 8, y: y(v) + 3, 'text-anchor': 'end' }, axis).textContent = '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(v < 10 ? 1 : 0));
  }
  const step = Math.max(1, Math.ceil(days.length / 8));
  days.forEach((d, i) => {
    const last = i === days.length - 1;
    if (last ? (i % step) < step * 0.6 && i % step !== 0 : i % step) return;
    el('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }, axis).textContent = d.date.slice(5).replace('-', '/');
  });

  const base = days.map(() => 0);
  series.forEach((s, si) => {
    const top = days.map((d, i) => base[i] + (d.values[s.id] || 0));
    const gid = `ag${si}${Math.random().toString(36).slice(2, 6)}`;
    const lg = el('linearGradient', { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
    el('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 0.55 }, lg);
    el('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0.04 }, lg);
    const upper = top.map((v, i) => `${x(i)},${y(v)}`);
    const lower = base.map((v, i) => `${x(i)},${y(v)}`).reverse();
    el('path', { d: `M${upper.join('L')}L${lower.join('L')}Z`, fill: `url(#${gid})` }, svg);
    const line = el('path', { d: `M${upper.join('L')}`, fill: 'none', stroke: s.color, 'stroke-width': 2, filter: 'url(#glow)', 'stroke-linejoin': 'round' }, svg);
    const len = line.getTotalLength ? line.getTotalLength() : 1000;
    line.style.strokeDasharray = len;
    line.style.strokeDashoffset = len;
    line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1400, delay: si * 150, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    top.forEach((v, i) => { base[i] = v; });
  });

  // hover crosshair
  const cross = el('line', { y1: m.t, y2: m.t + ih, stroke: '#00f0ff', 'stroke-opacity': 0, 'stroke-width': 1 }, svg);
  const dot = el('circle', { r: 4, fill: '#05060b', stroke: '#00f0ff', 'stroke-width': 2, opacity: 0 }, svg);
  const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(days.length - 1, Math.round(((px - m.l) / iw) * (days.length - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('stroke-opacity', 0.6);
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(totals[i])); dot.setAttribute('opacity', 1);
    const rows = series.map((s) => `<div class="row"><i style="--c:${s.color}"></i>${esc(s.name)}<b>$${fmt(days[i].values[s.id] || 0)}</b></div>`).join('');
    showTip(`<div class="th">${days[i].date}</div>${rows}<div class="row" style="margin-top:4px;color:#fcee0a">TOTAL<b>$${fmt(totals[i])}</b></div>`, e.clientX, e.clientY);
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('stroke-opacity', 0); dot.setAttribute('opacity', 0); hideTip(); });
}

/** Donut. items: [{label, value, color}] */
export function donut(container, items, { size = 190, thickness = 22, center = '', sub = '', fmt = (v) => v } = {}) {
  container.innerHTML = '';
  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  container.appendChild(svg);
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const r = size / 2 - thickness / 2 - 4;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  el('circle', { cx, cy: cx, r, fill: 'none', stroke: 'rgba(255,255,255,0.05)', 'stroke-width': thickness }, svg);
  let acc = 0;
  const gap = items.length > 1 ? 2 : 0;
  items.forEach((it, i) => {
    const frac = it.value / total;
    const len = Math.max(0, frac * c - gap);
    const seg = el('circle', {
      cx, cy: cx, r, fill: 'none', stroke: it.color, 'stroke-width': thickness,
      'stroke-dasharray': `0 ${c}`, 'stroke-dashoffset': -acc, transform: `rotate(-90 ${cx} ${cx})`,
      style: `filter: drop-shadow(0 0 5px ${it.color}); cursor: pointer; transition: stroke-width .2s`,
    }, svg);
    seg.animate([{ strokeDasharray: `0 ${c}` }, { strokeDasharray: `${len} ${c - len}` }], { duration: 1100, delay: 200 + i * 90, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    seg.addEventListener('mousemove', (e) => { seg.setAttribute('stroke-width', thickness + 5); showTip(`<div class="th">${esc(it.label)}</div><div class="row"><i style="--c:${it.color}"></i>${(frac * 100).toFixed(1)}%<b>${fmt(it.value)}</b></div>`, e.clientX, e.clientY); });
    seg.addEventListener('mouseleave', () => { seg.setAttribute('stroke-width', thickness); hideTip(); });
    acc += frac * c;
  });
  const t1 = el('text', { x: cx, y: cx + 2, 'text-anchor': 'middle', fill: '#e6f1ff', 'font-family': 'Orbitron', 'font-weight': 700, 'font-size': 20 }, svg);
  t1.textContent = center;
  const t2 = el('text', { x: cx, y: cx + 20, 'text-anchor': 'middle', fill: '#6c7a98', 'font-family': 'Orbitron', 'font-size': 8, 'letter-spacing': '2' }, svg);
  t2.textContent = sub;
}

export function sparkline(values, { color = '#00f0ff', w = 120, h = 36, fill = true } = {}) {
  const max = Math.max(...values, 0.0001);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`);
  const id = 'sp' + Math.random().toString(36).slice(2, 7);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".45"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${fill ? `<path d="M0,${h}L${pts.join('L')}L${w},${h}Z" fill="url(#${id})"/>` : ''}
    <path d="M${pts.join('L')}" fill="none" stroke="${color}" stroke-width="1.6" style="filter:drop-shadow(0 0 3px ${color})" vector-effect="non-scaling-stroke"/></svg>`;
}

export function gauge(frac, { color = '#00f0ff', label = '' } = {}) {
  const r = 38, c = 2 * Math.PI * r, arc = 0.75;
  const f = Math.max(0, Math.min(1, frac));
  const col = frac > 1 ? '#ff3b5c' : frac > 0.85 ? '#fcee0a' : color;
  return `<svg class="gauge" viewBox="0 0 92 92">
    <circle cx="46" cy="46" r="${r}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="7" stroke-dasharray="${c * arc} ${c}" transform="rotate(135 46 46)"/>
    <circle cx="46" cy="46" r="${r}" fill="none" stroke="${col}" stroke-width="7" stroke-dasharray="${c * arc * f} ${c}" transform="rotate(135 46 46)" style="filter:drop-shadow(0 0 6px ${col})">
      <animate attributeName="stroke-dasharray" from="0 ${c}" to="${c * arc * f} ${c}" dur="1.2s" fill="freeze" calcMode="spline" keySplines=".2 .8 .2 1"/></circle>
    <text x="46" y="50" text-anchor="middle">${Math.round(frac * 100)}%</text>
    <text x="46" y="66" text-anchor="middle" style="font:600 7px Orbitron;fill:#6c7a98;letter-spacing:1.5px">${label}</text></svg>`;
}

/** 7x24 heatmap (HTML grid). */
export function heatmap(container, matrix, fmt) {
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const max = Math.max(...matrix.flat(), 0.0001);
  let html = '<div class="heat">';
  for (const d of order) {
    html += `<div class="lbl">${days[d]}</div>`;
    for (let hr = 0; hr < 24; hr++) {
      const v = matrix[d][hr];
      const a = v ? 0.08 + 0.85 * Math.sqrt(v / max) : 0.02;
      html += `<div class="cell" style="--a:${a.toFixed(3)}" data-d="${days[d]}" data-h="${hr}" data-v="${v}"></div>`;
    }
  }
  html += '<div></div>' + Array.from({ length: 24 }, (_, i) => `<div style="text-align:center">${i % 3 ? '' : String(i).padStart(2, '0')}</div>`).join('') + '</div>';
  container.innerHTML = html;
  container.querySelectorAll('.cell').forEach((c) => {
    c.addEventListener('mousemove', (e) => showTip(`<div class="th">${c.dataset.d} ${String(c.dataset.h).padStart(2, '0')}:00</div><div class="row">spend<b>${fmt(+c.dataset.v)}</b></div>`, e.clientX, e.clientY));
    c.addEventListener('mouseleave', hideTip);
  });
}
