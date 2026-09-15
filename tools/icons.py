"""Generate the Windows brand assets for the fork: the app icon, the tile PNGs and the Inno Setup wizard
bitmaps, all drawn from one mark (the M in media/drydock.svg) on the Drydock Dark ink.

Run: python tools/icons.py   -> fork/icons/ (copied over vscode/resources/win32/ at build time)
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "fork", "icons")
INK = (0x16, 0x18, 0x1D, 255)
INK_DEEP = (0x0E, 0x10, 0x13, 255)
WHITE = (0xF3, 0xF4, 0xF6, 255)


def mark(size: int, bg=INK, fg=WHITE, pad=0.16, radius_ratio=0.22) -> Image.Image:
    """A rounded ink square with the M mark. Drawn at 4x and downsampled for clean edges."""
    s = size * 4
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * radius_ratio), fill=bg)
    # the M: viewBox 0..24, path M4 20 V5 l8 9 8-9 V20 -> points in a 24-unit box
    box = s * (1 - 2 * pad)
    off = s * pad
    pts = [(4, 20), (4, 5), (12, 14), (20, 5), (20, 20)]
    scaled = [(off + x / 24 * box, off + y / 24 * box) for x, y in pts]
    w = max(2, int(box * 2 / 24))
    d.line(scaled, fill=fg, width=w, joint="curve")
    for x, y in scaled:  # round caps
        d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=fg)
    return im.resize((size, size), Image.LANCZOS)


def wizard_big(scale: float) -> Image.Image:
    """Inno WizardImageFile: 164x314 at 100%. Ink field, mark near the top, nothing else."""
    w, h = round(164 * scale), round(314 * scale)
    im = Image.new("RGB", (w, h), INK_DEEP[:3])
    m = mark(round(72 * scale), bg=INK, radius_ratio=0.22)
    im.paste(m, ((w - m.width) // 2, round(40 * scale)), m)
    return im


def wizard_small(scale: float) -> Image.Image:
    """Inno WizardSmallImageFile: 55x58 at 100%."""
    w, h = round(55 * scale), round(58 * scale)
    im = Image.new("RGB", (w, h), INK_DEEP[:3])
    m = mark(round(44 * scale), bg=INK)
    im.paste(m, ((w - m.width) // 2, (h - m.height) // 2), m)
    return im


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    base = mark(256)
    base.save(os.path.join(OUT, "code.ico"), format="ICO", sizes=[(n, n) for n in sizes])
    mark(70, pad=0.2).save(os.path.join(OUT, "code_70x70.png"))
    mark(150, pad=0.2).save(os.path.join(OUT, "code_150x150.png"))
    for pct in (100, 125, 150, 175, 200, 225, 250):
        scale = pct / 100
        wizard_big(scale).save(os.path.join(OUT, f"inno-big-{pct}.bmp"))
        wizard_small(scale).save(os.path.join(OUT, f"inno-small-{pct}.bmp"))
    print("icons:", sorted(os.listdir(OUT)))
