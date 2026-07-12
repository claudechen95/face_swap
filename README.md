# face_swap

Swap a person's face (and hairstyle) into other photos, using a FLUX LoRA
trained on fal.ai, plus a local FaceFusion pipeline for comparison. See
`face_swap_notes.md` for the full debugging story (why the naive approach
makes the face too big, how the working recipe was found, and how the two
pipelines compare in quality).

## What's here vs. what's not

Only code is checked in. Photos, the trained LoRA URL, and run logs are all
gitignored (see `.gitignore`) since they're personal — you'll generate your
own.

- `face_fal.py` — core functions (training, masking, swapping) via fal.ai
- `batch_swap.py` — batch-runs the fal.ai pipeline over a folder of photos
- `facefusion_swap.py` — wrapper around a local FaceFusion install, for
  comparison (identity-only swap, no cloud cost, see below)
- `face_swap_notes.md` — write-up of what was tried and why

## Setup

```bash
pip install fal-client retina-face opencv-python numpy pillow
export FAL_KEY="your-fal-ai-api-key"   # from https://fal.ai/dashboard/keys
```

Note: `retina-face` pulls in TensorFlow (used for face detection in
`build_head_hair_mask`) — it's a heavier install and first run will download
model weights via `gdown`.

`face_fal.py` will raise immediately on import if `FAL_KEY` isn't set.

## 1. Collect training photos

Put ~15-30 photos of the person's face in a folder (e.g. `trainingdata_cropped/`).
Varied angles/lighting/expressions helps. These are *not* included in the repo.

## 2. Train the LoRA

```python
import face_fal

result = face_fal.train_portrait_lora(
    photos_dir="trainingdata_cropped",
    trigger_phrase="sksperson",   # used in prompts later
    steps=2500,
)
lora_url = result["diffusers_lora_file"]["url"]

# Save it — this is the only place it's returned. Losing it means retraining.
open("lora_url.txt", "w").write(lora_url)
```

Training takes roughly 5-15 minutes depending on steps/photo count.

## 3. Swap into a photo

Two options, depending on whether you want the subject's real hairstyle:

**Face only (no LoRA, keeps the original photo's hair)** — a direct
InsightFace-style swap, correctly scaled automatically:

```python
url = face_fal.face_swap_direct("scene.jpg", "reference_face.jpg")
```

**Face + hairstyle (uses the trained LoRA)** — this is the recipe that
actually works well; see `face_swap_notes.md` for why the strength value
matters so much:

```python
lora_url = open("lora_url.txt").read().strip()

mask_path = face_fal.build_head_hair_mask("scene.jpg")  # auto-detects the face

urls = face_fal.face_swap_with_lora(
    image_path="scene.jpg",
    mask_path=mask_path,
    lora_url=lora_url,
    prompt="sksperson, natural candid portrait photo, smiling, same lighting and framing",
    strength=0.55,   # keep this around 0.5-0.6 — higher (e.g. the 0.85 default
                      # you might assume is fine) makes the face render at the
                      # LoRA's training-crop scale instead of the scene's scale
)
```

## 4. Batch process a folder

Put source photos in `target/`, then:

```bash
python batch_swap.py
```

Reads every image in `target/`, runs the face+hair recipe on each, and
writes results to `target_swapped/` (same filenames). Progress is logged to
`batch_swap_log.json` — rerunning skips photos already marked `"ok"`, so it's
safe to resume after an interruption or error.

`batch_swap.py` has a `REFINE` flag (default `False`) that, if enabled, runs
a FaceFusion sharpening pass on each result (writes `*_refined.jpeg`
alongside the original, never overwrites it). **Tested and found unreliable**
— it improves some photos and visibly over-smooths others into a waxy look.
Read the "Refine/enhance pass" section in `face_swap_notes.md` before turning
it on, and spot-check per image rather than trusting it blindly. Requires the
FaceFusion setup below.

## Alternative: FaceFusion (local, identity-only)

[FaceFusion](https://github.com/facefusion/facefusion) gives a free, local,
identity-only swap (like `face_swap_direct`, but generally higher fidelity
to the original photo's lighting/expression since it warps rather than
regenerates). It does **not** change hairstyle — same limitation as
`face_swap_direct`. See `face_swap_notes.md` for a full quality comparison.

Setup (macOS/Apple Silicon):

```bash
brew install git ffmpeg python@3.12
git clone https://github.com/facefusion/facefusion ../facefusion
cd ../facefusion
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python install.py --skip-conda default
```

Don't use `brew install miniconda` on Apple Silicon — it installs an x86_64
build, and recent `onnxruntime` no longer ships x86_64 macOS wheels. The
plain `venv` above uses a native arm64 Python instead.

Usage from this repo:

```bash
python facefusion_swap.py reference_face.jpg scene.jpg output.jpg

# Or just refine an already-swapped image (see the reliability caveat above):
python facefusion_swap.py - already_swapped.jpg refined.jpg --refine-only
```
