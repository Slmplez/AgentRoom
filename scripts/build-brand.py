"""Export user-supplied product images, preserving the original source files.

These are raster exports, not vector reconstructions.
Run: python scripts/build-brand.py
"""
from pathlib import Path
import shutil
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / 'assets' / 'brand'
WEB = ROOT / 'renderer' / 'assets' / 'brand'
WEB.mkdir(parents=True, exist_ok=True)
NAVY = (24, 43, 69)
CREAM = (255, 249, 237)


def color_art():
    image = Image.open(NATIVE / 'sources' / 'color-original.png').convert('RGB')
    rgb = np.asarray(image).astype(np.int16)
    # Remove only neutral paper connected to the exterior. Enclosed white
    # eyes and lamp retain their source pixels.
    neutral = (rgb.min(axis=2) > 225) & (rgb.max(axis=2) - rgb.min(axis=2) < 28)
    flood = Image.fromarray(np.uint8(neutral) * 255).copy()
    ImageDraw.floodfill(flood, (0, 0), 128)
    outside = np.asarray(flood) == 128
    alpha = np.where(outside, 0, 255).astype(np.uint8)
    edge = np.asarray(Image.fromarray(np.uint8(outside) * 255).filter(ImageFilter.MaxFilter(3))) > 0
    coverage = np.clip((255 - rgb.min(axis=2)) / 40, 0, 1)
    alpha[edge & ~outside] = np.uint8(coverage[edge & ~outside] * 255)
    result = image.convert('RGBA'); result.putalpha(Image.fromarray(alpha))
    return result.crop(result.getbbox())


def monochrome_art(color):
    image = Image.open(NATIVE / 'sources' / 'lockup-original.png').convert('RGB')
    dark = 255 - np.asarray(image).min(axis=2).astype(np.float32)
    coverage = np.clip((dark - 16) / (231 - 16), 0, 1)
    result = Image.new('RGBA', image.size, color)
    result.putalpha(Image.fromarray(np.uint8(coverage * 255)))
    return result.crop(result.getbbox())


def contained(image, size, padding=.04):
    target = Image.new('RGBA', (size, size))
    artwork = image.copy()
    artwork.thumbnail((round(size * (1 - 2 * padding)),) * 2, Image.Resampling.LANCZOS)
    target.alpha_composite(artwork, ((size - artwork.width) // 2, (size - artwork.height) // 2))
    return target


color = color_art()
navy = monochrome_art(NAVY)
light = monochrome_art(CREAM)
contained(color, 768).save(WEB / 'mark.png')
contained(color, 512).save(NATIVE / 'app.png')
shutil.copyfile(NATIVE / 'app.png', WEB / 'app.png')
navy.save(WEB / 'lockup-navy.png')
light.save(WEB / 'lockup-light.png')
# Color remains visible against both light and dark Windows taskbars.
contained(color, 32).save(NATIVE / 'tray.png')
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
contained(color, 256).save(NATIVE / 'app.ico', sizes=[(s, s) for s in sizes])
for size in [16, 24, 32, 48, 256]:
    contained(color, size).save(NATIVE / f'app-{size}.png')

board = Image.new('RGB', (1200, 680), '#f9f9f6')
draw = ImageDraw.Draw(board)
try:
    title = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 25)
    small = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 16)
except OSError:
    title = small = ImageFont.load_default()
draw.text((42, 28), 'Agent Room / Product identity', font=title, fill=NAVY)
draw.rounded_rectangle((34, 88, 572, 570), radius=22, fill='#ffffff')
draw.rounded_rectangle((594, 88, 1166, 570), radius=22, fill='#182b45')
big = contained(color, 332)
board.paste(big, (138, 122), big)
lockup = light.copy(); lockup.thumbnail((350, 350), Image.Resampling.LANCZOS)
board.paste(lockup, (880 - lockup.width // 2, 150), lockup)
draw.text((62, 514), 'Color / App icon', font=small, fill=NAVY)
draw.text((622, 514), 'Monochrome / Dark surface', font=small, fill=CREAM)
for size, x in [(16, 50), (24, 124), (32, 208), (48, 302), (64, 412)]:
    icon = contained(color, size)
    board.paste(icon, (x, 592 + (64 - size) // 2), icon)
    draw.text((x + size + 8, 612), str(size), font=small, fill=NAVY)
board.save(NATIVE / 'brand-preview.png')
print(f'Brand exports ready: {WEB} and {NATIVE}')
print(f'Color artwork: {color.size}; lockup: {navy.size}')
