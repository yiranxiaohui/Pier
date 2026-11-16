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
# The app icons show the mark the way the desktop's navigation rail draws it: no tile, in the light
# theme's --logo-* colors (apps/desktop/src/styles/tokens.css) in place of the source's white ink.
SIDEBAR_COLORS = {"#ffffff": "#294775", "#dcf4f7": "#183047", "#a2f4e6": "#1fa392", "#4edcc5": "#0e7368"}
# The square of the 1024px canvas the desktop Logo component crops to (components/Icons.tsx).
MARK_BOX = "234 241 560 560"


def artwork(layer="all", monochrome=False, sidebar=False, scale=1, crop=False):
    svg = ET.fromstring(SOURCE.read_bytes())
    for child in list(svg):
        if child.get("id") in {"background", "mark"}:
            if layer != "all" and child.get("id") != layer:
                svg.remove(child)
            elif child.get("id") == "mark" and scale != 1:
                # Scale the entire mark while preserving its original forward lean.
                original_transform = child.get("transform", "")
                child.set("transform", f"translate(512 512) scale({scale}) translate(-512 -512) {original_transform}".strip())
    if sidebar:
        for stop in svg.iter(f"{{{SVG_NS}}}stop"):
            stop.set("stop-color", SIDEBAR_COLORS.get(stop.get("stop-color"), stop.get("stop-color")))
    if crop:
        svg.set("viewBox", MARK_BOX)
    if monochrome:
        for element in svg.iter():
            for attribute in ("fill", "stroke"):
                if element.get(attribute, "").startswith("url("):
                    element.set(attribute, "#ffffff")
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
    mobile.alpha_composite(render(artwork("mark", sidebar=True), 1024))
    mobile.convert("RGB").save(MOBILE / "icon.png")
    Image.new("RGB", (512, 512), "white").save(MOBILE / "android-icon-background.png")
    # Android's guaranteed safe area is a circle, not just a square: at 90% all mark pixels fit
    # inside its central 66/108 safe zone.
    render(artwork("mark", sidebar=True, scale=0.9), 512).save(MOBILE / "android-icon-foreground.png")
    render(artwork("mark", monochrome=True, scale=0.9), 432).save(MOBILE / "android-icon-monochrome.png")
    tile(mobile, 1024, inset=44).save(MOBILE / "splash-icon.png")
    # Desktop and the browser tabs use the bare mark, cropped as the navigation rail shows it.
    bare = artwork("mark", sidebar=True, crop=True)
    render(bare, 48).save(MOBILE / "favicon.png")
    render(bare, 64).save(DESKTOP / "public/favicon.png")
    (DESKTOP / "public/logo.svg").write_bytes(SOURCE.read_bytes())
    render(bare, 1024).save(DESKTOP / "src-tauri/app-icon.png")
    print("Generated desktop, mobile, adaptive, themed, splash, and web artwork from assets/brand/pier.svg")


if __name__ == "__main__":
    main()
