"""Generate shared Pier artwork. See docs/branding.md for regeneration commands."""

import io
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import cairosvg
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "assets/brand/pier.svg"
MOBILE = ROOT / "apps/mobile/assets"
DESKTOP = ROOT / "apps/desktop"
SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)
# The mobile icons and the favicons show the mark the way the desktop app draws it on a light surface: no
# tile, and the light theme's --logo-* colors (apps/desktop/src/styles/tokens.css) in place of the source's
# white P. The last entry is the shade, which falls on white there instead of on the blue tile.
LIGHT_COLORS = {
    "#ffffff": "#62a2ff", "#e6eeff": "#2a60ee", "#6485e0": "#12297f", "#c9d8ff": "#2349cc",
    "#9af7e4": "#6ff0da", "#3fe0c5": "#1fc9b0", "#128a7a": "#0b6d60", "#3ccdb3": "#149c89",
    "#35d6bc": "#6ff0da", "#0a1c66": "#1b2f6b",
}
# The square of the 1024px canvas the desktop Logo component crops to (components/Icons.tsx).
MARK_BOX = "188 190 648 648"
SIDES = {"#p-side", "#cursor-side"}


def artwork(layer="all", monochrome=False, light=False, shade=True, scale=1, crop=False):
    svg = ET.fromstring(SOURCE.read_bytes())
    for child in list(svg):
        if child.get("id") in {"background", "mark"}:
            if layer != "all" and child.get("id") != layer:
                svg.remove(child)
            elif child.get("id") == "mark":
                if scale != 1:
                    child.set("transform", f"translate(512 512) scale({scale}) translate(-512 -512)")
                for part in list(child):
                    target, fill = part.get("href"), part.get("fill", "")
                    if part.get("id") == "shade":
                        if monochrome or not shade:
                            child.remove(part)
                    elif monochrome:
                        # Android tints a themed icon by its alpha alone: the faces stay solid, the walls
                        # are half as strong, and the prompt is a hole in the P.
                        if target == "#prompt" or (target in SIDES and fill.startswith("url(")):
                            child.remove(part)
                        else:
                            part.set("fill", "#ffffff")
                            if target in SIDES:
                                part.set("fill-opacity", ".5")
    if light:
        for element in svg.iter():
            for attribute in ("stop-color", "fill", "stroke"):
                if element.get(attribute) in LIGHT_COLORS:
                    element.set(attribute, LIGHT_COLORS[element.get(attribute)])
    if crop:
        svg.set("viewBox", MARK_BOX)
    return ET.tostring(svg)


def render(svg, size):
    # Supersampling keeps rounded strokes clean in launcher and favicon sizes.
    png = cairosvg.svg2png(bytestring=svg, output_width=size * 2, output_height=size * 2)
    return Image.open(io.BytesIO(png)).convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)


def tile(image, size, inset=0):
    """Continuous corners on a `size` canvas, `inset` px in from each edge."""
    scale = 4
    edge = (size - inset * 2) * scale
    radius = edge / 2
    points = []
    for i in range(4000):
        angle = 2 * math.pi * i / 4000
        cos, sin = math.cos(angle), math.sin(angle)
        points.append((
            radius + radius * math.copysign(abs(cos) ** (2 / 5), cos),
            radius + radius * math.copysign(abs(sin) ** (2 / 5), sin),
        ))
    mask = Image.new("L", (edge, edge), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    image = image.resize((edge, edge), Image.Resampling.LANCZOS)
    image.putalpha(mask)
    canvas = Image.new("RGBA", (size * scale, size * scale))
    canvas.alpha_composite(image, (inset * scale, inset * scale))
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def main():
    # iOS owns the launcher mask; its full-bleed source must have no alpha channel, so the mark sits on white.
    mobile = Image.new("RGBA", (1024, 1024), "white")
    mobile.alpha_composite(render(artwork("mark", light=True), 1024))
    mobile.convert("RGB").save(MOBILE / "icon.png")
    Image.new("RGB", (512, 512), "white").save(MOBILE / "android-icon-background.png")
    # Android's guaranteed safe area is a circle, not just a square: at 82% the whole solid mark fits
    # inside its central 66/108 safe zone, and only the faint edge of the shade reaches past it.
    render(artwork("mark", light=True, scale=0.82), 512).save(MOBILE / "android-icon-foreground.png")
    render(artwork("mark", monochrome=True, scale=0.82), 432).save(MOBILE / "android-icon-monochrome.png")
    tile(mobile, 1024, inset=44).save(MOBILE / "splash-icon.png")
    # The browser tabs use the bare mark without its shade, cropped as the desktop app shows it.
    bare = artwork("mark", light=True, shade=False, crop=True)
    render(bare, 48).save(MOBILE / "favicon.png")
    render(bare, 64).save(DESKTOP / "public/favicon.png")
    (DESKTOP / "public/logo.svg").write_bytes(SOURCE.read_bytes())
    # The desktop app icon is the source artwork as it is, on Apple's 824px grid of a 1024px canvas.
    tile(render(artwork(), 1024), 1024, inset=100).save(DESKTOP / "src-tauri/app-icon.png")
    print("Generated desktop, mobile, adaptive, themed, splash, and web artwork from assets/brand/pier.svg")


if __name__ == "__main__":
    main()
