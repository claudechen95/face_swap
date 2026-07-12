from __future__ import annotations

"""
Batch face+hair swap over every photo in target/ using the same recipe that
worked for origin.jpeg: face-detected head+hair mask + fal-ai/flux-lora/inpainting
with the trained LoRA at strength=0.55.
"""

import glob
import json
import os
import urllib.request

import face_fal
import facefusion_swap

SRC_DIR = "target"
OUT_DIR = "target_swapped"
LOG_PATH = "batch_swap_log.json"

# Optional final "blend/refine" pass over the fal LoRA output via FaceFusion's
# face_enhancer. Tested on 2 images with before/after sharpness measurement
# (face-region Laplacian variance) and it is NOT a reliable improvement: +29%
# on one (softer, indoor low-light original) but -38% on another (already
# sharp, daylight original) -- GFPGAN visibly over-smoothed the skin into a
# waxy look on the second. Default OFF; see face_swap_notes.md before
# flipping this on. When True, writes a second file alongside the unrefined
# one (suffix "_refined") so both are kept for comparison -- never overwrites
# the original. Requires the separate FaceFusion install (see README.md);
# silently skipped per-image if missing.
REFINE = False

os.makedirs(OUT_DIR, exist_ok=True)

lora_url = open("lora_url.txt").read().strip()
prompt = "sksperson, natural candid portrait photo, smiling, same lighting and framing"

image_paths = sorted(
    glob.glob(os.path.join(SRC_DIR, "*.jpg"))
    + glob.glob(os.path.join(SRC_DIR, "*.jpeg"))
    + glob.glob(os.path.join(SRC_DIR, "*.png"))
)

log = []
if os.path.exists(LOG_PATH):
    log = json.load(open(LOG_PATH))
done_names = {entry["name"] for entry in log if entry.get("status") == "ok"}

for path in image_paths:
    name = os.path.basename(path)
    if name in done_names:
        print(f"Skipping (already done): {name}")
        continue

    print(f"=== Processing {name} ===")
    entry = {"name": name}
    try:
        mask_path = os.path.join(OUT_DIR, os.path.splitext(name)[0] + "_mask.png")
        face_fal.build_head_hair_mask(path, mask_path=mask_path)

        urls = face_fal.face_swap_with_lora(
            image_path=path,
            mask_path=mask_path,
            lora_url=lora_url,
            prompt=prompt,
            lora_scale=1.0,
            strength=0.55,
            num_images=1,
        )
        result_url = urls[0]

        out_path = os.path.join(OUT_DIR, name)
        urllib.request.urlretrieve(result_url, out_path)

        entry["status"] = "ok"
        entry["result_url"] = result_url
        entry["out_path"] = out_path
        print(f"Saved -> {out_path}")

        if REFINE:
            stem, ext = os.path.splitext(name)
            refined_path = os.path.join(OUT_DIR, f"{stem}_refined{ext}")
            try:
                facefusion_swap.refine_face(out_path, refined_path)
                entry["refined_path"] = refined_path
                print(f"Refined -> {refined_path}")
            except Exception as e:
                entry["refine_error"] = repr(e)
                print(f"Refine skipped for {name}: {e!r}")
    except Exception as e:
        entry["status"] = "error"
        entry["error"] = repr(e)
        print(f"ERROR on {name}: {e!r}")

    log.append(entry)
    json.dump(log, open(LOG_PATH, "w"), indent=2)

print("Done. Log at", LOG_PATH)
