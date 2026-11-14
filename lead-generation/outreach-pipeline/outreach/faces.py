"""Face quality gate: pick the best usable photo per lead, reject the rest.

Gate rules (SPEC.md 3.2), checked in order so the rejection reason is specific:
  - exactly one detected face (two-person thumbnails are rejected outright)
  - that face's detection score >= MIN_DET_SCORE
  - face box short side >= MIN_FACE_SHORT_SIDE px
  - |yaw| <= MAX_YAW, |pitch| <= MAX_PITCH
  - Laplacian-variance sharpness on the face crop >= MIN_SHARPNESS
  - not a small, text-heavy graphic (cheap edge-density heuristic)
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from insightface.app import FaceAnalysis

from .leads import Lead

MIN_DET_SCORE = 0.7
MIN_FACE_SHORT_SIDE = 256
MAX_YAW = 25.0
MAX_PITCH = 20.0
MIN_SHARPNESS = 100.0
SMALL_FACE_AREA_FRAC = 0.08
STYLIZED_EDGE_DENSITY = 0.12  # fraction of Canny-positive pixels we call "text-heavy"

_app: Optional[FaceAnalysis] = None


def _get_app() -> FaceAnalysis:
    global _app
    if _app is None:
        _app = FaceAnalysis(name="buffalo_l")
        _app.prepare(ctx_id=-1, det_size=(640, 640))
    return _app


class NoUsablePhoto(Exception):
    pass


@dataclass
class CandidateResult:
    path: Path
    passed: bool
    reason: Optional[str] = None
    det_score: float = 0.0
    face_area: float = 0.0
    embedding: Optional[np.ndarray] = None

    @property
    def rank_key(self) -> float:
        return self.face_area * self.det_score


def _edge_density(gray: np.ndarray) -> float:
    edges = cv2.Canny(gray, 100, 200)
    return float(np.count_nonzero(edges)) / edges.size


def evaluate_candidate(path: Path) -> CandidateResult:
    img = cv2.imread(str(path))
    if img is None:
        return CandidateResult(path, False, "unreadable")

    faces = _get_app().get(img)
    if len(faces) != 1:
        return CandidateResult(path, False, f"found {len(faces)} faces, need exactly 1")

    face = faces[0]
    if face.det_score < MIN_DET_SCORE:
        return CandidateResult(path, False, f"det_score {face.det_score:.2f} < {MIN_DET_SCORE}")

    x1, y1, x2, y2 = face.bbox
    box_w, box_h = x2 - x1, y2 - y1
    short_side = min(box_w, box_h)
    if short_side < MIN_FACE_SHORT_SIDE:
        return CandidateResult(path, False, f"face short side {short_side:.0f}px < {MIN_FACE_SHORT_SIDE}")

    pitch, yaw, _roll = face.pose
    if abs(yaw) > MAX_YAW or abs(pitch) > MAX_PITCH:
        return CandidateResult(path, False, f"pose out of range (yaw={yaw:.1f}, pitch={pitch:.1f})")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    x1i, y1i, x2i, y2i = (max(0, int(v)) for v in (x1, y1, x2, y2))
    face_crop_gray = gray[y1i:y2i, x1i:x2i]
    if face_crop_gray.size == 0:
        return CandidateResult(path, False, "empty face crop")
    sharpness = cv2.Laplacian(face_crop_gray, cv2.CV_64F).var()
    if sharpness < MIN_SHARPNESS:
        return CandidateResult(path, False, f"sharpness {sharpness:.0f} < {MIN_SHARPNESS}")

    img_h, img_w = img.shape[:2]
    face_area_frac = (box_w * box_h) / (img_w * img_h)
    if face_area_frac < SMALL_FACE_AREA_FRAC and _edge_density(gray) > STYLIZED_EDGE_DENSITY:
        return CandidateResult(path, False, "small face + text-heavy graphic, likely stylized thumbnail")

    return CandidateResult(
        path,
        True,
        det_score=float(face.det_score),
        face_area=float(box_w * box_h),
        embedding=face.embedding,
    )


def _is_deliberately_chosen(path: Path) -> bool:
    """manual.jpg and avatar.jpg are photos a person actually picked to
    represent themselves; video_NN.jpg are auto-extracted thumbnail frames,
    which are frequently mid-sentence/exaggerated clickbait expressions (a
    real example: a YouTube Shorts thumbnail captioned "So," with the
    subject's mouth open mid-word - technically sharp and well-lit, so it
    outranked the channel avatar on det_score/size alone before this check
    was added). Ranking by technical quality has no notion of "ordinary
    photo", so this takes priority over that ranking entirely."""
    return path.stem in ("manual", "avatar")


def filter_lead(lead: Lead) -> CandidateResult:
    """Evaluates every candidate under work/<slug>/candidates/, keeps the best
    passing one, and saves source.jpg + embedding.npy. Raises NoUsablePhoto if
    none pass."""
    candidates_dir = lead.work_dir / "candidates"
    paths = sorted(candidates_dir.glob("*.jpg")) if candidates_dir.exists() else []
    manual = lead.work_dir / "manual.jpg"
    if manual.exists():
        paths = [manual, *paths]

    results = [evaluate_candidate(p) for p in paths]
    passing = [r for r in results if r.passed]
    if not passing:
        raise NoUsablePhoto(
            f"{lead.slug}: no candidate passed the face quality gate "
            f"({len(results)} tried: {[r.reason for r in results]})"
        )

    chosen = [r for r in passing if _is_deliberately_chosen(r.path)]
    best = max(chosen, key=lambda r: r.rank_key) if chosen else max(passing, key=lambda r: r.rank_key)
    source_path = lead.work_dir / "source.jpg"
    source_path.write_bytes(best.path.read_bytes())
    np.save(lead.work_dir / "embedding.npy", best.embedding)
    return best
