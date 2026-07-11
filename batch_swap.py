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

SRC_DIR = "target"
OUT_DIR = "target_swapped"
LOG_PATH = "batch_swap_log.json"

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
    except Exception as e:
        entry["status"] = "error"
        entry["error"] = repr(e)
        print(f"ERROR on {name}: {e!r}")

    log.append(entry)
    json.dump(log, open(LOG_PATH, "w"), indent=2)

print("Done. Log at", LOG_PATH)
