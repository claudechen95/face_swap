from __future__ import annotations

"""
fal.ai helpers used by pipeline_server.py's Ideogram character-swap stages:
face detection/selection, square-crop-on-face, Topaz upscaling, and an
auto-mask built from MediaPipe segmentation (see mediapipe_segment.py).

Requires: pip install fal-client
"""

import os
import subprocess
import sys
import tempfile

import cv2
import numpy as np
from PIL import Image, ImageFilter

import fal_client

if "FAL_KEY" not in os.environ:
    raise RuntimeError("Set the FAL_KEY environment variable before running this script.")


# Faces smaller than this fraction of the largest face's area are treated as
# background bystanders (a stranger walking past behind the subject), not as
# people in the photo. Without this, "the person in the middle" can resolve to
# someone who happens to stand near the frame's centre line but is 20x further
# from the camera than the actual subjects.
BYSTANDER_AREA_RATIO = 0.25


def _detect_faces(image_path: str) -> list[dict]:
    # Imported lazily so importing this module doesn't eagerly pull in
    # RetinaFace/TensorFlow for code paths that never call this function.
    from retinaface import RetinaFace

    faces = RetinaFace.detect_faces(image_path)
    if not isinstance(faces, dict) or not faces:
        raise ValueError(f"No face detected in {image_path}")
    return list(faces.values())


def _face_area(face: dict) -> float:
    x1, y1, x2, y2 = face["facial_area"]
    return (x2 - x1) * (y2 - y1)


def select_face(faces: list[dict], image_width: int, select: str | int = "largest") -> dict:
    """
    Pick which detected face to swap.

    select="largest"  -- biggest face box (the default).
    select="center"   -- the person in the middle: the face whose box centre
                         is horizontally nearest the frame's centre line.
    select=<int>      -- index into the faces ordered left-to-right, so 0 is
                         the leftmost person and -1 the rightmost. Use this
                         when "middle" is undefined (e.g. a two-person photo).

    Background bystanders are dropped first (see BYSTANDER_AREA_RATIO), so
    indexes and "center" both range over the actual subjects of the photo.
    """
    largest_area = max(_face_area(f) for f in faces)
    subjects = [f for f in faces if _face_area(f) >= BYSTANDER_AREA_RATIO * largest_area]

    if select == "largest":
        return max(subjects, key=_face_area)

    ordered = sorted(subjects, key=lambda f: f["facial_area"][0] + f["facial_area"][2])
    if select == "center":
        frame_cx = image_width / 2
        return min(ordered, key=lambda f: abs((f["facial_area"][0] + f["facial_area"][2]) / 2 - frame_cx))
    if isinstance(select, int):
        return ordered[select]
    raise ValueError(f"Unknown face selector: {select!r}")


def suggest_square_crop_box(
    image_path: str,
    select: str | int = "largest",
    head_bias: float = 0.15,
) -> dict:
    """
    Compute (without cropping) the largest square that fits inside
    image_path, centred on the chosen face rather than the frame's
    geometric centre -- so a portrait/landscape photo can go square without
    cutting the subject's face off to one side. Returns
    {left, top, side, width, height} in source-image pixels, e.g. for an
    interactive crop tool to show as a starting selection the user can then
    drag/resize (see pipeline_server.py's crop view) before actually
    cropping with crop_box.

    head_bias shifts the box up from dead-centre-on-face by this fraction
    of its side, as a fixed square centred exactly on the face tends to
    crowd out hair and leave extra empty space below the chin (portrait
    convention puts the face in the upper-middle third, not the centre).
    0 = centred on the face, positive = more headroom.

    The side is min(width, height) -- the most that can be taken without
    needing to pad -- so a crop using this box only ever removes content,
    never adds any; see upscale_to_size for reaching an exact final
    resolution after.
    """
    image_path = os.path.expanduser(image_path)
    faces = _detect_faces(image_path)

    with Image.open(image_path) as im:
        width, height = im.size
    best = select_face(faces, width, select)
    x1, y1, x2, y2 = best["facial_area"]
    face_cx, face_cy = (x1 + x2) / 2, (y1 + y2) / 2

    side = min(width, height)
    left = face_cx - side / 2
    top = face_cy - side / 2 - head_bias * side
    left = max(0, min(left, width - side))
    top = max(0, min(top, height - side))
    return {"left": int(left), "top": int(top), "side": int(side), "width": width, "height": height}


