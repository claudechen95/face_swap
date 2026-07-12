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
    """Run FaceFusion headless-run for a single image face swap."""
    venv_python = FACEFUSION_DIR / ".venv" / "bin" / "python"
    if not venv_python.exists():
        raise RuntimeError(
            f"FaceFusion venv not found at {venv_python}. "
            "Set it up first -- see the module docstring."
        )

    processors = ["face_swapper"]
    if enhance:
        processors.append("face_enhancer")

    cmd = [
        str(venv_python), "facefusion.py", "headless-run",
        "-s", str(Path(source_path).resolve()),
        "-t", str(Path(target_path).resolve()),
        "-o", str(Path(output_path).resolve()),
        "--processors", *processors,
        "--face-swapper-model", face_swapper_model,
        "--face-swapper-pixel-boost", pixel_boost,
        "--execution-providers", "coreml",
        "--log-level", "info",
    ]
    if enhance:
        cmd += [
            "--face-enhancer-model", face_enhancer_model,
            "--face-enhancer-blend", str(face_enhancer_blend),
        ]

    subprocess.run(cmd, cwd=FACEFUSION_DIR, check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Path to the reference face photo")
    parser.add_argument("target", help="Path to the scene photo to swap into")
    parser.add_argument("output", help="Path to write the result to")
    parser.add_argument("--no-enhance", action="store_true", help="Skip face_enhancer")
    args = parser.parse_args()

    face_swap_facefusion(
        args.source, args.target, args.output, enhance=not args.no_enhance
    )
    print(f"Saved -> {args.output}")
    sys.exit(0)
