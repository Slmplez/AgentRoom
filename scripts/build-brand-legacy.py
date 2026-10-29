"""Build Agent Room's original conversation mark and Windows icons with Pillow.

The same sampled geometry produces SVG and raster assets. No font or external
artwork is used. Run: python scripts/build-brand.py
"""
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "renderer" / "assets" / "brand"
NATIVE = ROOT / "assets" / "brand"
WEB.mkdir(parents=True, exist_ok=True)
NATIVE.mkdir(parents=True, exist_ok=True)

CLAY = "#c6613f"
PAPER = "#fff9f1"
STROKE = 2.8
# Two open conversation shapes face a shared space. The second is a half-turn
# of the first, keeping weight and negative space equal at small sizes.
UPPER = [(13.5, 4.5), (8.0, 4.5)] + [
    (8 + 4 * math.cos(math.radians(a)), 8.5 + 4 * math.sin(math.radians(a)))
    for a in range(270, 179, -3)
] + [(4.0, 15.5), (8.0, 12.3), (10.0, 12.3)]
SHAPES = [UPPER, [(24 - x, 24 - y) for x, y in UPPER]]


def paths(color):
    return "".join(
        f'<polyline points="{" ".join(f"{x:.4f},{y:.4f}" for x, y in shape)}" '
        f'fill="none" stroke="{color}" stroke-width="{STROKE}" '
        'stroke-linecap="round" stroke-linejoin="round"/>'
        for shape in SHAPES
    )


(WEB / "mark.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
    + paths(CLAY) + '</svg>\n', encoding="utf-8"
)
(WEB / "app.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
    f'<rect width="512" height="512" rx="116" fill="{CLAY}"/>'
    '<g transform="translate(76,76) scale(15)">'
    + paths(PAPER) + '</g></svg>\n', encoding="utf-8"
)


def draw_mark(image, origin, scale, color):
    draw = ImageDraw.Draw(image)
    width = max(1, round(STROKE * scale))
    radius = width / 2
    for shape in SHAPES:
        points = [(origin[0] + x * scale, origin[1] + y * scale) for x, y in shape]
        draw.line(points, fill=color, width=width, joint="curve")
        for x, y in points:
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)


def tile(size):
    # Supersampling keeps 16/20/24 px Windows representations crisp.
    oversample = 4
    side = size * oversample
    image = Image.new("RGBA", (side, side))
    ImageDraw.Draw(image).rounded_rectangle(
        (0, 0, side - 1, side - 1), radius=116 * side / 512, fill=CLAY
    )
    draw_mark(image, (76 * side / 512, 76 * side / 512), 15 * side / 512, PAPER)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def mark(size):
    image = Image.new("RGBA", (size * 4, size * 4))
    draw_mark(image, (0, 0), size * 4 / 24, CLAY)
    return image.resize((size, size), Image.Resampling.LANCZOS)


tile(512).save(NATIVE / "app.png")
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
tile(256).save(
    NATIVE / "app.ico", format="ICO", sizes=[(s, s) for s in sizes],
    append_images=[tile(s) for s in sizes if s != 256]
)
for size in [16, 24, 32, 48, 256]:
    tile(size).save(NATIVE / f"app-{size}.png")
mark(32).save(NATIVE / "tray.png")

# A compact presentation of the actual exported artwork, including small sizes.
board = Image.new("RGB", (960, 500), "#fcfcfb")
draw = ImageDraw.Draw(board)
draw.rounded_rectangle((32, 32, 928, 468), radius=20, outline="#e6e5e1", width=1)
large = tile(192)
board.paste(large, (80, 106), large)
small_mark = mark(72)
board.paste(small_mark, (365, 106), small_mark)
try:
    word_font = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 34)
    small_font = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 14)
except OSError:
    word_font = small_font = ImageFont.load_default()
draw.text((458, 122), "Agent Room", font=word_font, fill="#343430")
draw.line((366, 211, 868, 211), fill="#e6e5e1")
draw.text((366, 235), "ONE ROOM. MANY VOICES.", font=small_font, fill="#797872")
for size, x in [(16, 366), (24, 424), (32, 492), (48, 572), (64, 668)]:
    image = tile(size)
    board.paste(image, (x, 306 + (64 - size) // 2), image)
    draw.text((x, 390), f"{size} px", font=small_font, fill="#797872")
board.save(NATIVE / "brand-preview.png")
print(f"Brand assets built: {WEB} and {NATIVE}")
