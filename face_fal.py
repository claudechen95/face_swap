from __future__ import annotations

"""
Train a FLUX portrait LoRA on fal.ai from a folder of photos, then use it
for masked face-swap inpainting via fal-ai/flux-lora/inpainting.

Requires: pip install fal-client
"""

import os
import zipfile
import tempfile

import numpy as np
from PIL import Image
from retinaface import RetinaFace

import fal_client

if "FAL_KEY" not in os.environ:
    raise RuntimeError("Set the FAL_KEY environment variable before running this script.")


def _zip_photos(photos_dir: str) -> str:
    """Zip all images in photos_dir into a temp file. Returns the zip path."""
    photos_dir = os.path.expanduser(photos_dir)
    paths = sorted(
        p for p in os.listdir(photos_dir)
        if p.lower().endswith((".jpg", ".jpeg", ".png"))
    )
    fd, zip_path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    with zipfile.ZipFile(zip_path, "w") as zf:
        for name in paths:
            zf.write(os.path.join(photos_dir, name), arcname=name)
    print(f"Zipped {len(paths)} photos -> {zip_path}")
    return zip_path


def train_portrait_lora(
    photos_dir: str,
    trigger_phrase: str = "sksperson",
    steps: int = 2500,
    learning_rate: float = 0.0001,
) -> dict:
    """
    Upload photos_dir as a zip and train a FLUX portrait LoRA via
    fal-ai/flux-lora-portrait-trainer. Returns the training result dict,
    which includes diffusers_lora_file.url (the LoRA weights URL).
    """
    zip_path = _zip_photos(photos_dir)
    images_data_url = fal_client.upload_file(zip_path)
    print(f"Uploaded training zip: {images_data_url}")

    def on_queue_update(update):
        if isinstance(update, fal_client.InProgress):
            for log in update.logs:
                print(f"[train] {log['message']}")

    result = fal_client.subscribe(
        "fal-ai/flux-lora-portrait-trainer",
        arguments={
            "images_data_url": images_data_url,
            "trigger_phrase": trigger_phrase,
            "steps": steps,
            "learning_rate": learning_rate,
            "create_masks": True,
            "subject_crop": True,
        },
        with_logs=True,
        on_queue_update=on_queue_update,
    )
    print("Training result:", result)
    return result


def face_swap_direct(base_image_path: str, swap_image_path: str) -> str:
    """
    Direct (non-generative) face swap via fal-ai/face-swap. This warps the
    face from swap_image onto base_image's geometry/scale, instead of
    inpainting/regenerating -- avoids the "face too big" issue LoRA
    inpainting has, since it doesn't redraw the face from a learned prior.
    Returns the result image URL.
    """
    base_url = fal_client.upload_file(os.path.expanduser(base_image_path))
    swap_url = fal_client.upload_file(os.path.expanduser(swap_image_path))

    def on_queue_update(update):
        if isinstance(update, fal_client.InProgress):
            for log in update.logs:
                print(f"[swap] {log['message']}")

    result = fal_client.subscribe(
        "fal-ai/face-swap",
        arguments={
            "base_image_url": base_url,
            "swap_image_url": swap_url,
        },
        with_logs=True,
        on_queue_update=on_queue_update,
    )
    print("Swap result:", result)
    return result["image"]["url"]


def build_head_hair_mask(
    image_path: str,
    mask_path: str | None = None,
    top_pad_ratio: float = 1.4,
    side_pad_ratio: float = 0.5,
    bottom_pad_ratio: float = 0.15,
) -> str:
    """
    Detect the largest face in image_path (via RetinaFace) and write an
    elliptical mask PNG covering the face plus hair (extends well above and
    to the sides of the face box, since hair sits mostly outside a tight face
    box). White = region to inpaint, black = keep -- matches the convention
    fal-ai/flux-lora/inpainting expects. Saves next to image_path if
    mask_path is not given.
    """
    image_path = os.path.expanduser(image_path)
    faces = RetinaFace.detect_faces(image_path)
    if not isinstance(faces, dict) or not faces:
        raise ValueError(f"No face detected in {image_path}")
    best = max(
        faces.values(),
        key=lambda f: (f["facial_area"][2] - f["facial_area"][0])
        * (f["facial_area"][3] - f["facial_area"][1]),
    )
    x1, y1, x2, y2 = best["facial_area"]
    w, h = x2 - x1, y2 - y1

    with Image.open(image_path) as im:
        width, height = im.size

    nx1 = max(0, x1 - side_pad_ratio * w)
    nx2 = min(width, x2 + side_pad_ratio * w)
    ny1 = max(0, y1 - top_pad_ratio * h)
    ny2 = min(height, y2 + bottom_pad_ratio * h)

    mask = np.zeros((height, width), dtype=np.uint8)
    cx, cy = (nx1 + nx2) / 2, (ny1 + ny2) / 2
    ax, ay = (nx2 - nx1) / 2, (ny2 - ny1) / 2
    yy, xx = np.mgrid[0:height, 0:width]
    ellipse = (((xx - cx) / ax) ** 2 + ((yy - cy) / ay) ** 2) <= 1.0
    mask[ellipse] = 255

    if mask_path is None:
        base, _ = os.path.splitext(image_path)
        mask_path = f"{base}_mask.png"
    Image.fromarray(mask).save(mask_path)
    print(f"Saved head+hair mask: {mask_path} (region {(nx1, ny1, nx2, ny2)})")
    return mask_path


def face_swap_with_lora(
    image_path: str,
    mask_path: str,
    lora_url: str,
    prompt: str,
    lora_scale: float = 1.0,
    strength: float = 0.85,
    num_images: int = 1,
) -> list[str]:
    """
    Masked face-swap inpainting using a trained FLUX LoRA via
    fal-ai/flux-lora/inpainting. Returns a list of result image URLs.
    """
    image_url = fal_client.upload_file(os.path.expanduser(image_path))
    mask_url = fal_client.upload_file(os.path.expanduser(mask_path))

    def on_queue_update(update):
        if isinstance(update, fal_client.InProgress):
            for log in update.logs:
                print(f"[swap] {log['message']}")

    result = fal_client.subscribe(
        "fal-ai/flux-lora/inpainting",
        arguments={
            "image_url": image_url,
            "mask_url": mask_url,
            "prompt": prompt,
            "strength": strength,
            "num_images": num_images,
            "loras": [{"path": lora_url, "scale": lora_scale}],
        },
        with_logs=True,
        on_queue_update=on_queue_update,
    )
    print("Swap result:", result)
    return [img["url"] for img in result["images"]]
