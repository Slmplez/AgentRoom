"""Render Agent Room's original README animation with Pillow and NumPy.

Run: python -m pip install -r scripts/requirements-artwork.txt
     python scripts/build-readme-hero.py

Uses the checked-in avatars. Fonts are resolved locally and are not redistributed.
The conversation and moving signals are illustrative, never live session data.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
W, H = 1200, 720
FRAMES, DURATION = 84, 100
BG = '#101514'
PANEL = '#141b19'
LINE = '#34433b'
INK = '#eee8d9'
MUTED = '#a7b0a0'
DIM = '#788677'
COPPER = '#e6a17e'
SAGE = '#b2c9a0'
GOLD = '#d8c191'
BLUE = '#a0b6bd'
AGENTS = [
    ('codex', 'BUILD', 'violet', COPPER, (82, 289), (254, 329)),
    ('claude', 'REVIEW', 'star', GOLD, (390, 289), (390, 329)),
    ('pi', 'EXPLORE', 'sprout', SAGE, (82, 449), (254, 489)),
    ('opencode', 'CONNECT', 'teal', BLUE, (390, 449), (390, 489)),
]
MESSAGES = [
    ('codex', 'I will build the foundation.', COPPER, 0.5),
    ('claude', 'I will review the details.', GOLD, 1.7),
    ('pi', 'I will connect the pieces.', SAGE, 2.9),
    ('opencode', 'Ready. Let us make it real.', BLUE, 4.1),
]


def font(size: int, family: str = 'mono', bold: bool = False):
    candidates = {
        'mono': [
            f'C:/Windows/Fonts/consola{"b" if bold else ""}.ttf',
            f'/usr/share/fonts/truetype/dejavu/DejaVuSansMono{"-Bold" if bold else ""}.ttf',
            '/System/Library/Fonts/Menlo.ttc',
        ],
        'serif': [
            'C:/Windows/Fonts/georgia.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
            '/System/Library/Fonts/Supplemental/Georgia.ttf',
        ],
        'sans': [
            'C:/Windows/Fonts/segoeuib.ttf' if bold else 'C:/Windows/Fonts/segoeui.ttf',
            f'/usr/share/fonts/truetype/dejavu/DejaVuSans{"-Bold" if bold else ""}.ttf',
            '/System/Library/Fonts/Helvetica.ttc',
        ],
    }
    for candidate in candidates[family]:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


FONTS = {
    'micro': font(12), 'small': font(14), 'label': font(15),
    'body': font(18), 'name': font(19, bold=True),
    'tagline': font(20, 'sans'), 'title': font(79, 'serif'),
    'at': font(47, 'mono'), 'prompt': font(22),
}


def text(draw, xy, value, kind='small', fill=MUTED, anchor=None):
    draw.text(xy, value, font=FONTS[kind], fill=fill, anchor=anchor,
              stroke_width=0)


def spaced(draw, xy, value, fill=DIM, spacing=2):
    x, y = xy
    for char in value:
        draw.text((x, y), char, font=FONTS['micro'], fill=fill)
        x += FONTS['micro'].getlength(char) + spacing


def corner(draw, x, y, dx=1, dy=1, color=LINE):
    draw.line([(x, y + dy * 10), (x, y), (x + dx * 10, y)], fill=color)


def ascii_avatar(avatar_id, color):
    """Small phosphor glyph portraits derived from the project's own avatars."""
    source = Image.open(ROOT / 'renderer/assets/avatars' / f'{avatar_id}.webp').convert('RGBA')
    source.thumbnail((14, 13), Image.Resampling.LANCZOS)
    result = Image.new('RGBA', (58, 57))
    draw = ImageDraw.Draw(result)
    glyph_font = font(7, bold=True)
    alpha = np.asarray(source.getchannel('A'))
    light = np.asarray(source.convert('L'))
    ramp = '.:+*#@'
    for y in range(source.height):
        for x in range(source.width):
            if alpha[y, x] > 100:
                glyph = ramp[min(5, int(light[y, x]) * 6 // 256)]
                draw.text((x * 4, y * 4), glyph, fill=color, font=glyph_font)
    return result


PORTRAITS = {avatar: ascii_avatar(avatar, color) for _, _, avatar, color, _, _ in AGENTS}


def make_base():
    image = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(image)
    # Quiet instrument casing, with a wide editorial title rather than a monitor replica.
    d.rounded_rectangle((18, 18, W - 19, H - 19), radius=26, outline='#3d493f', width=1)
    d.rounded_rectangle((24, 24, W - 25, H - 25), radius=22, outline='#1f2c24', width=1)
    d.line((58, 65, 1142, 65), fill=LINE)
    spaced(d, (62, 39), 'AR / LOCAL COORDINATION SYSTEM', fill=MUTED)
    text(d, (1139, 39), 'VOL. 01   /   OPEN SOURCE', 'micro', DIM, 'ra')

    text(d, (60, 76), 'Agent Room', 'title', INK)
    # A small floor-plan mark: four doors, one shared center.
    ox, oy = 1035, 114
    for x, y in [(ox, oy), (ox + 40, oy), (ox, oy + 40), (ox + 40, oy + 40)]:
        d.rounded_rectangle((x, y, x + 29, y + 29), radius=5, outline=COPPER, width=2)
    d.rectangle((ox + 23, oy + 23, ox + 46, oy + 46), fill=BG)
    text(d, (62, 177), 'Independent minds. A shared place to build.', 'tagline', MUTED)
    d.line((62, 222, 1138, 222), fill=LINE)

    spaced(d, (82, 245), '01 / THE ROOM')
    spaced(d, (642, 245), '02 / THE CONVERSATION')
    d.ellipse((548, 247, 555, 254), fill=SAGE)
    text(d, (1138, 244), 'ILLUSTRATIVE SEQUENCE', 'micro', DIM, 'ra')
    d.line((606, 244, 606, 548), fill=LINE)
    # Shared room: an opening on each wall connects to an independent CLI.
    d.rounded_rectangle((275, 352, 369, 466), radius=13, outline=LINE, width=1)
    for y in (366, 448):
        d.rectangle((273, y, 277, y + 8), fill=BG)
        d.rectangle((367, y, 371, y + 8), fill=BG)
    paths = []
    for index, (name, role, avatar, color, (x, y), (px, py)) in enumerate(AGENTS):
        d.rounded_rectangle((x, y, x + 172, y + 80), radius=11, fill=PANEL, outline=LINE)
        image.paste(PORTRAITS[avatar], (x + 8, y + 7), PORTRAITS[avatar])
        text(d, (x + 65, y + 19), name, 'name', color)
        text(d, (x + 65, y + 48), role, 'micro', DIM)
        target_x, target_y = (282 if index % 2 == 0 else 362), (375 if index < 2 else 439)
        path = [(px, py), (target_x, py), (target_x, target_y), (322, 409)]
        d.line(path, fill=LINE, width=1)
        paths.append(path)
    d.ellipse((290, 377, 354, 441), fill=PANEL, outline='#8b9e80', width=1)
    text(d, (322, 405), '@', 'at', INK, 'mm')
    text(d, (322, 555), 'ONE ROOM. MANY WAYS TO THINK.', 'micro', MUTED, 'ma')

    text(d, (642, 281), '~/workspace/agent-room', 'label', SAGE)
    text(d, (642, 316), 'you', 'name', INK)
    text(d, (706, 316), '@team, shape the next idea.', 'body', MUTED)
    d.line((642, 352, 1138, 352), fill='#27352b')
    for i in range(4):
        # Row rules establish readable space before the first keystroke arrives.
        y = 370 + i * 44
        text(d, (642, y), f'0{i + 1}', 'micro', DIM)

    d.line((62, 591, 1138, 591), fill=LINE)
    spaced(d, (82, 613), 'WORKSPACES / @MENTIONS / CUSTOM GATEWAYS', fill=MUTED, spacing=1)
    text(d, (82, 648), 'Your tools, in good company.', 'body', COPPER)
    text(d, (1138, 615), 'ELECTRON + HCOM', 'small', MUTED, 'ra')
    text(d, (1138, 651), '> enter the room', 'prompt', INK, 'ra')
    return image, paths


BASE, PATHS = make_base()
yy, xx = np.mgrid[0:H, 0:W]
vignette = np.clip(1 - 0.13 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2), 0.72, 1)
scanlines = np.where(yy % 3 == 0, 0.89, 1.0)
TEXTURE = (vignette * scanlines)[..., None]


def point_on_path(path, progress):
    lengths = [math.dist(a, b) for a, b in zip(path, path[1:])]
    distance = progress * sum(lengths)
    for (a, b), length in zip(zip(path, path[1:]), lengths):
        if distance <= length:
            ratio = distance / length
            return a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio
        distance -= length
    return path[-1]


def render(t, poster=False):
    image = BASE.copy()
    d = ImageDraw.Draw(image)
    glow = Image.new('RGB', (W, H))
    gd = ImageDraw.Draw(glow)
    # Signals travel to and from the shared room, without screen flashes or jitter.
    for i, (_, _, _, color, _, _) in enumerate(AGENTS):
        progress = (t / 2.8 - i * 0.23) % 1
        if int(t / 2.8) % 2:
            progress = 1 - progress
        px, py = point_on_path(PATHS[i], progress)
        d.ellipse((px - 2, py - 2, px + 2, py + 2), fill=color)
        gd.ellipse((px - 3, py - 3, px + 3, py + 3), fill=color)

    for i, (name, message, color, start) in enumerate(MESSAGES):
        y = 368 + i * 44
        text(d, (681, y), f'@{name}', 'name', color)
        elapsed = t - start
        characters = len(message) if poster else max(0, min(len(message), int(elapsed * 32)))
        if characters:
            visible = message[:characters]
            text(d, (800, y + 1), visible, 'body', INK)
            if characters < len(message):
                cursor_x = 800 + FONTS['body'].getlength(visible) + 2
                d.rectangle((cursor_x, y + 3, cursor_x + 7, y + 19), fill=color)
        elif elapsed > -0.5:
            for dot in range(3):
                alpha = '#6c7a67' if (int(t * 5) + dot) % 3 else color
                d.ellipse((801 + dot * 9, y + 10, 804 + dot * 9, y + 13), fill=alpha)

    # Copper registration marks and a slow terminal caret complete the instrument.
    for x, y, dx, dy in [(61, 235, 1, 1), (1139, 235, -1, 1), (61, 577, 1, -1), (1139, 577, -1, -1)]:
        corner(d, x, y, dx, dy)
    if poster or int(t * 1.4) % 2 == 0:
        d.rectangle((1143, 653, 1152, 674), fill=COPPER)

    # A fixed texture and one shared palette keep the animation calm and compact.
    image = ImageChops.add(image, glow.filter(ImageFilter.GaussianBlur(5)), scale=1.0)
    array = np.asarray(image, dtype=np.float32) * TEXTURE
    return Image.fromarray(np.clip(array, 0, 255).astype('uint8'))


def main():
    # Fail on overflow when a platform substitutes a different font.
    for name, message, _, _ in MESSAGES:
        if FONTS['name'].getlength('@' + name) > 115 or FONTS['body'].getlength(message) > 340:
            raise SystemExit('Resolved font does not fit the chat column; choose a narrower monospace font.')
    assets = ROOT / 'assets'
    assets.mkdir(exist_ok=True)
    poster = render(6.3, poster=True)
    poster.save(assets / 'agent-room-hero.png', optimize=True)
    palette = poster.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    frames = []
    for index in range(FRAMES):
        # Hold the fully readable composition for the last three seconds.
        frame = render(index * DURATION / 1000)
        frames.append(frame.quantize(palette=palette, dither=Image.Dither.NONE))
    frames[0].save(assets / 'agent-room-hero.gif', save_all=True, append_images=frames[1:],
                   loop=0, duration=DURATION, disposal=1, optimize=True)
    artifacts = ROOT / 'artifacts'
    artifacts.mkdir(exist_ok=True)
    sheet = Image.new('RGB', (1200, 720), BG)
    for cell, index in enumerate((0, 18, 42, 72)):
        frame = render(index * DURATION / 1000).resize((600, 360), Image.Resampling.LANCZOS)
        sheet.paste(frame, ((cell % 2) * 600, (cell // 2) * 360))
    sheet.save(artifacts / 'readme-hero-frames.png')
    with Image.open(assets / 'agent-room-hero.gif') as gif:
        duration = 0
        for index in range(gif.n_frames):
            gif.seek(index)
            gif.load()
            duration += gif.info['duration']
        print(f'{gif.n_frames} frames / {duration / 1000:.1f}s / {gif.width}x{gif.height}')
    print(f'GIF: {(assets / "agent-room-hero.gif").stat().st_size / 1024:.0f} KiB')


if __name__ == '__main__':
    main()
