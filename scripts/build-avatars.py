"""Prepare the supplied characters for small avatars; keep source PNGs intact.

Usage: python scripts/build-avatars.py [directory containing the clipboard PNGs]
Pillow and numpy are needed only to rebuild the checked-in WebP assets.
"""
from pathlib import Path
import hashlib
import json
import shutil
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'assets' / 'avatar-sources'
OUTPUT = ROOT / 'renderer' / 'assets' / 'avatars'
CHARACTERS = [
    ('violet', 'ff521f1c-5778-41d4-b6cc-b6fc6407e23d', 'mint', 162, 1.0, 1.02),
    ('sprout', 'ea8f3c81-ea7e-47e3-a2fd-06e96f1f4f4d', 'aqua', 190, 0.85, 1.0),
    ('orange', '4be92897-e692-4aef-9475-526e4c715bc7', 'lavender', 263, 0.60, 0.95),
    ('star', '30e00292-a0a3-4c51-a047-ff87f69388c5', 'coral', 350, 0.70, 0.98),
    ('teal', '1798550d-5102-42a5-b2cd-7bae461eaaa6', 'indigo', 233, 0.80, 1.12),
    ('berry', '0e08a25a-7a2a-42f4-90ee-326942d3f3d5', 'jade', 155, 0.85, 1.75),
    ('cloud', '5cbd2c77-a048-47f7-9b65-1419a0961e94', 'lilac', 279, 0.80, 1.0),
    ('pink', '389ac003-c597-4384-a41c-8eb4c036492d', 'peach', 20, 0.70, 1.02),
]


def prepare(source):
    image = Image.open(source).convert('RGB')
    hsv = np.asarray(image.convert('HSV'))
    # The saturated body defines the crop, including the whole sprout / cloud.
    yy, xx = np.nonzero((hsv[:, :, 1] > 65) & (hsv[:, :, 2] > 80))
    left, top, right, bottom = int(xx.min()), int(yy.min()), int(xx.max()) + 1, int(yy.max()) + 1
    side = int(max(right - left, bottom - top) * 1.12)
    centre_x, centre_y = (left + right) / 2, (top + bottom) / 2
    # Remove only the exterior cream background; enclosed eyes stay untouched.
    exterior = Image.fromarray(((hsv[:, :, 1] < 50) & (hsv[:, :, 2] > 150)).astype('uint8') * 255).copy()
    ImageDraw.floodfill(exterior, (0, 0), 128)
    rgba = image.convert('RGBA')
    rgba.putalpha(Image.fromarray(np.where(np.asarray(exterior) == 128, 0, 255).astype('uint8')))
    canvas = Image.new('RGBA', (side, side))
    canvas.paste(rgba, (round(side / 2 - centre_x), round(side / 2 - centre_y)))
    return canvas.resize((256, 256), Image.Resampling.LANCZOS)


def recolour(image, hue, saturation, brightness):
    rgb = np.asarray(image.convert('RGB')).astype(float)
    hsv = np.asarray(image.convert('HSV')).astype(float).copy()
    # Preserve cream eyes, navy details and background; soften body edges.
    weight = (np.clip((hsv[:, :, 1] - 35) / 35, 0, 1)
              * np.clip((hsv[:, :, 2] - 65) / 35, 0, 1))[:, :, None]
    hsv[:, :, 0] = hue / 360 * 255
    hsv[:, :, 1] *= saturation
    hsv[:, :, 2] = np.clip(hsv[:, :, 2] * brightness, 0, 255)
    coloured = np.asarray(Image.fromarray(hsv.astype('uint8'), 'HSV').convert('RGB'))
    result = Image.fromarray(np.clip(rgb * (1 - weight) + coloured * weight, 0, 255).astype('uint8')).convert('RGBA')
    result.putalpha(image.getchannel('A'))
    return result


def main():
    SOURCES.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    incoming = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    provenance, cards = [], []
    for name, clipboard, variant, hue, sat, value in CHARACTERS:
        target = SOURCES / f'{name}.png'
        if not target.exists():
            if incoming is None:
                raise SystemExit(f'Missing {target}; provide the source-image directory.')
            shutil.copy2(incoming / f'codex-clipboard-{clipboard}.png', target)
        prepared = prepare(target)
        for avatar_id, image in [(name, prepared), (variant, recolour(prepared, hue, sat, value))]:
            image.save(OUTPUT / f'{avatar_id}.webp', quality=92, method=6)
            cards.append((avatar_id, image))
        provenance.append({'id': name, 'source': target.name,
                           'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'variant': variant})
    (SOURCES / 'sources.json').write_text(json.dumps(provenance, indent=2), encoding='utf-8')
    # A standalone overview also makes the crop and added colourways reviewable.
    sheet = Image.new('RGB', (960, 420), '#f8f6f0')
    draw = ImageDraw.Draw(sheet)
    for index, (name, card) in enumerate(cards):
        x, y = (index % 8) * 120, (index // 8) * 210
        thumb = card.resize((112, 112), Image.Resampling.LANCZOS)
        sheet.paste(thumb, (x + 4, y + 30), thumb)
        draw.text((x + 12, y + 156), name, fill='#45536a')
    artifacts = ROOT / 'artifacts'
    artifacts.mkdir(exist_ok=True)
    sheet.save(artifacts / 'avatar-library.png')
    print(f'Prepared {len(cards)} avatars from {len(provenance)} unique source images.')


if __name__ == '__main__':
    main()
