#!/usr/bin/env python3
"""
Generate DJ Library Manager app icons.
Produces resources/icon.icns (macOS) and resources/icon.ico (Windows).
Run: python3 scripts/generate-icons.py
"""

import struct, zlib, math, os, shutil, subprocess, sys

SIZE = 1024
CX = CY = SIZE // 2

# ── Palette (matches app dark theme) ─────────────────────────────────────────
BG      = (13,  13,  20)     # surface-950
VINYL   = (20,  17,  32)     # dark vinyl
GROOVE  = (32,  27,  50)     # groove highlight
LABEL   = (48,  32,  88)     # center label
ACCENT  = (109, 40, 217)     # purple accent
ACCENT2 = (139, 92, 246)     # lighter purple
RIM     = (75,  55, 120)     # vinyl rim

def dist2(x, y):
    return (x - CX) ** 2 + (y - CY) ** 2

def in_rounded_rect(x, y, hw, hh, r):
    dx, dy = abs(x - CX), abs(y - CY)
    if dx > hw or dy > hh:
        return False
    if dx <= hw - r or dy <= hh - r:
        return True
    return (dx - (hw - r)) ** 2 + (dy - (hh - r)) ** 2 <= r * r

def lerp_color(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(a[i] + t * (b[i] - a[i])) for i in range(3))

def sheen(x, y):
    """Top-left light reflection on vinyl surface."""
    # angle from top-left
    angle = math.atan2(y - CY, x - CX)
    sheen_angle = -math.pi * 0.75  # top-left
    diff = abs(angle - sheen_angle)
    if diff > math.pi:
        diff = 2 * math.pi - diff
    return max(0.0, 0.18 * (1.0 - diff / (math.pi * 0.6)))

# ── Render pixels ─────────────────────────────────────────────────────────────
print("Rendering 1024×1024 icon…")
scanlines = []
for y in range(SIZE):
    row = bytearray()
    for x in range(SIZE):
        d2 = dist2(x, y)
        r  = math.sqrt(d2)

        # macOS rounded-square mask (matches system icon shape)
        if not in_rounded_rect(x, y, 480, 480, 215):
            row += bytes([0, 0, 0, 0])
            continue

        # ── Vinyl disc zones ───────────────────────────────────────────────
        if r > 445:
            # Outer background (corners of the rounded rect outside the disc)
            col = BG
        elif r > 436:
            # Outer vinyl rim — accent ring
            t = (r - 436) / 9.0
            col = lerp_color(RIM, ACCENT, 1 - t)
        elif r > 162:
            # Groove area — concentric bands
            sh = sheen(x, y)
            # groove bands every ~3px; every 4th band slightly lighter
            band = int(r) % 4
            base = GROOVE if band == 0 else VINYL
            bright = tuple(min(255, int(c + sh * 60)) for c in base)
            col = bright
        elif r > 157:
            # Label edge — thin accent ring
            col = lerp_color(ACCENT, ACCENT2, (r - 157) / 5.0)
        elif r > 42:
            # Center label — radial gradient
            t = (r - 42) / (157 - 42)
            col = lerp_color(LABEL, lerp_color(LABEL, ACCENT, 0.35), t)
        elif r > 34:
            # Spindle ring
            t = (r - 34) / 8.0
            col = lerp_color(ACCENT2, ACCENT, t)
        else:
            # Spindle hole
            col = BG

        row += bytes([col[0], col[1], col[2], 255])
    scanlines.append(bytes(row))

# ── Encode PNG ────────────────────────────────────────────────────────────────
def make_chunk(tag, data):
    c = tag + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

raw_data = b''.join(b'\x00' + row for row in scanlines)
ihdr = make_chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
idat = make_chunk(b'IDAT', zlib.compress(raw_data, 6))
iend = make_chunk(b'IEND', b'')
png_data = b'\x89PNG\r\n\x1a\n' + ihdr + idat + iend

base_png = 'resources/icon-1024.png'
with open(base_png, 'wb') as f:
    f.write(png_data)
print(f"  Wrote {base_png} ({len(png_data) // 1024} KB)")

# ── Build .icns via iconset ───────────────────────────────────────────────────
iconset = 'resources/icon.iconset'
os.makedirs(iconset, exist_ok=True)

ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
for sz in ICNS_SIZES:
    for scale, suffix in [(1, ''), (2, '@2x')]:
        px = sz * scale
        if px > 1024:
            continue
        out = f'{iconset}/icon_{sz}x{sz}{suffix}.png'
        subprocess.run(
            ['sips', '-z', str(px), str(px), base_png, '--out', out],
            check=True, capture_output=True
        )
print(f"  Generated iconset ({len(os.listdir(iconset))} sizes)")

subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', 'resources/icon.icns'], check=True)
print("  Wrote resources/icon.icns")
shutil.rmtree(iconset)

# ── Build .ico (Windows) — multi-size ICO ────────────────────────────────────
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ico_images = []
for sz in ICO_SIZES:
    tmp = f'resources/_ico_{sz}.png'
    subprocess.run(
        ['sips', '-z', str(sz), str(sz), base_png, '--out', tmp],
        check=True, capture_output=True
    )
    with open(tmp, 'rb') as f:
        ico_images.append((sz, f.read()))
    os.remove(tmp)

# ICO file format: header + directory + image data
n = len(ico_images)
header = struct.pack('<HHH', 0, 1, n)  # reserved, type=1 (ICO), count
dir_size = n * 16
data_offset = 6 + dir_size
directory = b''
image_data = b''
for sz, png in ico_images:
    w = sz if sz < 256 else 0
    h = sz if sz < 256 else 0
    directory += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(png), data_offset + len(image_data))
    image_data += png

with open('resources/icon.ico', 'wb') as f:
    f.write(header + directory + image_data)
print(f"  Wrote resources/icon.ico ({len(header + directory + image_data) // 1024} KB)")

# Cleanup temp PNG
os.remove(base_png)
print("Done. Icon files are in resources/")
