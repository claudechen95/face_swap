"""Generator interface + Ideogram backend for the demo swap (SPEC.md 3.3,
corrected 2026-11-13): the real product swaps a person's face onto other
photos - it does not edit hair/beard/accessories on their own photo. The demo
must show the same mechanic: the lead's face swapped onto a few real
reference photos (the same `swap-library` photos the live product's free
preview uses - see config/targets.yaml), via Ideogram's character-reference
inpaint endpoint, mirroring the production call in api/_lib/ideogram.js.

Mask strategy: InsightFace's 106-point landmarks give a dense ~33-point
jawline contour (indices 0-32, confirmed empirically - see landmark_check.jpg
from the session this was built in) plus eyebrow points, so the mask traces
the target photo's actual face shape rather than a bounding-box ellipse - the
same fix just shipped to the production Rekognition-based mask, but with
richer landmark data than Rekognition's 5 jaw points.
"""

from __future__ import annotations

import io
import random
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import cv2
import httpx
import numpy as np
import yaml
from insightface.app import FaceAnalysis
from PIL import Image, ImageDraw, ImageFilter

from .leads import Lead

IDENTITY_THRESHOLD = 0.30  # see note in cli.py / review with user after first real batch
IDEOGRAM_CHARACTER_URL = "https://api.ideogram.ai/v2/image/inpaint/ideogram-3-character"
MASK_OUTER_MARGIN = 0.12  # outward scale from the jawline contour's own centroid
MASK_BLUR_RADIUS = 6
HAIRLINE_FACTOR = 0.9  # hairline estimate: eyebrow-to-chin distance mirrored upward
MAX_ATTEMPTS_PER_TARGET = 2
MIN_SURVIVING_TARGETS = 2

# Ported verbatim from api/_lib/ideogram.js's IDEOGRAM_CHARACTER_PROMPT - one
# source of truth for what "a good swap" means to this prompt, kept in sync
# with the production engine this demo is supposed to represent.
IDEOGRAM_CHARACTER_PROMPT = (
    "Replace only the masked person's face with the identity of the reference character. "
    "Match the reference character's facial structure, features, skin tone, and apparent age. "
    "Do not render glasses or any other eyewear on the face, even if the reference character or "
    "the source/target person is wearing them -- the result must show no glasses. Include facial "
    "hair only if present in the character reference; if absent, leave it absent. Exactly mimic "
    "the source person's original facial expression -- same mouth, eyes, and brow position -- as "
    "well as their gaze, head angle, pose, hairstyle, clothing, and accessories outside the face. "
    "Match the source image's lighting, shadows, perspective, texture, and visual style so the "
    "face blends naturally. Keep the original composition and background unchanged. If the mask "
    "extends beyond the face, preserve the original content in those areas."
)

_face_app: Optional[FaceAnalysis] = None


def _get_face_app() -> FaceAnalysis:
    global _face_app
    if _face_app is None:
        _face_app = FaceAnalysis(name="buffalo_l")
        _face_app.prepare(ctx_id=-1, det_size=(640, 640))
    return _face_app


def _largest_face(faces: list):
    return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))


class GenerationFailed(Exception):
    pass


def load_targets_config(config_path: Path) -> dict:
    with config_path.open() as f:
        return yaml.safe_load(f)


def load_painted_mask(mask_path: Path) -> bytes:
    """Loads a hand-painted mask (same white=edit/black=preserve convention as
    face_swap's own _mask.png files - see api/_lib/ideogram.js's
    invertForIdeogram). Preferred over the algorithmic mask below whenever one
    exists: a human painting the actual face_swap tool's masks is a higher
    quality bar than any automatic contour estimate."""
    return mask_path.read_bytes()


def build_face_contour_mask(image_path: Path) -> bytes:
    """Fallback for a target photo with no hand-painted mask. Matches the
    hand-painted masks' own white=edit/black=preserve convention (see
    load_painted_mask) rather than Ideogram's black=edit - both get inverted
    once, together, right before the API call in IdeogramGenerator.swap(), the
    same place production does it (api/_lib/ideogram.js's invertForIdeogram).
    Traces the actual jaw/chin contour via InsightFace's 106-point landmarks
    (indices 0-32) instead of a bounding-box ellipse."""
    img = cv2.imread(str(image_path))
    if img is None:
        raise GenerationFailed(f"could not read {image_path}")
    h, w = img.shape[:2]
    faces = _get_face_app().get(img)
    if not faces:
        raise GenerationFailed(f"no face detected in {image_path}")
    face = _largest_face(faces)
    lmk = face.landmark_2d_106

    jaw = lmk[0:33]
    left_brow = lmk[43:53]
    right_brow = lmk[97:107]
    eyebrow_top_y = min(left_brow[:, 1].min(), right_brow[:, 1].min())
    chin_y = jaw[:, 1].max()
    hairline_y = eyebrow_top_y - HAIRLINE_FACTOR * (chin_y - eyebrow_top_y)
    # Same perspective-overshoot risk as the production fix - clamp to the
    # detector's own bounding box top so a steep selfie angle can't push the
    # hairline estimate past the top of the photo.
    hairline_y = max(hairline_y, face.bbox[1])

    contour = list(jaw) + [[jaw[32][0], hairline_y], [jaw[0][0], hairline_y]]
    contour = np.array(contour)
    cx, cy = contour[:, 0].mean(), contour[:, 1].mean()
    scaled = cx + (contour[:, 0] - cx) * (1 + MASK_OUTER_MARGIN), cy + (contour[:, 1] - cy) * (1 + MASK_OUTER_MARGIN)
    points = list(zip(scaled[0].tolist(), scaled[1].tolist()))

    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon(points, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(MASK_BLUR_RADIUS))

    buf = io.BytesIO()
    mask.save(buf, format="PNG")
    return buf.getvalue()


