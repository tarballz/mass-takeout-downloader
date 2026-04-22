"""Generate placeholder icon PNGs for the extension.

Usage:
    uv run --with pillow python scripts/make_icons.py

Produces icons/icon16.png, icon48.png, icon128.png — a simple blue square with
a white download-arrow glyph. Replace with something nicer whenever you like.
"""

from pathlib import Path

from PIL import Image, ImageDraw


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (26, 115, 232, 255))
    d = ImageDraw.Draw(img)

    cx, cy = size / 2, size / 2
    arm = size * 0.28
    shaft_w = max(1, size // 10)

    # Vertical shaft of the arrow.
    d.rectangle(
        [cx - shaft_w, cy - arm, cx + shaft_w, cy + arm * 0.4],
        fill=(255, 255, 255, 255),
    )
    # Arrow head (triangle pointing down).
    head = size * 0.26
    d.polygon(
        [
            (cx - head, cy + arm * 0.1),
            (cx + head, cy + arm * 0.1),
            (cx, cy + arm * 0.9),
        ],
        fill=(255, 255, 255, 255),
    )
    # Tray under the arrow.
    tray_y = size * 0.82
    tray_h = max(1, size // 16)
    tray_w = size * 0.32
    d.rectangle(
        [cx - tray_w, tray_y, cx + tray_w, tray_y + tray_h],
        fill=(255, 255, 255, 255),
    )
    return img


def main() -> None:
    out_dir = Path(__file__).resolve().parent.parent / "icons"
    out_dir.mkdir(exist_ok=True)
    for size in (16, 48, 128):
        path = out_dir / f"icon{size}.png"
        draw_icon(size).save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
