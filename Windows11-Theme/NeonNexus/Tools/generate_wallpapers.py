#!/usr/bin/env python3
"""
NEON NEXUS - procedural wallpaper generator
Author : Nick Butcher
GitHub : https://github.com/nihkb007/Intune-Repository

Renders the theme's 4K wallpapers with an HDR-style pipeline:
emissive layer -> multi-radius bloom -> filmic tonemap -> grain/vignette.

Usage:
    pip install pillow numpy
    python generate_wallpapers.py [--out ../Wallpapers] [--width 3840 --height 2160]
"""

import argparse
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# name -> (primary, secondary)
ACCENTS = {
    "cyan":    ((0x00, 0xE5, 0xFF), (0xFF, 0x2E, 0x88)),
    "magenta": ((0xFF, 0x2E, 0x88), (0x7A, 0x5C, 0xFF)),
    "violet":  ((0x9D, 0x4D, 0xFF), (0x00, 0xE5, 0xFF)),
    "toxic":   ((0x39, 0xFF, 0x14), (0x00, 0xB3, 0xFF)),
    "ember":   ((0xFF, 0x6A, 0x00), (0xFF, 0x1F, 0x4B)),
}

SS = 2  # supersampling factor for crisp anti-aliased lines


def c01(rgb):
    return np.array(rgb, dtype=np.float32) / 255.0


def lerp(a, b, t):
    return a + (b - a) * t


