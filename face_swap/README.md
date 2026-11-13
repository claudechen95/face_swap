# face_swap

Swap a reference character's face into a photo using Ideogram's
character-reference inpainting, via a local web control panel
(`pipeline_server.py`).

## What's here vs. what's not

Only code is checked in.
Photos and generated results are gitignored (see `.gitignore`) since they're
personal — you'll generate your own.

- `pipeline_server.py` — the control panel: a local web UI showing every
  photo in a project as a row of stages (Crop, Upscale, Mask, Ideogram),
  each runnable and inspectable in place
- `face_fal.py` — face detection/selection, square-crop-on-face, and Topaz
  (fal.ai) upscaling helpers used by the Crop/Upscale stages

## Setup

```bash
pip install -r requirements.txt
```

Create a `.env` file (loaded automatically) with:

```
FAL_KEY=your-fal-ai-api-key          # from https://fal.ai/dashboard/keys
IDEOGRAM_API_KEY=your-ideogram-key   # from https://ideogram.ai/manage-api
```

`face_fal.py` raises immediately on import if `FAL_KEY` isn't set.
`IDEOGRAM_API_KEY` is only checked when you actually run the Ideogram stage.

Note: `retina-face` pulls in TensorFlow (used for face detection) — it's a
heavier install and first run will download model weights via `gdown`.

## Running it

```bash
python3 pipeline_server.py \
  --project "Label=~/Desktop/some-photos,~/Desktop/some-photos-out" \
  --port 8765
```

Opens a browser tab at `http://127.0.0.1:8765/`. Each `--project` flag adds
one entry to the project dropdown; `images_dir` is where source photos live,
`out_dir` (defaults to `images_dir` if omitted) is where every stage's
output gets written.

### Workflow per photo

1. **Crop** — square crop centred on the detected face.
2. **Upscale** — Topaz Wonder 3.5 upscale of the crop to an exact target
   size, so Ideogram's small output has real detail to blend into.
3. **Mask** — paint the region to regenerate (red = will be replaced).
4. **Ideogram** — set a global character-reference photo once (top bar),
   optionally paint a mask over just the character within it, then run.
   Each click produces a couple of attempts, upscaled and composited back
   onto the full-resolution base.

Delivered results are copied into `out_dir/delivered/` as `IMG_####.jpg`
with fabricated-but-plausible iPhone EXIF/GPS metadata, so client
deliverables look camera-native.
