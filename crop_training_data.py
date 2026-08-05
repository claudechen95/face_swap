from __future__ import annotations

"""
Crop a folder of photos into square, face-centered training crops matching
the framing used in trainingdata_cropped/ (face bbox height ~= 51.8% of the
crop's side length, face centered in the square). Measured by running
RetinaFace over trainingdata_cropped/ and averaging the ratio.

Usage: python3 crop_training_data.py <src_dir> <dst_dir>
"""

import os
import sys

import numpy as np
from PIL import Image, ImageOps
from retinaface import RetinaFace

TARGET_FACE_RATIO = 0.518  # face bbox height / crop side, matched from trainingdata_cropped
MIN_CROP_SIDE_WARN = 400   # flag crops smaller than this -- likely too low-res to be useful


def load_rgb(path: str) -> Image.Image:
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    return im.convert("RGB")


def detect_largest_face(im_rgb: Image.Image):
    arr_bgr = np.array(im_rgb)[:, :, ::-1]
    faces = RetinaFace.detect_faces(arr_bgr)
    if not isinstance(faces, dict) or not faces:
        return None
    best = max(
        faces.values(),
        key=lambda f: (f["facial_area"][2] - f["facial_area"][0])
        * (f["facial_area"][3] - f["facial_area"][1]),
    )
    return best["facial_area"]  # [x1, y1, x2, y2]


def crop_square(im_rgb: Image.Image, facial_area) -> Image.Image:
    W, H = im_rgb.size
    x1, y1, x2, y2 = facial_area
    fh = y2 - y1
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2

    side = fh / TARGET_FACE_RATIO
    side = min(side, W, H)  # clamp if the ideal crop wouldn't fit

    left = max(0, min(cx - side / 2, W - side))
    top = max(0, min(cy - side / 2, H - side))

    box = (round(left), round(top), round(left + side), round(top + side))
    return im_rgb.crop(box)


def crop_folder(src_dir: str, dst_dir: str) -> dict:
    """
    Crop every photo in src_dir into dst_dir (see module docstring for the
    framing convention). Returns {"ok": [...], "failures": [...], "small": [...]}
    so callers (CLI or in-process, e.g. the automated pipeline) can act on
    partial results instead of relying on stdout.
    """
    os.makedirs(dst_dir, exist_ok=True)
    files = sorted(
        f for f in os.listdir(src_dir)
        if f.lower().endswith((".jpg", ".jpeg", ".png"))
    )

    ok = []
    failures = []
    small = []
    for name in files:
        src_path = os.path.join(src_dir, name)
        im = load_rgb(src_path)
        facial_area = detect_largest_face(im)
        if facial_area is None:
            print(f"SKIP (no face): {name}")
            failures.append(name)
            continue

        cropped = crop_square(im, facial_area)
        base, _ = os.path.splitext(name)
        dst_path = os.path.join(dst_dir, f"{base}.jpg")
        cropped.save(dst_path, quality=95)
        ok.append(name)

        side = cropped.size[0]
        flag = " (LOW RES)" if side < MIN_CROP_SIDE_WARN else ""
        if flag:
            small.append(name)
        print(f"OK: {name} -> {dst_path} ({side}x{side}){flag}")

    print(f"\n{len(files) - len(failures)}/{len(files)} cropped -> {dst_dir}")
    if failures:
        print(f"No face detected, needs manual cropping: {failures}")
    if small:
        print(f"Low-res crops (<{MIN_CROP_SIDE_WARN}px), consider dropping: {small}")

    return {"ok": ok, "failures": failures, "small": small}


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <src_dir> <dst_dir>")
        sys.exit(1)
    crop_folder(sys.argv[1], sys.argv[2])


if __name__ == "__main__":
    main()
