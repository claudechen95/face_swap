---
name: run-pipeline-server
description: Start the local face-swap control panel UI (pipeline_server.py) that already has masking, character-reference upload, and the Ideogram engine wired up. Use when asked to start/open/run the pipeline server, the local UI, the stages page, or when about to do masking or character-reference editing by hand instead of through the existing UI.
---

`pipeline_server.py` is the already-built local HTTP control panel for this
project. It has, per photo: crop, upscale, mask painting, and Ideogram
character-reference swap stages, plus a global character-reference photo +
mask. Don't write new scripts or call the Ideogram/fal APIs by hand - this
UI already drives both.

## Start it

```
python3 pipeline_server.py --project "Label=images_dir[,out_dir]" --port 8765
```

- `--project` is repeatable - one dropdown entry per project.
- `images_dir` is where source photos live; `out_dir` (optional, defaults
  alongside `images_dir`) is where crops/masks/results get written.
- Default port is 8765. Check `lsof -i :8765` first; if occupied, either
  reuse that server or pick another `--port` (see this machine's dev-server
  cap guidance in global CLAUDE.md before spawning a second one).
- It opens the browser itself (`open http://127.0.0.1:<port>/`) and then
  blocks serving forever - always run it with `run_in_background: true`.
- Known local project/out-dir pair already used here: `target` ->
  `target_swapped`.

## What's already in the UI

- Per-photo mask painting for the face region to replace (stage 3 on the
  main page).
- Global character-reference photo upload + its own paint-mask canvas:
  `/upload-character-reference`, `/character-reference-mask` - "red = the
  character to extract, leave unpainted to use the whole photo."
- "Run Ideogram" button per row -> `/run/ideogram` -> `ideogram_character_swap`
  in `pipeline_server.py`, which POSTs both masks (inverted to Ideogram's
  black=selected convention) straight to `api.ideogram.ai`.
- Needs `IDEOGRAM_API_KEY` and `FAL_KEY` set in the environment.
