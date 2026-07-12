from __future__ import annotations

"""
Wrapper around a local FaceFusion checkout for face-only swapping (identity,
no hairstyle change -- FaceFusion's face_swapper only touches the inner face
region, same limitation as fal-ai/face-swap in face_fal.py).

Assumes FaceFusion is installed separately, e.g. as a sibling checkout:
    git clone https://github.com/facefusion/facefusion ../facefusion
    cd ../facefusion && python3.12 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt && python install.py --skip-conda default

See face_swap_notes.md for the comparison against the fal.ai pipeline.
"""

import argparse
import subprocess
import sys
from pathlib import Path

FACEFUSION_DIR = Path(__file__).resolve().parent.parent / "facefusion"


def _run_headless(source_path: str | None, target_path: str, output_path: str, extra_args: list[str]) -> None:
    venv_python = FACEFUSION_DIR / ".venv" / "bin" / "python"
    if not venv_python.exists():
        raise RuntimeError(
            f"FaceFusion venv not found at {venv_python}. "
            "Set it up first -- see the module docstring."
        )

    cmd = [str(venv_python), "facefusion.py", "headless-run"]
    if source_path is not None:
        cmd += ["-s", str(Path(source_path).resolve())]
    cmd += [
        "-t", str(Path(target_path).resolve()),
        "-o", str(Path(output_path).resolve()),
        "--execution-providers", "coreml",
        "--log-level", "info",
        *extra_args,
    ]
    subprocess.run(cmd, cwd=FACEFUSION_DIR, check=True)


def face_swap_facefusion(
    source_path: str,
    target_path: str,
    output_path: str,
    face_swapper_model: str = "inswapper_128_fp16",
    pixel_boost: str = "512x512",
    enhance: bool = True,
    face_enhancer_model: str = "gfpgan_1.4",
    face_enhancer_blend: int = 60,
) -> None:
    """Identity-only face swap (no hairstyle change) via FaceFusion's face_swapper."""
    # --processors takes all following tokens until the next flag, so
    # face_enhancer must be appended right after face_swapper, not as its own flag.
    extra_args = [
        "--processors", "face_swapper", *(["face_enhancer"] if enhance else []),
        "--face-swapper-model", face_swapper_model,
        "--face-swapper-pixel-boost", pixel_boost,
    ]
    if enhance:
        extra_args += [
            "--face-enhancer-model", face_enhancer_model,
            "--face-enhancer-blend", str(face_enhancer_blend),
        ]
    _run_headless(source_path, target_path, output_path, extra_args)


def refine_face(
    image_path: str,
    output_path: str,
    face_enhancer_model: str = "gfpgan_1.4",
    face_enhancer_blend: int = 60,
) -> None:
    """
    Sharpen/refine an already-swapped face (e.g. a fal LoRA inpainting
    result) via FaceFusion's face_enhancer alone -- no source face needed,
    doesn't change identity or hair, just restores fine detail. Measured
    ~+16% sharpness (Laplacian variance) on the face region in testing, no
    visible artifacts.
    """
    extra_args = [
        "--processors", "face_enhancer",
        "--face-enhancer-model", face_enhancer_model,
        "--face-enhancer-blend", str(face_enhancer_blend),
    ]
    _run_headless(None, image_path, output_path, extra_args)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Path to the reference face photo (ignored with --refine-only)")
    parser.add_argument("target", help="Path to the scene photo to swap into (or already-swapped image to refine)")
    parser.add_argument("output", help="Path to write the result to")
    parser.add_argument("--no-enhance", action="store_true", help="Skip face_enhancer")
    parser.add_argument(
        "--refine-only", action="store_true",
        help="Skip the swap, just run face_enhancer on `target` (e.g. to sharpen a fal LoRA result)",
    )
    args = parser.parse_args()

    if args.refine_only:
        refine_face(args.target, args.output)
    else:
        face_swap_facefusion(
            args.source, args.target, args.output, enhance=not args.no_enhance
        )
    print(f"Saved -> {args.output}")
    sys.exit(0)
