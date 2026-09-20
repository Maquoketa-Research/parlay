"""Generate Parlay's brand assets from build/parlay/logo.png (the spade, blue on transparency) straight into
the tree: the Windows app icon and tiles, the Inno Setup wizard bitmaps, the in-app title-bar icon (an SVG
wrapping a PNG), the two title-bar data URIs in style.css (light blue on dark themes, the logo's own blue on
light themes). Empty-editor letterpress assets use the clean vector in logo.svg.

Run: python build/parlay/icons.py
"""
from __future__ import annotations
import base64, io, os, re
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
LOGO = os.path.join(HERE, "logo.png")
WIN32 = os.path.join(ROOT, "resources", "win32")
MEDIA = os.path.join(ROOT, "src", "vs", "workbench", "browser", "media")
EDITOR_MEDIA = os.path.join(ROOT, "src", "vs", "workbench", "browser", "parts", "editor", "media")
STYLE = os.path.join(MEDIA, "style.css")

SKY = (0x8F, 0xB3, 0xF0)        # the mark on dark chrome
PLATE = (0xF3, 0xF4, 0xF6)      # installer wizard plates: light, so the blue reads


def mark_rgba() -> Image.Image:
    """The logo cropped to its alpha, squared, with 6% air on each side."""
    src = Image.open(LOGO).convert("RGBA")
    box = src.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    out = src.crop(box)
    side = int(max(out.size) * 1.12)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(out, ((side - out.width) // 2, (side - out.height) // 2), out)
    return canvas


def recolour(mark: Image.Image, rgb: tuple[int, int, int], alpha_scale: float = 1.0) -> Image.Image:
    """Same shape, one flat colour, alpha scaled."""
    a = mark.getchannel("A").point(lambda v: int(v * alpha_scale))
    out = Image.new("RGBA", mark.size, rgb + (0,))
    out.putalpha(a)
    return out


def png_b64(im: Image.Image, size: int) -> str:
    buf = io.BytesIO()
    im.resize((size, size), Image.LANCZOS).save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def svg_with_png(im: Image.Image, size: int) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {size} {size}" '
            f'width="{size}" height="{size}"><image width="{size}" height="{size}" xlink:href="data:image/png;base64,{png_b64(im, size)}"/></svg>\n')


def watermark_svg(rgb: tuple[int, int, int], alpha: float) -> str:
    """Use real paths so the empty-editor logo stays crisp at any display scale."""
    with open(os.path.join(HERE, "logo.svg"), encoding="utf-8") as source:
        svg = source.read()
    color = "#" + "".join(f"{channel:02x}" for channel in rgb)
    return svg.replace('<svg ', f'<svg opacity="{alpha}" ', 1).replace("#003880", color)


def on_plate(mark: Image.Image, size: tuple[int, int], mark_h: int, top: int | None = None) -> Image.Image:
    im = Image.new("RGB", size, PLATE)
    m = mark.resize((int(mark.width * mark_h / mark.height), mark_h), Image.LANCZOS)
    y = (size[1] - m.height) // 2 if top is None else top
    im.paste(m, ((size[0] - m.width) // 2, y), m)
    return im


def mac_icon(mark: Image.Image) -> Image.Image:
    """A blue app tile gives macOS a deliberate backing instead of its grey legacy-icon plate."""
    size = 1024
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", tile.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((64, 64, 960, 960), radius=196, fill=255)
    gradient = Image.new("RGBA", tile.size)
    draw = ImageDraw.Draw(gradient)
    top, bottom = (35, 109, 210), (9, 36, 85)
    for y in range(size):
        t = min(1, max(0, (y - 64) / 896))
        color = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
        draw.line((0, y, size, y), fill=color + (255,))
    tile.paste(gradient, (0, 0), mask)
    glyph = recolour(mark, (223, 238, 255)).resize((720, 720), Image.LANCZOS)
    tile.alpha_composite(glyph, (152, 152))
    return tile


def replace_data_uri_after(css: str, selector_start: str, b64: str) -> str:
    """Swap the base64 of the first background-image data URI after the rule that starts with selector_start."""
    i = css.index(selector_start)
    m = re.compile(r"url\(data:image/png;base64,[A-Za-z0-9+/=]+\)").search(css, i)
    return css[:m.start()] + f"url(data:image/png;base64,{b64})" + css[m.end():]


if __name__ == "__main__":
    mark = mark_rgba()
    sky = recolour(mark, SKY)

    # Windows: exe/installer icon and Store tiles
    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    mark.resize((256, 256), Image.LANCZOS).save(os.path.join(WIN32, "code.ico"), format="ICO", sizes=[(n, n) for n in sizes])
    mark.resize((70, 70), Image.LANCZOS).save(os.path.join(WIN32, "code_70x70.png"))
    mark.resize((150, 150), Image.LANCZOS).save(os.path.join(WIN32, "code_150x150.png"))
    # macOS: the app bundle icon (build/lib/electron.ts points at it); Pillow writes every icns size from this master
    mac_icon(mark).save(os.path.join(ROOT, "resources", "darwin", "code.icns"), format="ICNS")
    for pct in (100, 125, 150, 175, 200, 225, 250):
        s = pct / 100
        on_plate(mark, (round(164 * s), round(314 * s)), round(96 * s), top=round(40 * s)).save(os.path.join(WIN32, f"inno-big-{pct}.bmp"))
        on_plate(mark, (round(55 * s), round(58 * s)), round(44 * s)).save(os.path.join(WIN32, f"inno-small-{pct}.bmp"))

    # in-app icon (the workbench points at this file) and the title-bar data URIs
    open(os.path.join(MEDIA, "code-icon.svg"), "w", encoding="utf-8", newline="\n").write(svg_with_png(mark, 96))
    css = open(STYLE, encoding="utf-8", newline="").read()
    css = replace_data_uri_after(css, ".monaco-workbench.vs-dark .part.titlebar > .titlebar-container > .titlebar-left > .window-appicon", png_b64(sky, 64))
    css = replace_data_uri_after(css, ".monaco-workbench.vs .part.titlebar > .titlebar-container > .titlebar-left > .window-appicon", png_b64(mark, 64))
    open(STYLE, "w", encoding="utf-8", newline="").write(css)

    # Vector watermarks: do not downsample to a bitmap before Retina rendering.
    for name, rgb, alpha in [("letterpress-dark", SKY, 0.28), ("letterpress-hcDark", SKY, 0.6),
                             ("letterpress-light", (0x00, 0x38, 0x80), 0.18), ("letterpress-hcLight", (0x00, 0x38, 0x80), 0.6)]:
        with open(os.path.join(EDITOR_MEDIA, f"{name}.svg"), "w", encoding="utf-8", newline="\n") as output:
            output.write(watermark_svg(rgb, alpha))
