from __future__ import annotations

"""
Standalone helper: runs MediaPipe's selfie_multiclass segmenter on one image
and writes a binary hair+face-skin mask PNG. Invoked as a subprocess (see
face_fal.build_head_hair_mask) rather than imported directly -- importing
mediapipe into a process that also uses RetinaFace/TensorFlow (as
pipeline_server.py does, lazily, for the crop stage) corrupts TensorFlow's
global state before RetinaFace ever builds its model: confirmed that
`import mediapipe` before RetinaFace.detect_faces() makes Keras raise
"A KerasTensor cannot be used as input to a TensorFlow function" on model
build, every time, while the reverse order works fine. A one-shot
subprocess keeps mediapipe's process-global side effects from ever sharing
an address space with retinaface's.

Usage: python3 mediapipe_segment.py <image_path> <out_mask_path>
"""

import os
import sys
import urllib.request

import numpy as np
from PIL import Image

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "selfie_multiclass_256x256.tflite")
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/"
    "selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite"
)

# Category indices for this model: 0 background, 1 hair, 2 body-skin,
# 3 face-skin, 4 clothes, 5 others (accessories). We want face+hair only --
# not body-skin/clothes, which would pull in arms/torso.
HAIR_FACE_CATEGORIES = (1, 3)


def _ensure_model() -> str:
    if not os.path.isfile(MODEL_PATH):
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    return MODEL_PATH


def main() -> None:
    image_path, out_mask_path = sys.argv[1], sys.argv[2]

    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import ImageSegmenter, ImageSegmenterOptions

    model_path = _ensure_model()
    mp_image = mp.Image.create_from_file(image_path)
    options = ImageSegmenterOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        output_category_mask=True,
    )
    with ImageSegmenter.create_from_options(options) as segmenter:
        result = segmenter.segment(mp_image)
        category_mask = result.category_mask.numpy_view().squeeze(-1)

    hair_face = np.isin(category_mask, HAIR_FACE_CATEGORIES).astype(np.uint8) * 255
    Image.fromarray(hair_face, mode="L").save(out_mask_path)


if __name__ == "__main__":
    main()