def crop_box(image_path: str, left: int, top: int, side: int) -> "Image.Image":
    """Crop image_path to the exact (left, top, left+side, top+side) box."""
    with Image.open(os.path.expanduser(image_path)) as im:
        return im.crop((left, top, left + side, top + side))


def crop_to_square_on_face(
    image_path: str,
    select: str | int = "largest",
    head_bias: float = 0.15,
) -> "Image.Image":
    """Convenience wrapper: suggest_square_crop_box + crop_box in one call."""
    box = suggest_square_crop_box(image_path, select=select, head_bias=head_bias)
    return crop_box(image_path, box["left"], box["top"], box["side"])


_SEGMENT_SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mediapipe_segment.py")


def build_head_hair_mask(
    image_path: str,
    select: str | int = "largest",
    pad_ratio: float = 0.12,
    feather_ratio: float = 0.04,
) -> "Image.Image":
    """
    Pixel-accurate face+hair mask via MediaPipe's selfie_multiclass
    segmenter, run in a one-shot subprocess (see mediapipe_segment.py's
    docstring for why -- importing mediapipe into this process would
    corrupt TensorFlow's state before RetinaFace, used below, ever gets a
    chance to build its model). White = region to inpaint, black = keep,
    matching this project's _3mask.png convention. A starting point for the
    Mask stage's "Auto mask" button, not a final answer -- the paint canvas
    loads it pre-filled so it can be touched up by hand rather than painted
    from scratch.

    The raw segmentation silhouette is exact to this person's actual
    hair/face pixels, which is too tight to swap into: a reference
    character with a different hairline/hair volume needs room to render
    into, not just the original person's exact outline. pad_ratio dilates
    the silhouette outward by that fraction of face height (via an
    elliptical kernel, so it grows evenly in every direction) before
    feathering, same resolution-independent-ratio convention as the rest of
    this module.

    The segmenter has no notion of "which person" -- on a multi-person
    photo it marks everyone's hair+face. Isolate just the one `select`
    picks (see select_face) by taking its connected component: RetinaFace
    picks the face, then whichever segmentation blob contains that face's
    centre (or, if the centre itself landed on a gap -- stray hair, glasses
    glare -- whichever blob has the most overlap with the face box) is kept
    and everything else is discarded.
    """
    image_path = os.path.expanduser(image_path)
    faces = _detect_faces(image_path)

    with Image.open(image_path) as im:
        width, height = im.size
    best = select_face(faces, width, select)
    x1, y1, x2, y2 = (int(v) for v in best["facial_area"])

    fd, raw_mask_path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        result = subprocess.run(
            [sys.executable, _SEGMENT_SCRIPT_PATH, image_path, raw_mask_path],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"mediapipe segmentation failed: {result.stderr.strip()}")
        raw_mask = np.array(Image.open(raw_mask_path).convert("L"))
    finally:
        os.remove(raw_mask_path)

    num_labels, labels = cv2.connectedComponents((raw_mask > 0).astype(np.uint8))
    fx, fy = (x1 + x2) // 2, (y1 + y2) // 2
    target_label = labels[fy, fx]
    if target_label == 0:
        box_labels = labels[y1:y2, x1:x2]
        candidates = box_labels[box_labels != 0]
        target_label = int(np.bincount(candidates).argmax()) if candidates.size else 0
    if target_label == 0:
        raise ValueError(f"No hair/face segmentation found near the selected face in {image_path}")

    isolated = (labels == target_label).astype(np.uint8) * 255
    pad_px = round(pad_ratio * (y2 - y1))
    if pad_px:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * pad_px + 1, 2 * pad_px + 1))
        isolated = cv2.dilate(isolated, kernel)

    mask_img = Image.fromarray(isolated)
    feather_px = feather_ratio * (y2 - y1)
    if feather_px:
        mask_img = mask_img.filter(ImageFilter.GaussianBlur(feather_px))
    return mask_img


