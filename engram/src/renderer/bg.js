// Ambient backdrop: synthwave perspective grid, drifting data motes, a sun-like horizon glow.
export function startBackground(canvas, getMode) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, dpr = 1, t = 0, last = 0, raf = 0;
  const motes = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random(), s: Math.random() }));

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const mode = getMode();
    if (mode === 'off' || document.hidden) return;
    if (now - last < (mode === 'reduced' ? 100 : 33)) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt;
    ctx.clearRect(0, 0, w, h);

    const horizon = h * 0.58;
    // horizon glow
    const g = ctx.createRadialGradient(w * 0.62, horizon, 0, w * 0.62, horizon, w * 0.55);
    g.addColorStop(0, 'rgba(255,43,214,0.16)');
    g.addColorStop(0.4, 'rgba(120,40,255,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // perspective grid
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, horizon, w, h - horizon);
    ctx.clip();
    const vx = w * 0.62;
    ctx.lineWidth = 1;
    for (let i = -24; i <= 24; i++) {
      const x = vx + i * 90;
      const a = Math.max(0, 0.22 - Math.abs(i) * 0.006);
      ctx.strokeStyle = `rgba(0,240,255,${a})`;
      ctx.beginPath();
      ctx.moveTo(vx + i * 4, horizon);
      ctx.lineTo(x + (x - vx) * 3, h);
      ctx.stroke();
    }
    const speed = mode === 'reduced' ? 0.05 : 0.18;
    const off = (t * speed) % 1;
    for (let k = 0; k < 18; k++) {
      const p = (k + off) / 18;
      const y = horizon + Math.pow(p, 2.6) * (h - horizon);
      ctx.strokeStyle = `rgba(255,43,214,${0.05 + p * 0.22})`;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    const fade = ctx.createLinearGradient(0, horizon, 0, horizon + 80);
    fade.addColorStop(0, 'rgba(5,6,11,1)');
    fade.addColorStop(1, 'rgba(5,6,11,0)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, horizon, w, 80);
    ctx.restore();

    // motes
    for (const m of motes) {
      m.y -= dt * (0.004 + m.z * 0.012);
      if (m.y < -0.02) { m.y = 1.02; m.x = Math.random(); }
      const x = m.x * w + Math.sin(t * 0.6 + m.s * 10) * 8;
      const y = m.y * h;
      const r = 0.6 + m.z * 1.4;
      ctx.fillStyle = m.s > 0.7 ? `rgba(255,43,214,${0.25 + m.z * 0.4})` : `rgba(0,240,255,${0.2 + m.z * 0.45})`;
      ctx.fillRect(x, y, r, r * (m.s > 0.85 ? 6 : 1));
    }

    // rare glitch band
    if (mode === 'full' && Math.random() < 0.012) {
      const y = Math.random() * h;
      ctx.fillStyle = 'rgba(0,240,255,0.05)';
      ctx.fillRect(0, y, w, 2 + Math.random() * 6);
    }
  }

  window.addEventListener('resize', resize);
  resize();
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
