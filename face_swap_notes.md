# Face swap on fal.ai — progress notes

## Folder layout (reorganized into `~/Desktop/face_swap/`)
- `face_fal.py`, `batch_swap.py` — active scripts (fal.ai pipeline)
- `face.py` — removed (unused, abandoned Ideogram-based training approach,
  superseded by `face_fal.py`'s fal.ai LoRA pipeline)
- `lora_url.txt`, `lora_training_result.json` — trained LoRA weights URL + metadata
- `trainingdata_cropped/` — 20 cropped training photos used for the LoRA
- `target/` — original 19 source photos to swap
- `target_swapped/` — batch results (+ per-image masks), same filenames as `target/`
- `batch_swap_log.json` — resumable log of the batch run

**Cleaned up (not useful for future sessions):** `archive/` (orphaned early
masks/results tied to the now-deleted `origin.jpeg`, plus 13MB of raw
duplicate-log dumps from debugging) and the 19 intermediate `*_mask.png`
files inside `target_swapped/` — both removed. `face.py` (unused Ideogram
approach) and `target.zip` were also removed/went missing — see git-less
history above for why, nothing here depends on them.

**Note:** `origin.jpeg` (the original single test photo) and several early
result files (`faceswap_fal_result.jpg/2/3/5/6`, `faceswap_result_negprompt.png`,
`faceswap_supir_result.png`, `target.zip`) went missing from Desktop between
sessions — removed outside of any of these scripts/commands. References to
them below are historical only; the files themselves are gone.

## Goal
Swap my face (+ hairstyle) into `origin.jpeg` (café photo of someone else),
keeping correct proportions/scale.

## Problem found
`face_fal.py`'s `face_swap_with_lora()` (fal-ai/flux-lora/inpainting, strength=0.85,
using a trained portrait LoRA) produced a face that was noticeably too big/zoomed-in
relative to the body (see `faceswap_fal_result6_tight.jpg` vs `origin.jpeg`).

Root cause: at high strength, inpainting regenerates the masked region from the
LoRA's learned prior (trained on tight face crops via `subject_crop: True`), so it
draws a "portrait-scale" face regardless of the scene's actual proportions. The
hand-drawn rectangular masks (`origin_mask*.png`) also weren't fitted to real face
geometry.

## Approaches tried

1. **`fal-ai/flux-lora/inpainting` + trained LoRA** (original approach)
   - Result: face too big. See `faceswap_fal_result*.jpg`.

2. **`fal-ai/face-swap` (direct/InsightFace-style swap, no LoRA)**
   - `face_swap_direct()` added to `face_fal.py`.
   - base_image = `origin.jpeg`, swap_image = `trainingdata_cropped/2025-07-19_19-59-53_158.jpg`
   - Result: **correct scale/proportions**, good identity match. Saved to
     `faceswap_direct_result.jpg`.
   - Limitation: only swaps inner face region (eyes/nose/mouth/jaw) — keeps the
     **original photo's hair**, not mine. Doesn't use the trained LoRA at all.

3. **`easel-ai/advanced-face-swap`** (`workflow_type: user_hair`, designed to swap
   face+hair together)
   - Docs mark it deprecated/"no longer supported" — verified this empirically:
     request `019f4d64-f133-7303-a34f-f836aba9910e` downloads both input images
     successfully then **never progresses past that step** (confirmed via
     deduped log polling over 140+ seconds — 0 new log lines after the first
     3.2s). Genuine server-side stall, not a logging artifact. Cancelled the
     request. **Confirmed dead, do not retry.**

## Current state

- Retrained the LoRA (previous training result was only printed to console last
  session and never saved — lost it). New LoRA trained on `trainingdata_cropped/`
  (20 photos), trigger phrase `sksperson`, 2500 steps.
  - **LoRA URL saved in `lora_url.txt`** (gitignored — not committed, it's a
    direct download link to your trained face model).
  - Full training result JSON: `lora_training_result.json` (gitignored)

## Result: SOLVED

Built a face+hair mask via RetinaFace detection on `origin.jpeg` (face box
[378,71,520,255]), expanded upward 1.4x and sideways 0.5x per side to cover
hair volume, saved as `origin_mask_hair.png` (elliptical, white=inpaint).

Ran `fal-ai/flux-lora/inpainting` with the retrained LoRA over that mask at
**strength=0.55** (down from 0.85), prompt: "sksperson, natural candid photo
at an outdoor cafe, smiling, same lighting and framing".

Result: **correct face scale/proportions AND actual hairstyle** (short,
side-parted, matching training photos) instead of the original photo's
tousled hair. Saved to `faceswap_hair_lora_result.jpg`.

Recipe that worked: face-detected mask covering head+hair (not hand-drawn) +
lower strength (0.55) + trained LoRA. High strength (0.85) was the main
cause of the oversized-face bug — it let the model regenerate from its
close-up-crop-trained prior instead of respecting the original scene's scale.

## Batch run over target/

Generalized the mask builder into `build_head_hair_mask()` in `face_fal.py`
(reads each image's own width/height via `Image.open(...).size` instead of
hardcoding 736x736 — confirmed the 19 photos in `target/` are all different
sizes/aspect ratios, from 618x789 up to 1200x1600).

`batch_swap.py` runs the full recipe (detect face -> head+hair mask -> LoRA
inpaint at strength=0.55) over every photo in `target/`, downloading each
result to `target_swapped/<same filename>`, and logs progress/URLs to
`batch_swap_log.json` (resumable — skips entries already marked "ok" if
rerun).

Result: **19/19 succeeded**, no errors. Spot-checked several (including the
smallest and largest/tallest) — correct scale, natural blend, hairstyle
matches across very different scenes/lighting/aspect ratios.

## Other notes
- Both `face_fal.py` and `face.py` have live API keys hardcoded in plaintext —
  should move to env vars at some point.
