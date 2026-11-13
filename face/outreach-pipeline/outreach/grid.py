"""Before/after grid composite (SPEC.md 3.4): the lead's own photo plus their
face swapped onto each surviving target photo, labeled, consistent
face-centered crop, 1600px wide JPEG, small watermark."""

from __future__ import annotations

from pathlib import Path

import cv2
from PIL import Image, ImageDraw, ImageFont

from .generate import GenerateReport, _get_face_app, _largest_face
from .leads import Lead

GRID_WIDTH = 1600
PANEL_ASPECT = 4 / 5  # width:height
LABEL_HEIGHT = 56
PANEL_GAP = 4
MARGIN = 10
BG_COLOR = (20, 20, 20)
TEXT_COLOR = (255, 255, 255)
WATERMARK_TEXT = "faceswap.fit"
CROP_MARGIN = 0.9  # fraction of face box height added above/below for hair/shoulders

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]


def _load_font(size: int) -> ImageFont.ImageFont:
    for path in _FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def _face_crop_box(image_path: Path) -> tuple[int, int, int, int]:
    """Face-centered crop box, computed once from source.jpg by the caller and
    reused for every panel so before/after line up."""
    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError(f"could not read {image_path}")
    h, w = img.shape[:2]
    faces = _get_face_app().get(img)
    if not faces:
        raise ValueError(f"no face detected in {image_path} - grid requires a gated source.jpg")
    face = _largest_face(faces)
    x1, y1, x2, y2 = face.bbox
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    crop_h = (y2 - y1) * (1 + CROP_MARGIN)
    crop_w = crop_h * PANEL_ASPECT

    x1c = min(max(0, cx - crop_w / 2), w - crop_w) if crop_w <= w else 0
    y1c = min(max(0, cy - crop_h / 2), h - crop_h) if crop_h <= h else 0
    crop_w = min(crop_w, w)
    crop_h = min(crop_h, h)
    return (int(x1c), int(y1c), int(x1c + crop_w), int(y1c + crop_h))


def _panel(image_path: Path, panel_w: int, label: str) -> Image.Image:
    """Crops around this image's own detected face rather than reusing
    source.jpg's pixel box - Ideogram's output resolution doesn't always match
    the input's (observed 864x1152 out vs 3072x4096 in on the same photo), so
    a shared absolute-pixel box can land out of bounds on the smaller image."""
    panel_h = int(panel_w / PANEL_ASPECT)
    box = _face_crop_box(image_path)
    img = Image.open(image_path).convert("RGB").crop(box).resize((panel_w, panel_h), Image.LANCZOS)

    canvas = Image.new("RGB", (panel_w, panel_h + LABEL_HEIGHT), BG_COLOR)
    canvas.paste(img, (0, 0))
    draw = ImageDraw.Draw(canvas)
    font = _load_font(28)
    text_w = draw.textlength(label, font=font)
    draw.text(((panel_w - text_w) / 2, panel_h + (LABEL_HEIGHT - 28) / 2), label, fill=TEXT_COLOR, font=font)
    return canvas


def build_grid(lead: Lead, report: GenerateReport, targets_by_id: dict) -> Path:
    source_path = lead.work_dir / "source.jpg"
    if not source_path.exists():
        raise FileNotFoundError(f"{lead.slug}: no source.jpg")

    panels = [("Before", source_path)]
    for target_id, result in report.survived.items():
        panels.append((targets_by_id[target_id]["label"], result.path))

    n = len(panels)
    panel_w = (GRID_WIDTH - MARGIN * 2 - PANEL_GAP * (n - 1)) // n

    panel_images = [_panel(path, panel_w, label) for label, path in panels]
    panel_h = panel_images[0].height

    grid = Image.new("RGB", (GRID_WIDTH, panel_h + MARGIN * 2), BG_COLOR)
    x = MARGIN
    for img in panel_images:
        grid.paste(img, (x, MARGIN))
        x += img.width + PANEL_GAP

    draw = ImageDraw.Draw(grid)
    wm_font = _load_font(20)
    wm_w = draw.textlength(WATERMARK_TEXT, font=wm_font)
    draw.text(
        (GRID_WIDTH - wm_w - MARGIN - 6, grid.height - 26),
        WATERMARK_TEXT,
        fill=(255, 255, 255, 180),
        font=wm_font,
    )

    out_path = lead.work_dir / "grid.jpg"
    grid.save(out_path, "JPEG", quality=90)
    return out_path