def bloom(emissive, radii=(6, 24, 80, 220), weights=(0.9, 0.7, 0.5, 0.35)):
    """Multi-radius glow computed at reduced resolution, then upscaled."""
    h, w, _ = emissive.shape
    out = np.zeros_like(emissive)
    for r, wt in zip(radii, weights):
        scale = max(1, int(r // 6))
        sw, sh = max(1, w // scale), max(1, h // scale)
        img = Image.fromarray(np.clip(emissive * 255 / 4.0, 0, 255).astype(np.uint8))
        small = img.resize((sw, sh), Image.BILINEAR)
        small = small.filter(ImageFilter.GaussianBlur(radius=max(1.0, r / scale)))
        up = np.asarray(small.resize((w, h), Image.BILINEAR), dtype=np.float32) / 255.0 * 4.0
        out += up * wt
    return out


def tonemap(x):
    # ACES-ish filmic curve
    a, b, c, d, e = 2.51, 0.03, 2.43, 0.59, 0.14
    return np.clip((x * (a * x + b)) / (x * (c * x + d) + e), 0, 1)


def finish(hdr, seed):
    rng = np.random.default_rng(seed)
    h, w, _ = hdr.shape
    ldr = tonemap(hdr)
    # vignette
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = (xx / w - 0.5) * 1.6, (yy / h - 0.5) * 1.9
    vig = np.clip(1.0 - (nx ** 2 + ny ** 2) * 0.55, 0.25, 1.0)[..., None]
    ldr *= vig
    # scanlines + grain
    ldr *= (0.965 + 0.035 * (np.sin(yy * math.pi / 2.0) ** 2))[..., None]
    ldr += rng.normal(0, 0.012, size=(h, w, 1)).astype(np.float32)
    # gamma
    ldr = np.clip(ldr, 0, 1) ** (1 / 1.08)
    return Image.fromarray((ldr * 255 + 0.5).astype(np.uint8))


def draw_layer(w, h, fn):
    """Draw with PIL at SS resolution, return float RGB at w x h."""
    img = Image.new("RGB", (w * SS, h * SS), (0, 0, 0))
    fn(ImageDraw.Draw(img), w * SS, h * SS)
    img = img.resize((w, h), Image.LANCZOS)
    return np.asarray(img, dtype=np.float32) / 255.0


# ---------------------------------------------------------------- HORIZON --
def render_horizon(w, h, primary, secondary, seed):
    rng = np.random.default_rng(seed)
    p, s = c01(primary), c01(secondary)
    hz = 0.60  # horizon line (fraction of height)

    yy = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    xx = np.linspace(0, 1, w, dtype=np.float32)[None, :, None]

    # sky gradient: void -> deep secondary tint -> hot horizon haze
    top = np.array([0.008, 0.006, 0.02], np.float32)
    mid = s * 0.10 + np.array([0.02, 0.0, 0.05], np.float32)
    t = np.clip(yy / hz, 0, 1)
    sky = lerp(top, mid, t ** 1.6)
    haze = np.exp(-((yy - hz) ** 2) / 0.0012) * (p * 0.35 + s * 0.25)
    sky = sky + haze * np.exp(-((xx - 0.5) ** 2) / 0.25)
    floor = lerp(mid * 0.6, np.array([0.004, 0.003, 0.01], np.float32),
                 np.clip((yy - hz) / (1 - hz), 0, 1) ** 0.6)
    base = np.where(yy < hz, sky, floor) * np.ones((1, w, 1), np.float32)

    # stars
    n = int(w * h / 2600)
    sx = rng.integers(0, w, n)
    sy = (rng.random(n) ** 1.8 * hz * h * 0.92).astype(int)
    sb = rng.random(n) ** 6 * 1.6 + 0.05
    stars = np.zeros((h, w, 3), np.float32)
    tint = lerp(np.ones(3, np.float32), p, 0.35)
    stars[sy, sx] += sb[:, None] * tint

    # sun: striped disc behind skyline
    R = h * 0.24
    cx, cy = w * 0.5, h * hz - R * 0.38

    def sun(d, W, H):
        sc = SS
        ccx, ccy, rr = cx * sc, cy * sc, R * sc
        for i in range(int(rr * 2)):
            y = ccy - rr + i
            dy = y - ccy
            if abs(dy) > rr:
                continue
            f = i / (rr * 2)
            # stripe cut-outs thicken toward the bottom
            if f > 0.30:
                period = rr * 0.12
                gap = ((f - 0.30) / 0.70) ** 0.8 * period * 0.8
                if ((i - rr * 0.60) % period) < gap:
                    continue
            half = math.sqrt(rr * rr - dy * dy)
            col = lerp(np.array(secondary, np.float32), np.array(primary, np.float32), f)
            d.line([(ccx - half, y), (ccx + half, y)], fill=tuple(int(v) for v in col))
    sun_layer = draw_layer(w, h, sun)
    sun_layer *= (yy < hz).astype(np.float32)

    # skyline silhouette (colour windows + coverage mask drawn in one pass)
    sky_img = Image.new("RGB", (w * SS, h * SS), (0, 0, 0))
    msk_img = Image.new("L", (w * SS, h * SS), 0)
    dc, dm = ImageDraw.Draw(sky_img), ImageDraw.Draw(msk_img)
    W, H = w * SS, h * SS
    x, base_y = 0, hz * H
    while x < W:
        bw = int(rng.integers(int(W * 0.008), int(W * 0.03)))
        dist = abs((x + bw / 2) / W - 0.5)
        bh = rng.random() ** 2.2 * H * (0.16 - dist * 0.12) + H * 0.012
        dm.rectangle([x, base_y - bh, x + bw, base_y], fill=255)
        rim = tuple(int(v * 0.55) for v in (primary if rng.random() < 0.5 else secondary))
        dc.line([(x, base_y - bh), (x + bw, base_y - bh)], fill=rim, width=SS)
        if rng.random() < 0.25 and bh > H * 0.05:
            ax = x + bw // 2
            dm.line([(ax, base_y - bh), (ax, base_y - bh * 1.18)], fill=255, width=SS * 2)
            dc.ellipse([ax - SS * 3, base_y - bh * 1.18 - SS * 3, ax + SS * 3, base_y - bh * 1.18 + SS * 3],
                       fill=tuple(secondary))
        for _ in range(int(bh * bw / (SS * SS * 260))):
            wx = x + rng.integers(2, max(3, bw - 4))
            wy = base_y - rng.integers(4, max(5, int(bh) - 2))
            c = primary if rng.random() < 0.7 else secondary
            k = rng.random() * 0.8 + 0.2
            dc.rectangle([wx, wy, wx + SS * 2, wy + SS * 2], fill=tuple(int(v * k) for v in c))
        x += bw + int(rng.integers(0, int(W * 0.004)))
    sil = np.asarray(msk_img.resize((w, h), Image.LANCZOS), np.float32)[..., None] / 255.0
    windows = np.asarray(sky_img.resize((w, h), Image.LANCZOS), np.float32) / 255.0

    # perspective neon grid
    def grid(d, W, H):
        hy = hz * H
        vx = W / 2
        pc = tuple(int(v) for v in primary)
        k = 0.0
        while True:
            y = hy + (H - hy) / (1 + k * 0.42)
            nxt = hy + (H - hy) / (1 + (k + 1) * 0.42)
            if y - nxt < SS * 5:
                break
            d.line([(0, y), (W, y)], fill=pc, width=SS * (2 if y > hy + (H - hy) * 0.3 else 1))
            k += 1
        for i in range(-60, 61):
            d.line([(vx, hy), (vx + i * W * 0.06, H)], fill=pc, width=SS)
    grid_layer = draw_layer(w, h, grid)
    grid_layer *= (yy > hz).astype(np.float32)
    # fade grid into horizon haze
    grid_layer *= np.clip((yy - hz) / 0.12, 0, 1) ** 1.8

    emissive = sun_layer * 0.95 + grid_layer * 1.1 + windows * 1.6
    glow = bloom(emissive)
    hdr = base + stars + glow * 0.55
    hdr = hdr * (1 - sil) + (windows * 1.6 + np.array([0.004, 0.004, 0.012], np.float32)) * sil
    hdr += emissive * (1 - sil) * 0.8
    # horizon laser line
    hdr += np.exp(-((yy - hz) ** 2) / 0.000004) * p * 3.0 * np.exp(-((xx - 0.5) ** 2) / 0.08)
    # reflection of sun on the floor
    refl = np.flip(sun_layer, axis=0)
    shift = int(h - 2 * hz * h)
    refl = np.roll(refl, -shift, axis=0) if shift else refl
    hdr += refl * (yy > hz) * 0.12 * np.exp(-(yy - hz) / 0.08)
    return finish(hdr, seed)


# ------------------------------------------------------------------- FLUX --
def render_flux(w, h, primary, secondary, seed):
    rng = np.random.default_rng(seed + 99)
    p, s = c01(primary), c01(secondary)
    yy = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    xx = np.linspace(0, 1, w, dtype=np.float32)[None, :, None]
    base = (np.array([0.006, 0.005, 0.014], np.float32)
            + s * 0.06 * np.exp(-((xx - 0.85) ** 2 + (yy - 0.2) ** 2) / 0.12)
            + p * 0.05 * np.exp(-((xx - 0.1) ** 2 + (yy - 0.9) ** 2) / 0.15))

    ribbons = 70
    phases = rng.random(4) * 6.28

    def flux(d, W, H):
        for r in range(ribbons):
            f = r / (ribbons - 1)
            col = lerp(np.array(primary, np.float32), np.array(secondary, np.float32), f)
            bright = 0.35 + 0.65 * math.sin(f * math.pi) ** 2
            col = tuple(int(c * bright) for c in col)
            pts = []
            for i in range(0, 721):
                x = i / 720
                y = (0.5
                     + 0.16 * math.sin(x * 5.2 + phases[0] + f * 1.9)
                     + 0.07 * math.sin(x * 11.0 + phases[1] - f * 3.1)
                     + 0.03 * math.sin(x * 23.0 + phases[2] + f * 6.0)
                     + (f - 0.5) * 0.22 * (0.6 + 0.4 * math.sin(x * 3.0 + phases[3])))
                pts.append((x * W, y * H))
            d.line(pts, fill=col, width=SS, joint="curve")
    layer = draw_layer(w, h, flux)

    # data particles along the flow
    def dots(d, W, H):
        for _ in range(1400):
            x, y = rng.random() * W, (0.5 + rng.normal(0, 0.14)) * H
            r = rng.random() ** 4 * SS * 5 + SS
            c = primary if rng.random() < 0.6 else secondary
            k = rng.random() * 0.8 + 0.2
            d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(int(v * k) for v in c))
    parts = draw_layer(w, h, dots)

    # HUD rings
    def hud(d, W, H):
        cx, cy = W * 0.78, H * 0.30
        pc = tuple(int(v * 0.8) for v in primary)
        for i, R in enumerate([0.10, 0.13, 0.135, 0.19]):
            rr = R * H
            start = rng.random() * 360
            span = 200 + rng.random() * 140
            d.arc([cx - rr, cy - rr, cx + rr, cy + rr], start, start + span, fill=pc,
                  width=SS * (3 if i == 1 else 1))
        for a in range(0, 360, 6):
            ang = math.radians(a)
            r1, r2 = 0.205 * H, (0.215 if a % 30 == 0 else 0.21) * H
            d.line([(cx + r1 * math.cos(ang), cy + r1 * math.sin(ang)),
                    (cx + r2 * math.cos(ang), cy + r2 * math.sin(ang))], fill=pc, width=SS)
    rings = draw_layer(w, h, hud)

    emissive = layer * 1.9 + parts * 1.8 + rings * 1.5
    hdr = base + emissive + bloom(emissive) * 0.85
    return finish(hdr, seed + 7)


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--out", default=os.path.join(here, "..", "Wallpapers"))
    ap.add_argument("--width", type=int, default=3840)
    ap.add_argument("--height", type=int, default=2160)
    ap.add_argument("--only", default=None, help="render a single accent")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    for i, (name, (p, s)) in enumerate(ACCENTS.items()):
        if args.only and name != args.only:
            continue
        for style, fn in (("horizon", render_horizon), ("flux", render_flux)):
            path = os.path.join(args.out, f"nexus-{style}-{name}.jpg")
            img = fn(args.width, args.height, p, s, seed=1337 + i)
            img.save(path, "JPEG", quality=90, optimize=True, progressive=True, subsampling=0)
            print("wrote", path)


if __name__ == "__main__":
    main()