def upscale_image(
    image_path: str,
    scale: float = 2.0,
    face: bool = True,
) -> str:
    """
    Upscale image_path by exactly `scale`x via topaz/upscale/image/generative's
    Wonder 3.5 model (Topaz Labs). Returns the result image URL.

    Was fal-ai/topaz/upscale/image/precision's Standard V2 (non-generative),
    itself a replacement for fal-ai/esrgan, itself a replacement for
    fal-ai/ideogram/upscale (that model normalized output toward a roughly
    fixed ~1-megapixel budget regardless of input size rather than applying
    a real multiplier).

    Generative vs. non-generative is a real tradeoff, not a strict upgrade:
    Wonder 3.5 invents plausible detail that was not in the source (confirmed
    side by side against Standard V2 -- visibly sharper skin/hair/fabric
    texture, but Standard V2 left measurable grain-like noise in flat
    background regions that Wonder 3.5 did not). This function is used for
    enlarging a *target photo before* masking and swapping (see
    upscale_to_size), so that invented detail lands on real, unreplaced
    regions of a real user's photo -- clothing, background, hands -- not just
    on the face that gets overwritten anyway. That is a deliberate,
    explicitly-chosen tradeoff (favoring sharper detail over strict fidelity
    to the source pixels), not an oversight; reconsider if it causes visible
    drift in non-face regions on real photos.

    face=True turns on the model's face-region enhancement pass, which is
    what we want when the point of upscaling is to give a face more pixels.

    image_path may also be a URL (a previous fal result) instead of a local
    path -- see upscale_to_size, which chains calls through this for a
    total scale beyond the endpoint's own cap.
    """
    if image_path.startswith(("http://", "https://")):
        image_url = image_path
    else:
        image_url = fal_client.upload_file(os.path.expanduser(image_path))

    def on_queue_update(update):
        if isinstance(update, fal_client.InProgress):
            for log in update.logs:
                print(f"[upscale] {log['message']}")

    result = fal_client.subscribe(
        "topaz/upscale/image/generative",
        arguments={
            "image_url": image_url,
            "model": "Wonder 3.5",
            "upscale_factor": scale,
            "output_format": "png",
            "face_enhancement": face,
        },
        with_logs=True,
        on_queue_update=on_queue_update,
    )
    return result["image"]["url"] if "image" in result else result["images"][0]["url"]


# fal's schema caps upscale_factor at 4 on this endpoint. upscale_to_size
# chains calls through this cap instead of raising.
MAX_TOPAZ_SCALE = 4.0


def upscale_to_size(image_path: str, target: int, face: bool = True) -> str:
    """
    Like upscale_image, but takes an exact target side length (the image
    must already be square) instead of a multiplier, and transparently
    chains multiple Topaz upscale calls -- feeding each result's URL
    straight into the next, no local download in between -- when the needed
    multiplier exceeds MAX_TOPAZ_SCALE. Topaz's own rounding can still leave
    the final result a handful of pixels off `target`; the caller should do
    one final PIL resize to (target, target) on the downloaded result if an
    exact size matters (e.g. a print or platform spec). Returns the result
    image URL.
    """
    with Image.open(os.path.expanduser(image_path)) as im:
        width, height = im.size
    if width != height:
        raise ValueError(f"upscale_to_size expects a square input, got {width}x{height}")

    remaining = target / width
    current = image_path
    while remaining > 1.0 + 1e-6:
        step = min(remaining, MAX_TOPAZ_SCALE)
        current = upscale_image(current, scale=step, face=face)
        remaining /= step
    return current
