"""Generate the Windows brand assets for the fork from fork/logo.png (the Maquoketa M, navy on black):
the app icon, the tile PNGs and the Inno Setup wizard bitmaps.

Run: python tools/icons.py   -> fork/icons/ (copied over vscode/resources/win32/ at build time)

The source is a flat navy mark on pure black, so alpha is recovered from the blue channel (the mark's
blue is 82 at full coverage): antialiased edges come out clean instead of carrying black fringes.
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "fork", "icons")
LOGO = os.path.join(HERE, "..", "fork", "logo.png")
NAVY = (7, 35, 82)
INK_DEEP = (0xF3, 0xF4, 0xF6)  # installer wizard plates: light, so the navy mark reads


def mark_rgba() -> Image.Image:
    """The mark alone, on transparency, cropped square with a little air around it."""
    src = Image.open(LOGO).convert("RGB")
    r, g, b = src.split()
    alpha = b.point(lambda v: min(255, int(v * 255 / NAVY[2])))
    flat = Image.new("RGB", src.size, NAVY)
    out = flat.copy(); out.putalpha(alpha)
    box = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
    out = out.crop(box)
    side = int(max(out.size) * 1.12)  # 6% air on each side
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(out, ((side - out.width) // 2, (side - out.height) // 2), out)
    return canvas


def on_ink(mark: Image.Image, size: tuple[int, int], mark_h: int, top: int | None = None) -> Image.Image:
    im = Image.new("RGB", size, INK_DEEP)
    m = mark.resize((int(mark.width * mark_h / mark.height), mark_h), Image.LANCZOS)
    y = (size[1] - m.height) // 2 if top is None else top
    im.paste(m, ((size[0] - m.width) // 2, y), m)
    return im


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    mark = mark_rgba()
    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    mark.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "code.ico"), format="ICO", sizes=[(n, n) for n in sizes])
    mark.resize((70, 70), Image.LANCZOS).save(os.path.join(OUT, "code_70x70.png"))
    mark.resize((150, 150), Image.LANCZOS).save(os.path.join(OUT, "code_150x150.png"))
    for pct in (100, 125, 150, 175, 200, 225, 250):
        s = pct / 100
        on_ink(mark, (round(164 * s), round(314 * s)), round(96 * s), top=round(40 * s)).save(os.path.join(OUT, f"inno-big-{pct}.bmp"))
        on_ink(mark, (round(55 * s), round(58 * s)), round(44 * s)).save(os.path.join(OUT, f"inno-small-{pct}.bmp"))
    mark.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "_preview-512.png"))
    print("icons:", sorted(f for f in os.listdir(OUT) if not f.startswith("_")))