def embed(image_path: Path) -> np.ndarray:
    img = cv2.imread(str(image_path))
    faces = _get_face_app().get(img)
    if not faces:
        raise GenerationFailed(f"no face detected in {image_path}")
    return _largest_face(faces).embedding


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


class Generator(ABC):
    @abstractmethod
    def swap(self, target_path: Path, reference_path: Path, mask_path: Optional[Path] = None) -> Path:
        """Returns a new image: `target_path`'s photo with its face replaced
        by the identity in `reference_path` (the lead's own source photo).
        Uses `mask_path` if given (a hand-painted mask shipped alongside the
        target), otherwise falls back to an algorithmic contour mask."""


@dataclass
class IdeogramGenerator(Generator):
    api_key: str
    client: Optional[httpx.Client] = None

    def __post_init__(self):
        if self.client is None:
            self.client = httpx.Client(timeout=90.0)

    def swap(self, target_path: Path, reference_path: Path, mask_path: Optional[Path] = None) -> Path:
        mask_bytes = load_painted_mask(mask_path) if mask_path else build_face_contour_mask(target_path)
        # Both mask sources use white=edit/black=preserve; Ideogram wants the
        # opposite, so invert once here, at the API boundary - same place and
        # same reasoning as production's invertForIdeogram.
        inverted_mask = Image.open(io.BytesIO(mask_bytes)).convert("L")
        inverted_mask = Image.eval(inverted_mask, lambda p: 255 - p)
        inverted_buf = io.BytesIO()
        inverted_mask.save(inverted_buf, format="PNG")

        files = {
            "image": (target_path.name, target_path.read_bytes()),
            "mask": ("mask.png", inverted_buf.getvalue(), "image/png"),
            "character_reference_images": (reference_path.name, reference_path.read_bytes()),
        }
        data = {"prompt": IDEOGRAM_CHARACTER_PROMPT, "magic_prompt": "on", "num_images": "1"}

        resp = self.client.post(
            IDEOGRAM_CHARACTER_URL,
            headers={"Api-Key": self.api_key},
            files=files,
            data=data,
        )
        if resp.status_code != 200:
            raise GenerationFailed(f"Ideogram request failed: {resp.status_code} {resp.text}")
        result_url = resp.json()["data"][0]["url"]

        image_resp = self.client.get(result_url, headers={"User-Agent": "Mozilla/5.0"})
        image_resp.raise_for_status()

        out_path = reference_path.parent / f"_generated_{int(time.time() * 1000)}_{random.randint(0, 9999)}.jpg"
        out_path.write_bytes(image_resp.content)
        return out_path


@dataclass
class TargetResult:
    target_id: str
    path: Path
    similarity: float


@dataclass
class GenerateReport:
    survived: dict[str, TargetResult] = field(default_factory=dict)
    attempts: list[dict] = field(default_factory=list)


def generate_lead(lead: Lead, config: dict, generator: Generator) -> GenerateReport:
    source_path = lead.work_dir / "source.jpg"
    if not source_path.exists():
        raise GenerationFailed(f"{lead.slug}: no source.jpg - run `outreach filter` first")
    source_embedding = np.load(lead.work_dir / "embedding.npy")

    report = GenerateReport()
    for target in config["targets"]:
        target_path = Path(config["targets_dir"]) / target["file"]
        mask_file = target.get("mask_file")
        mask_path = Path(config["targets_dir"]) / mask_file if mask_file else None
        for attempt in range(MAX_ATTEMPTS_PER_TARGET):
            t0 = time.monotonic()
            out_path = generator.swap(target_path, source_path, mask_path=mask_path)
            latency_s = time.monotonic() - t0
            similarity = cosine_similarity(source_embedding, embed(out_path))
            report.attempts.append(
                {"target": target["id"], "attempt": attempt, "similarity": similarity, "latency_s": latency_s}
            )
            if similarity >= IDENTITY_THRESHOLD:
                dest = lead.work_dir / f"target_{target['id']}.jpg"
                dest.write_bytes(out_path.read_bytes())
                out_path.unlink(missing_ok=True)
                report.survived[target["id"]] = TargetResult(target["id"], dest, similarity)
                break
            out_path.unlink(missing_ok=True)

    if len(report.survived) < MIN_SURVIVING_TARGETS:
        raise GenerationFailed(
            f"{lead.slug}: only {len(report.survived)} swap(s) survived the identity gate, "
            f"need >= {MIN_SURVIVING_TARGETS}"
        )
    return report
