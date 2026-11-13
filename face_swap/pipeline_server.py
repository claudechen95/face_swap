from __future__ import annotations

"""
Pipeline control panel: one page showing every photo in a project as a row
of stages -- Crop, Upscale, Mask, Ideogram (character-ref swap) -- each
runnable and inspectable in place, instead of one-off scripts and hunting
through Finder to see what state a photo is in.

  python3 pipeline_server.py \
    --project "Dating=~/Desktop/Dating-upload,~/Desktop/target_swapped/Dating-upload" \
    --project "Greenhouse=~/Desktop/target_swapped/greenhouse" \
    --port 8765

Stage files per photo (stem = original filename without extension), all
written to the project's out_dir:

  <stem>_1crop.jpg          -- square crop centred on the face
  <stem>_2upscale.jpg       -- that crop upscaled to an exact target size
  <stem>_3mask.png          -- paint mask (white = regenerate), on stage 2
  <stem>_3mask_preview.jpg  -- red-highlight overlay of the mask, for viewing
  <stem>_ideogram_N.jpg     -- Nth Ideogram character-swap attempt, stacks
                               instead of overwriting since "pick the best
                               of a few" is the normal way this gets used

Requires FAL_KEY (source .env before running) -- Upscale uses
topaz/upscale/image/generative (Wonder 3.5) via face_fal.py, Ideogram calls
api.ideogram.ai directly.
"""

import argparse
import io
import json
import mimetypes
import os
import random
import re
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests
from dotenv import load_dotenv
from PIL import Image, ImageFilter, ImageOps

# Must run before importing face_fal -- it raises at import time if FAL_KEY
# isn't already set, so .env has to be loaded first, not after.
load_dotenv()

import face_fal

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")

# The Ideogram character-reference engine's global reference photo -- one
# face photo, reused for every "Run Ideogram" click until replaced. Stored
# next to the script rather than per-project.
CHARACTER_REFERENCE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "character_reference.jpg")

# Optional companion mask for CHARACTER_REFERENCE_PATH, to extract just part
# of the reference photo as the character rather than the whole thing.
# Painted the same way as a per-photo _3mask.png, but global and un-prefixed
# like the reference photo itself. Cleared whenever the reference photo is
# replaced, since a mask painted for one photo is meaningless over a
# different one.
CHARACTER_REFERENCE_MASK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "character_reference_mask.png")

IDEOGRAM_API_KEY = os.environ.get("IDEOGRAM_API_KEY", "")
# Per-photo auto expression description (face_fal.describe_facial_expression)
# is disabled by default -- too costly/unpredictable to run on every click.
# The function itself is still in face_fal.py if this gets turned back on.
# The optional "expression" field in the UI below is a manual per-run
# override instead: when left blank, falls back to the generic instruction
# baked into IDEOGRAM_CHARACTER_PROMPT.
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
IDEOGRAM_CHARACTER_PROMPT_WITH_EXPRESSION = (
    "Replace only the masked person's face with the identity of the reference character. "
    "Match the reference character's facial structure, features, skin tone, and apparent age. "
    "Do not render glasses or any other eyewear on the face, even if the reference character or "
    "the source/target person is wearing them -- the result must show no glasses. Include facial "
    "hair only if present in the character reference; if absent, leave it absent. Give the face "
    "this exact expression: {expression}. Exactly mimic the source person's gaze, head angle, "
    "pose, hairstyle, clothing, and accessories outside the face. Match the source image's "
    "lighting, shadows, perspective, texture, and visual style so the face blends naturally. Keep "
    "the original composition and background unchanged. If the mask extends beyond the face, "
    "preserve the original content in those areas."
)


def topaz_upscale_bytes(image_bytes: bytes, scale: float = 4.0) -> bytes:
    """
    Runs raw image bytes through face_fal.upscale_image (Topaz Wonder 3.5,
    same engine already used elsewhere in this pipeline) and returns the
    upscaled bytes. Used to give Ideogram's small output real detail before
    compositing it back onto a much larger base -- a plain resize only
    stretches existing pixels, it can't recover detail that was never there
    at 1024x1024 in the first place.
    """
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp.write(image_bytes)
        tmp_path = tmp.name
    try:
        url = face_fal.upscale_image(tmp_path, scale=scale, face=True)
    finally:
        os.remove(tmp_path)
    return requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=120).content


def composite_masked_region(base_path: str, generated_bytes: bytes, mask_path: str, feather_px: int = 4) -> Image.Image:
    """
    Ideogram's inpaint endpoints regenerate the whole frame, not just the
    masked region, and snap the output down to a much lower resolution than
    the input (e.g. 4200x4200 in -> 1024x1024 out) rather than preserving
    it. Paste only the masked region back onto the untouched full-resolution
    base and discard everything else Ideogram touched -- same fix as the GPT
    Image edit endpoints needed earlier for the same whole-image-regen
    behavior. feather_px is small on purpose: a wide feather blurs together
    two regions with different native grain/texture into a visible soft
    band (confirmed earlier this session) -- a few px is enough to avoid a
    hard pixel edge without smearing detail.
    """
    base = Image.open(base_path).convert("RGB")
    generated = Image.open(io.BytesIO(generated_bytes)).convert("RGB").resize(base.size, Image.LANCZOS)
    mask = Image.open(mask_path).convert("L").resize(base.size).filter(ImageFilter.GaussianBlur(feather_px))
    return Image.composite(generated, base, mask)


def apply_clean_iphone_metadata(image_path: str) -> None:
    """
    Final step on a delivered swap: strips any metadata the generation
    tools left on the file and writes back fabricated-but-plausible iPhone
    16 Pro EXIF/GPS, so the client-delivered file looks camera-native
    rather than carrying provenance tags pointing at the editing pipeline.
    For consented client deliverables only (paid-for face-swap stock/ad
    photos), not for impersonation -- see add_clean_iphone_metadata in
    ~/.bashrc for the actual field values (random recent timestamp, fixed
    Seattle-area GPS, randomized-but-realistic iPhone camera settings).

    Shells out to that bash function rather than reimplementing it here,
    so there's one source of truth for the field values. It's only defined
    in an interactive shell's ~/.bashrc, not on PATH, so it has to be
    sourced explicitly -- a plain subprocess call wouldn't see it.

    Also clears macOS extended attributes (xattr -c) -- exiftool only
    rewrites embedded EXIF, it can't touch com.apple.metadata:kMDItemWhereFroms
    or com.apple.quarantine, the xattrs a browser/download stamps onto a
    file and that Finder surfaces as "Where from" in Get Info. Those would
    survive the EXIF rewrite untouched and give away that the file came
    from a URL, not a camera roll.
    """
    with Image.open(image_path) as im:
        width, height = im.size
    result = subprocess.run(
        [
            "bash", "-c",
            'source ~/.bashrc >/dev/null 2>&1 && add_clean_iphone_metadata "$1" "$2" "$3"',
            "_", image_path, str(width), str(height),
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"add_clean_iphone_metadata failed for {image_path}: {result.stderr.strip()}")
    subprocess.run(["xattr", "-c", image_path], check=True)


DELIVERED_SUBDIR = "delivered"


def save_as_iphone_filename(image_path: str, out_dir: str) -> str:
    """
    Copies image_path (already run through apply_clean_iphone_metadata) to
    a new file named like a real Camera Roll export -- IMG_<4 digits>.jpg --
    instead of this pipeline's own <stem>_ideogram_N.jpg naming, which
    plainly reveals it as a pipeline artifact. A copy, not a rename: the
    original tracked filename has to stick around under its
    <stem>_ideogram_N.jpg name for this tool's own bookkeeping (originals()
    / is_original() / the per-row result lists all match on that suffix --
    renaming in place would make the result vanish from its row).

    Written into out_dir/delivered/ rather than out_dir itself --
    IMG_####.jpg is exactly how real uploaded iPhone photos are already
    named, so dropping it in out_dir would make is_original() pick the
    copy back up as a brand-new "original" photo next refresh (same bug
    class as the old *_mask.png files, just unavoidable here since there's
    no suffix to exclude on without also excluding real originals).
    Directory listings aren't recursive, so a subfolder sidesteps that
    entirely. Returns the new file's path relative to out_dir.
    """
    dest_dir = os.path.join(out_dir, DELIVERED_SUBDIR)
    os.makedirs(dest_dir, exist_ok=True)
    for _ in range(100):
        num = random.randint(1000, 9999)
        name = f"IMG_{num}.jpg"
        dest = os.path.join(dest_dir, name)
        if not os.path.exists(dest):
            shutil.copy2(image_path, dest)
            return os.path.join(DELIVERED_SUBDIR, name)
    raise RuntimeError("Could not find an unused IMG_#### filename after 100 tries")


def _inverted_mask_bytes(mask_path: str) -> io.BytesIO:
    buf = io.BytesIO()
    ImageOps.invert(Image.open(mask_path).convert("L")).save(buf, "PNG")
    buf.seek(0)
    return buf


def ideogram_character_swap(
    image_path: str, mask_path: str, reference_path: str, prompt: str,
    reference_mask_path: str | None = None, num_images: int = 2,
) -> list[str]:
    """
    POSTs to Ideogram's v2/image/inpaint/ideogram-3-character with async=true
    (returns a generation_id immediately), then polls GET
    /v2/generations/{id} until status is "completed" or "failed". Returns the
    result images' (ephemeral, signed) URLs, one per num_images -- download
    them promptly and with a real User-Agent header, bare urllib/requests
    calls without one get a 403.

    Ideogram's mask convention (both `mask` and the optional
    `character_reference_mask`) is black=selected region, white=everything
    else -- the opposite of this project's own _3mask.png convention
    (white=regenerate, see the module docstring). Invert both in memory
    before sending; the files on disk stay untouched. reference_mask_path
    is optional -- Ideogram uses the whole reference image as the character
    when it's omitted.
    """
    if not IDEOGRAM_API_KEY:
        raise RuntimeError("Set the IDEOGRAM_API_KEY environment variable before running this script.")
    inverted_mask = _inverted_mask_bytes(mask_path)
    files = {
        "image": open(image_path, "rb"),
        "mask": ("mask.png", inverted_mask, "image/png"),
        "character_reference_images": open(reference_path, "rb"),
    }
    if reference_mask_path and os.path.isfile(reference_mask_path):
        files["character_reference_mask"] = ("reference_mask.png", _inverted_mask_bytes(reference_mask_path), "image/png")
    try:
        resp = requests.post(
            "https://api.ideogram.ai/v2/image/inpaint/ideogram-3-character",
            headers={"Api-Key": IDEOGRAM_API_KEY},
            files=files,
            data={"prompt": prompt, "magic_prompt": "on", "num_images": str(num_images), "async": "true"},
            timeout=120,
        )
    finally:
        files["image"].close()
        files["character_reference_images"].close()
    resp.raise_for_status()
    generation_id = resp.json()["generation_id"]

    deadline = time.time() + 120
    while time.time() < deadline:
        time.sleep(2)
        poll = requests.get(
            f"https://api.ideogram.ai/v2/generations/{generation_id}",
            headers={"Api-Key": IDEOGRAM_API_KEY},
            timeout=30,
        )
        poll.raise_for_status()
        body = poll.json()
        if body["status"] == "completed":
            return [item["url"] for item in body["data"]]
        if body["status"] == "failed":
            raise RuntimeError(f"Ideogram generation failed: {body}")
    raise RuntimeError("Ideogram generation timed out after 120s")


def safe_name(name: str) -> str:
    """
    basename() already strips any directory component; this only needs to
    stop an embedded slash/backslash or control character from reintroducing
    one (or writing somewhere unexpected), not whitelist "normal" filename
    characters -- a narrower whitelist previously excluded parentheses,
    silently mismatching real filenames like "Photo (1).png" against what
    was actually on disk and 404ing every lookup for them.
    """
    name = os.path.basename(name)
    return re.sub(r"[\x00-\x1f/\\]", "_", name) or "x"


def parse_projects(specs: list[str]) -> dict[str, tuple[str, str]]:
    projects = {}
    for spec in specs:
        if "=" not in spec:
            raise ValueError(f"--project must be Label=images_dir[,out_dir], got: {spec!r}")
        label, rest = spec.split("=", 1)
        parts = rest.split(",", 1)
        images_dir = os.path.expanduser(parts[0])
        out_dir = os.path.expanduser(parts[1]) if len(parts) > 1 else images_dir
        os.makedirs(out_dir, exist_ok=True)
        projects[label] = (images_dir, out_dir)
    return projects


def is_original(name: str) -> bool:
    if not name.lower().endswith(IMAGE_EXTS):
        return False
    return not re.search(r"_(1crop|2upscale|3mask(_preview)?|mask(_\w+)?|4swap_\d+|qwen_\d+|ideogram_\d+)\.(jpg|jpeg|png|webp)$", name, re.I)


RESULT_PATTERN = re.compile(r"_(4swap_\d+|qwen_\d+|ideogram_\d+)\.(jpg|jpeg|png|webp)$", re.I)


def make_handler(projects: dict[str, tuple[str, str]]):
    def dirs_for(label: str) -> list[str]:
        images_dir, out_dir = projects[label]
        return [out_dir] if images_dir == out_dir else [out_dir, images_dir]

    def resolve(label: str, name: str) -> str | None:
        for d in dirs_for(label):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                return p
        return None

    def originals(label: str) -> list[str]:
        names = set()
        for d in dirs_for(label):
            names.update(n for n in os.listdir(d) if is_original(n))
        return sorted(names)

    def pipeline_state(label: str) -> list[dict]:
        _, out_dir = projects[label]
        out_names = set(os.listdir(out_dir))
        rows = []
        for name in originals(label):
            stem = os.path.splitext(name)[0]

            def find(pattern):
                matches = sorted(n for n in out_names if re.match(pattern, n))
                return matches

            crop = find(rf"^{re.escape(stem)}_1crop\.jpe?g$")
            upscale = find(rf"^{re.escape(stem)}_2upscale\.jpe?g$")
            mask = find(rf"^{re.escape(stem)}_3mask\.png$")
            preview = find(rf"^{re.escape(stem)}_3mask_preview\.jpe?g$")
            ideograms = find(rf"^{re.escape(stem)}_ideogram_\d+\.jpe?g$")
            rows.append({
                "stem": stem,
                "original": name,
                "crop": crop[0] if crop else None,
                "upscale": upscale[0] if upscale else None,
                "mask": mask[0] if mask else None,
                "maskPreview": preview[0] if preview else None,
                "ideograms": ideograms,
            })
        return rows

    MIN_SWAP_SIDE = 2000

    def resolve_base_image(label: str, stem: str) -> tuple[str | None, str]:
        """
        Picks the best available base image for the Ideogram swap to run
        against. Masking no longer requires an upscale first (see
        /run/crop's invalidation comment), so a photo can reach here with
        nothing but a crop, or nothing but the original -- prefer
        upscale > crop > original, same priority as the paint view's own
        fallback. Whichever is picked must be at least MIN_SWAP_SIDE on each
        side, or the result returned is None and the second element
        explains why (too small, or nothing found at all).
        """
        _, out_dir = projects[label]
        candidates = [
            (os.path.join(out_dir, f"{stem}_2upscale.jpg"), "upscale"),
            (os.path.join(out_dir, f"{stem}_1crop.jpg"), "crop"),
        ]
        original_name = next((n for n in originals(label) if os.path.splitext(n)[0] == stem), None)
        if original_name:
            candidates.append((resolve(label, original_name), "original"))
        for path, kind in candidates:
            if path and os.path.isfile(path):
                with Image.open(path) as im:
                    w, h = im.size
                if w < MIN_SWAP_SIDE or h < MIN_SWAP_SIDE:
                    return None, f"the {kind} image is only {w}x{h} -- need at least {MIN_SWAP_SIDE}x{MIN_SWAP_SIDE}"
                return path, ""
        return None, "no image found for this photo"

    def write_mask_preview(label: str, stem: str, image_name: str, mask_bytes: bytes) -> None:
        _, out_dir = projects[label]
        image_path = resolve(label, image_name)
        img = Image.open(image_path).convert("RGB")
        mask = Image.open(io.BytesIO(mask_bytes)).convert("L").resize(img.size)
        red = Image.new("RGB", img.size, (255, 0, 0))
        preview_path = os.path.join(out_dir, f"{stem}_3mask_preview.jpg")
        Image.composite(red, img, mask.point(lambda p: int(p * 0.6))).save(preview_path)

    class Handler(BaseHTTPRequestHandler):
        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def _send(self, data: bytes, content_type: str, status: int = 200):
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _json(self, obj, status: int = 200):
            self._send(json.dumps(obj).encode("utf-8"), "application/json", status)

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            qs = urllib.parse.parse_qs(parsed.query)
            label = (qs.get("project") or [None])[0]

            if path == "/":
                self._send(PIPELINE_HTML.encode("utf-8"), "text/html; charset=utf-8")
                return
            if path == "/projects":
                self._json(list(projects.keys()))
                return

            if path == "/character-reference-status":
                self._json({
                    "has_reference": os.path.isfile(CHARACTER_REFERENCE_PATH),
                    "has_reference_mask": os.path.isfile(CHARACTER_REFERENCE_MASK_PATH),
                })
                return

            if path == "/character-reference":
                if not os.path.isfile(CHARACTER_REFERENCE_PATH):
                    self._send(b"not found", "text/plain", 404)
                    return
                with open(CHARACTER_REFERENCE_PATH, "rb") as f:
                    self._send(f.read(), "image/jpeg")
                return

            if path == "/character-reference-mask":
                if not os.path.isfile(CHARACTER_REFERENCE_MASK_PATH):
                    self._send(b"not found", "text/plain", 404)
                    return
                with open(CHARACTER_REFERENCE_MASK_PATH, "rb") as f:
                    self._send(f.read(), "image/png")
                return
            if label not in projects:
                self._send(b"unknown project", "text/plain", 400)
                return

            if path == "/state":
                self._json(pipeline_state(label))
                return

            if path == "/suggest-crop":
                original = qs.get("original", [""])[0]
                src = resolve(label, original)
                select = qs.get("select", ["largest"])[0]
                try:
                    select = int(select)
                except ValueError:
                    pass
                head_bias = float(qs.get("head_bias", ["0.15"])[0])
                try:
                    box = face_fal.suggest_square_crop_box(src, select=select, head_bias=head_bias)
                except ValueError as exc:
                    with Image.open(src) as im:
                        w, h = im.size
                    side = min(w, h)
                    box = {"left": (w - side) // 2, "top": (h - side) // 2, "side": side, "width": w, "height": h}
                self._json(box)
                return

            if path == "/suggest-mask":
                image_name = qs.get("image", [""])[0]
                src = resolve(label, image_name)
                if not src:
                    self._send(b"not found", "text/plain", 404)
                    return
                select = qs.get("select", ["largest"])[0]
                try:
                    select = int(select)
                except ValueError:
                    pass
                try:
                    mask_img = face_fal.build_head_hair_mask(src, select=select)
                except (ValueError, RuntimeError) as exc:
                    self._json({"ok": False, "error": str(exc)}, 400)
                    return
                buf = io.BytesIO()
                mask_img.save(buf, "PNG")
                self._send(buf.getvalue(), "image/png")
                return

            if path.startswith("/images/"):
                name = safe_name(urllib.parse.unquote(path[len("/images/"):]))
                fpath = resolve(label, name)
                if not fpath:
                    self._send(b"not found", "text/plain", 404)
                    return
                ctype = mimetypes.guess_type(fpath)[0] or "application/octet-stream"
                with open(fpath, "rb") as f:
                    self._send(f.read(), ctype)
                return

            if path == "/swap-params":
                name = safe_name(qs.get("file", [""])[0])
                json_path = resolve(label, os.path.splitext(name)[0] + ".json")
                if not json_path:
                    self._json({"ok": False, "error": "no saved params for this swap (made before this was tracked)"}, 404)
                    return
                with open(json_path) as f:
                    self._json({"ok": True, **json.load(f)})
                return

            self._send(b"not found", "text/plain", 404)

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            qs = urllib.parse.parse_qs(parsed.query)
            label = (qs.get("project") or [None])[0]
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b""

            if path == "/upload-character-reference":
                # Not keyed by project -- one global reference photo, reused
                # by every /run/ideogram call until replaced.
                try:
                    img = Image.open(io.BytesIO(body)).convert("RGB")
                except Exception as exc:
                    self._json({"ok": False, "error": f"not a valid image: {exc}"}, 400)
                    return
                buf = io.BytesIO()
                img.save(buf, "JPEG", quality=95)
                new_bytes = buf.getvalue()
                # Re-uploading the exact same photo (e.g. after a server
                # restart) shouldn't wipe a mask someone spent real time
                # painting. Only drop the mask when the photo actually
                # changed -- a mask painted for a *different* photo doesn't
                # mean anything and would silently misapply otherwise.
                same_photo = False
                if os.path.isfile(CHARACTER_REFERENCE_PATH):
                    with open(CHARACTER_REFERENCE_PATH, "rb") as f:
                        same_photo = f.read() == new_bytes
                with open(CHARACTER_REFERENCE_PATH, "wb") as f:
                    f.write(new_bytes)
                if not same_photo and os.path.isfile(CHARACTER_REFERENCE_MASK_PATH):
                    os.remove(CHARACTER_REFERENCE_MASK_PATH)
                self._json({"ok": True})
                return

            if path == "/save-reference-mask":
                if not os.path.isfile(CHARACTER_REFERENCE_PATH):
                    self._json({"ok": False, "error": "set a reference photo first"}, 400)
                    return
                with open(CHARACTER_REFERENCE_MASK_PATH, "wb") as f:
                    f.write(body)
                self._json({"ok": True})
                return

            if label not in projects:
                self._send(b"unknown project", "text/plain", 400)
                return
            images_dir, out_dir = projects[label]
            stem = safe_name(qs.get("stem", [""])[0])

            try:
                if path == "/upload":
                    # New source photos are "originals" -- land in images_dir
                    # (for a single-folder project this is the same as
                    # out_dir), so they show up as a fresh row just like any
                    # photo that was already in the folder.
                    name = safe_name(qs.get("name", ["upload.png"])[0])
                    name_stem, ext = os.path.splitext(name)
                    dest = os.path.join(images_dir, name)
                    i = 1
                    while os.path.isfile(dest):
                        dest = os.path.join(images_dir, f"{name_stem}_{i}{ext}")
                        i += 1
                    with open(dest, "wb") as f:
                        f.write(body)
                    self._json({"ok": True, "file": os.path.basename(dest)})
                    return

                if path == "/remove":
                    # Deletes the original photo plus every generated stage
                    # file for it (crop/upscale/mask/mask preview/swaps),
                    # across both images_dir and out_dir -- a full "undo this
                    # photo ever showed up" rather than just hiding the row.
                    original = qs.get("original", [""])[0]
                    if not original or not is_original(original):
                        self._json({"ok": False, "error": "missing or invalid original"}, 400)
                        return
                    original_stem = os.path.splitext(original)[0]
                    stage_pattern = re.compile(
                        rf"^{re.escape(original_stem)}_(1crop|2upscale|3mask(_preview)?|4swap_\d+|qwen_\d+|ideogram_\d+)\.(jpg|jpeg|png|webp)$",
                        re.I,
                    )
                    removed = []
                    for d in dirs_for(label):
                        for n in os.listdir(d):
                            if n == original or stage_pattern.match(n):
                                os.remove(os.path.join(d, n))
                                removed.append(n)
                    self._json({"ok": True, "removed": removed})
                    return

                if path == "/remove-result":
                    # Deletes one generated result (a single Ideogram
                    # attempt) plus its sidecar params json, leaving the
                    # original and every other attempt untouched -- unlike
                    # /remove, which nukes the whole photo.
                    name = safe_name(qs.get("file", [""])[0])
                    if not RESULT_PATTERN.search(name):
                        self._json({"ok": False, "error": "not a result file"}, 400)
                        return
                    fpath = resolve(label, name)
                    if not fpath:
                        self._json({"ok": False, "error": "not found"}, 404)
                        return
                    os.remove(fpath)
                    json_path = os.path.splitext(fpath)[0] + ".json"
                    if os.path.isfile(json_path):
                        os.remove(json_path)
                    self._json({"ok": True})
                    return

                if path == "/run/crop":
                    original = qs.get("original", [""])[0]
                    src = resolve(label, original)
                    if "left" in qs and "top" in qs and "side" in qs:
                        # Explicit box from the interactive crop view.
                        left, top, side = int(qs["left"][0]), int(qs["top"][0]), int(qs["side"][0])
                        square = face_fal.crop_box(src, left, top, side)
                    else:
                        select = qs.get("select", ["largest"])[0]
                        try:
                            select = int(select)
                        except ValueError:
                            pass
                        head_bias = float(qs.get("head_bias", ["0.15"])[0])
                        square = face_fal.crop_to_square_on_face(src, select=select, head_bias=head_bias)
                    out_path = os.path.join(out_dir, f"{stem}_1crop.jpg")
                    square.convert("RGB").save(out_path, quality=95)
                    # Cropping changes framing -- a mask painted against the
                    # old crop (or, since masking no longer requires an
                    # upscale first, against the full original) no longer
                    # lines up with anything downstream, and neither does an
                    # existing upscale (it's a pure resize of the *old*
                    # crop). Clear both rather than risk resolve_base_image
                    # silently preferring a stale upscale over the fresh crop.
                    for suffix in ("_2upscale.jpg", "_3mask.png", "_3mask_preview.jpg"):
                        stale = os.path.join(out_dir, f"{stem}{suffix}")
                        if os.path.isfile(stale):
                            os.remove(stale)
                    self._json({"ok": True, "file": os.path.basename(out_path)})
                    return

                if path == "/run/upscale":
                    target = int(qs.get("target", ["4200"])[0])
                    crop_path = os.path.join(out_dir, f"{stem}_1crop.jpg")
                    if not os.path.isfile(crop_path):
                        self._json({"ok": False, "error": "run crop first"}, 400)
                        return
                    url = face_fal.upscale_to_size(crop_path, target=target)
                    out_path = os.path.join(out_dir, f"{stem}_2upscale.jpg")
                    tmp_path = out_path + ".tmp"
                    urllib.request.urlretrieve(url, tmp_path)
                    # Topaz returns PNG regardless of the input's
                    # format -- urlretrieve just writes those bytes verbatim,
                    # so without re-encoding here every _2upscale.jpg on disk
                    # was actually a PNG with a .jpg name (Finder can't
                    # preview the mismatch, and it's only not silently wrong
                    # here because we always re-save below, not just when a
                    # resize is also needed).
                    img = Image.open(tmp_path).convert("RGB")
                    if img.size != (target, target):
                        img = img.resize((target, target), Image.LANCZOS)
                    img.save(out_path, "JPEG", quality=95)
                    os.remove(tmp_path)
                    # Crop and upscale share the same square framing (upscale
                    # is a pure resize of the crop) -- if a mask was already
                    # painted (against the crop, since masking doesn't
                    # require an upscale first) at a different resolution
                    # than this target, rescale it in place instead of
                    # discarding the user's work.
                    mask_path = os.path.join(out_dir, f"{stem}_3mask.png")
                    if os.path.isfile(mask_path):
                        mask_img = Image.open(mask_path).convert("L")
                        if mask_img.size != (target, target):
                            mask_img = mask_img.resize((target, target), Image.NEAREST)
                            mask_img.save(mask_path)
                            with open(mask_path, "rb") as f:
                                write_mask_preview(label, stem, os.path.basename(out_path), f.read())
                    self._json({"ok": True, "file": os.path.basename(out_path)})
                    return

                if path == "/save-mask":
                    image_name = qs.get("image", [""])[0]
                    mask_path = os.path.join(out_dir, f"{stem}_3mask.png")
                    with open(mask_path, "wb") as f:
                        f.write(body)
                    write_mask_preview(label, stem, image_name, body)
                    self._json({"ok": True})
                    return

                if path == "/run/ideogram":
                    base_path, base_error = resolve_base_image(label, stem)
                    mask_path = os.path.join(out_dir, f"{stem}_3mask.png")
                    if not base_path or not os.path.isfile(mask_path):
                        self._json({"ok": False, "error": base_error or "need a saved mask first"}, 400)
                        return
                    if not os.path.isfile(CHARACTER_REFERENCE_PATH):
                        self._json({"ok": False, "error": "no reference photo set -- use 'Upload reference' first"}, 400)
                        return
                    expression = (qs.get("expression") or [""])[0].strip()
                    prompt = (
                        IDEOGRAM_CHARACTER_PROMPT_WITH_EXPRESSION.format(expression=expression)
                        if expression else IDEOGRAM_CHARACTER_PROMPT
                    )
                    urls = ideogram_character_swap(
                        base_path, mask_path, CHARACTER_REFERENCE_PATH, prompt,
                        reference_mask_path=CHARACTER_REFERENCE_MASK_PATH, num_images=2,
                    )
                    existing = [n for n in os.listdir(out_dir) if re.match(rf"^{re.escape(stem)}_ideogram_\d+\.jpe?g$", n)]
                    n = len(existing) + 1
                    out_files = []
                    delivered_files = []
                    for i, url in enumerate(urls):
                        img_bytes = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60).content
                        img_bytes = topaz_upscale_bytes(img_bytes)
                        out_path = os.path.join(out_dir, f"{stem}_ideogram_{n + i}.jpg")
                        composite_masked_region(base_path, img_bytes, mask_path).save(out_path, "JPEG", quality=95)
                        apply_clean_iphone_metadata(out_path)
                        delivered_name = save_as_iphone_filename(out_path, out_dir)
                        params = {
                            "engine": "ideogram_character", "prompt": prompt, "expression": expression or None,
                            "delivered_as": delivered_name,
                        }
                        with open(os.path.splitext(out_path)[0] + ".json", "w") as f:
                            json.dump(params, f, indent=2)
                        out_files.append(os.path.basename(out_path))
                        delivered_files.append(delivered_name)
                    self._json({"ok": True, "files": out_files, "delivered": delivered_files, "prompt": prompt})
                    return
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, 500)
                return

            self._send(b"not found", "text/plain", 404)

        def log_message(self, fmt, *args):
            pass

    return Handler


PIPELINE_HTML = r"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Pipeline</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background:#1b1b1f; color:#eee; }
  header { display:flex; align-items:center; gap:14px; padding:14px 20px; background:#222; border-bottom:1px solid #333; position:sticky; top:0; z-index:5; }
  header h1 { font-size:15px; margin:0; }
  #refBar { display:flex; align-items:center; gap:10px; padding:10px 20px; background:#1d2a1d; border-bottom:1px solid #333; }
  #refBar img { height:40px; border-radius:6px; cursor:pointer; }
  select, button, input { background:#333; color:#eee; border:1px solid #444; border-radius:6px; padding:6px 9px; font-size:12px; }
  button { cursor:pointer; }
  button:hover { background:#3a3a3a; }
  button:disabled { opacity:.4; cursor:default; }
  button.primary { background:#2e7d32; border-color:#2e7d32; font-weight:600; }
  button.primary:hover { background:#357a38; }
  #rows { padding:16px 20px; display:flex; flex-direction:column; gap:14px; }
  .row { display:grid; grid-template-columns:140px repeat(4, 1fr); gap:10px; background:#222; border:1px solid #333; border-radius:10px; padding:12px; align-items:start; }
  .rowlabel { width:140px; font-size:12px; color:#aaa; word-break:break-all; display:flex; flex-direction:column; gap:6px; }
  .rowthumb { width:140px; height:140px; overflow:auto; border-radius:6px; background:#111; }
  .rowthumb img { width:100%; display:block; cursor:zoom-in; }
  .stage { background:#191919; border-radius:8px; padding:8px; display:flex; flex-direction:column; gap:6px; }
  .stage h3 { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#888; margin:0; }
  .stage img { width:100%; height:220px; border-radius:6px; object-fit:contain; cursor:zoom-in; background:#000; }
  .stage .placeholder { height:220px; border:1px dashed #3a3a3a; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#555; font-size:11px; }
  .stage .controls { display:flex; flex-direction:column; gap:6px; }
  .stage .controls-inputs { display:flex; gap:6px; flex-wrap:wrap; align-items:flex-end; min-height:40px; }
  .stage .controls-actions { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .stage .controls input { width:56px; }
  .swaplist { display:flex; gap:6px; flex-wrap:wrap; }
  .swapthumb { position:relative; width:110px; height:110px; }
  .swaplist img { width:110px; height:110px; max-height:110px; display:block; border-radius:4px; object-fit:cover; cursor:zoom-in; }
  .swapinfo {
    position:absolute; top:2px; right:2px; width:14px; height:14px; border-radius:50%;
    background:rgba(0,0,0,.65); color:#fff; font-size:10px; line-height:14px; text-align:center;
    font-family:Georgia,serif; cursor:default; display:none;
  }
  .swapthumb.has-info .swapinfo { display:block; }
  .swapinfo .tooltip {
    display:none; position:absolute; top:18px; right:0; width:260px; z-index:10;
    background:rgba(20,20,20,.97); border:1px solid #444; border-radius:8px; padding:10px 12px;
    font-size:11px; color:#ccc; line-height:1.5; text-align:left; white-space:normal;
  }
  .swapinfo:hover .tooltip { display:block; }
  .swapinfo .tooltip b { color:#eee; }
  .swapdel {
    position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%;
    background:rgba(140,0,0,.8); color:#fff; font-size:11px; line-height:14px; text-align:center;
    cursor:pointer; opacity:0; transition:opacity .15s;
  }
  .swapthumb:hover .swapdel { opacity:1; }
  .spin { font-size:11px; color:#888; }
  #lightbox { position:fixed; inset:0; background:rgba(0,0,0,.85); display:none; align-items:center; justify-content:center; z-index:50; cursor:zoom-out; }
  #lightbox img { max-width:92vw; max-height:92vh; border-radius:6px; }
  #lightboxDownload {
    position:absolute; top:20px; right:20px; cursor:pointer; text-decoration:none;
    background:#2e7d32; border:1px solid #2e7d32; color:#eee; border-radius:6px;
    padding:8px 14px; font-size:13px; font-weight:600; font-family:inherit;
  }
  #lightboxDownload:hover { background:#357a38; }
  #lightboxParams {
    position:absolute; bottom:20px; left:20px; right:20px; max-width:800px; margin:0 auto;
    background:rgba(20,20,20,.9); border:1px solid #444; border-radius:8px; padding:10px 14px;
    font-size:12px; color:#ccc; line-height:1.5; display:none;
  }
  #lightboxParams b { color:#eee; }

  /* mask paint overlay view */
  #paintView { position:fixed; inset:0; background:#1b1b1f; display:none; z-index:40; flex-direction:column; }
  #paintTop { display:flex; align-items:center; gap:10px; padding:10px 16px; background:#222; border-bottom:1px solid #333; }
  #paintBody { flex:1; display:flex; overflow:hidden; }
  #paintSidebar { width:240px; flex-shrink:0; padding:16px; background:#222; border-right:1px solid #333; display:flex; flex-direction:column; gap:12px; overflow-y:auto; }
  #paintCanvasWrap { flex:1; overflow:auto; background:#111 repeating-conic-gradient(#151515 0% 25%, #111 0% 50%) 50% / 24px 24px; padding:30px; display:flex; align-items:flex-start; justify-content:center; }
  #paintStage { position:relative; }
  #paintBase, #paintPaint { position:absolute; top:0; left:0; }
  #paintPaint { opacity:0.55; cursor:none; }
  #paintCursor { position:fixed; pointer-events:none; border:1.5px dashed #fff; border-radius:50%; transform:translate(-50%,-50%); display:none; z-index:60; }
  .row2 { display:flex; gap:8px; }
  .row2 > * { flex:1; }

  /* interactive crop view -- drag/resize a square selection over the
     original photo, Photoshop-crop-tool style */
  #cropView { position:fixed; inset:0; background:#1b1b1f; display:none; z-index:40; flex-direction:column; }
  #cropTop { display:flex; align-items:center; gap:10px; padding:10px 16px; background:#222; border-bottom:1px solid #333; }
  #cropCanvasWrap { flex:1; overflow:auto; background:#111; padding:30px; display:flex; align-items:flex-start; justify-content:center; }
  #cropStage { position:relative; }
  #cropImg { display:block; user-select:none; -webkit-user-drag:none; }
  #cropBox { position:absolute; border:2px solid #4a6cf7; box-shadow:0 0 0 2000px rgba(0,0,0,.6); cursor:move; }
  #cropBox .handle { position:absolute; width:16px; height:16px; background:#4a6cf7; border:2px solid #fff; border-radius:50%; right:-9px; bottom:-9px; cursor:nwse-resize; }
</style>
</head>
<body>
<header>
  <h1>Pipeline</h1>
  <select id="project"></select>
  <button id="uploadBtn">+ Add photo</button>
  <input type="file" id="fileInput" accept="image/*" multiple style="display:none">
  <span style="flex:1"></span>
  <span id="uploadStatus" style="font-size:11px;color:#8bc34a;"></span>
  <span style="font-size:11px;color:#777;">Crop &rarr; Upscale &rarr; Mask &rarr; Ideogram &middot; Cmd/Ctrl+V to paste a photo</span>
</header>
<div id="refBar">
  <strong style="font-size:12px;">Ideogram character reference:</strong>
  <img id="refThumb" style="display:none">
  <span id="refStatus" style="font-size:11px;"></span>
  <button id="setReferenceBtn">Upload reference</button>
  <input type="file" id="refFileInput" accept="image/*" style="display:none">
  <button id="paintReferenceMaskBtn">Paint reference mask (optional)</button>
  <span id="refMaskStatus" style="font-size:11px;color:#777;"></span>
</div>
<div id="rows"></div>
<div id="lightbox">
  <img id="lightboxImg">
  <a id="lightboxDownload" download>Download</a>
  <div id="lightboxParams"></div>
</div>

<div id="paintView">
  <div id="paintTop">
    <button id="paintBack">&larr; Back to pipeline</button>
    <strong id="paintTitle" style="font-size:13px;"></strong>
    <span style="flex:1"></span>
    <button id="paintSave" class="primary">Save mask</button>
    <span id="paintStatus" style="font-size:11px;color:#8bc34a;"></span>
  </div>
  <div id="paintBody">
    <div id="paintSidebar">
      <div class="row2">
        <button id="toolPaint" class="active">Paint</button>
        <button id="toolErase">Erase</button>
      </div>
      <label style="font-size:12px;">Brush size: <span id="sizeLabel">300</span>px<br>
        <input type="range" id="size" min="100" max="1000" value="300" style="width:100%"></label>
      <label style="font-size:12px;">Zoom: <span id="zoomLabel">100</span>%<br>
        <input type="range" id="zoom" min="5" max="300" value="100" style="width:100%"></label>
      <div class="row2">
        <button id="undo">Undo</button>
        <button id="clear">Clear all</button>
      </div>
      <p id="paintHint" style="font-size:11px;color:#888;">Red = will be regenerated. Drag to paint/erase. <kbd>X</kbd> toggles eraser.</p>
    </div>
    <div id="paintCanvasWrap">
      <div id="paintStage">
        <canvas id="paintBase"></canvas>
        <canvas id="paintPaint"></canvas>
      </div>
    </div>
  </div>
</div>
<div id="paintCursor"></div>

<div id="cropView">
  <div id="cropTop">
    <button id="cropBack">&larr; Back to pipeline</button>
    <strong id="cropTitle" style="font-size:13px;"></strong>
    <span style="flex:1"></span>
    <button id="cropConfirm" class="primary">Confirm crop</button>
    <span id="cropStatus" style="font-size:11px;color:#8bc34a;"></span>
  </div>
  <div id="cropCanvasWrap">
    <div id="cropStage">
      <img id="cropImg">
      <div id="cropBox"><div class="handle"></div></div>
    </div>
  </div>
</div>

<script>
let currentProject = null;
let state = [];

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  });
  children.forEach(c => c && e.appendChild(c));
  return e;
}

function imgUrl(name) { return `/images/${encodeURIComponent(name)}?project=${encodeURIComponent(currentProject)}`; }

function openLightbox(name) {
  document.getElementById('lightboxImg').src = imgUrl(name);
  const dl = document.getElementById('lightboxDownload');
  dl.href = imgUrl(name);
  dl.download = name;
  document.getElementById('lightbox').style.display = 'flex';

  const paramsEl = document.getElementById('lightboxParams');
  paramsEl.style.display = 'none';
  paramsEl.innerHTML = '';
  if (/_ideogram_\d+\.jpe?g$/i.test(name)) {
    const qs = new URLSearchParams({ project: currentProject, file: name });
    fetch(`/swap-params?${qs}`).then(r => r.json()).then(p => {
      if (!p.ok) return;
      paramsEl.innerHTML = `<b>Prompt:</b> ${p.prompt}`;
      paramsEl.style.display = 'block';
    });
  }
}
document.getElementById('lightboxDownload').onclick = (e) => e.stopPropagation();
document.getElementById('lightboxParams').onclick = (e) => e.stopPropagation();
document.getElementById('lightbox').onclick = () => { document.getElementById('lightbox').style.display = 'none'; };

function refreshProjects() {
  fetch('/projects').then(r => r.json()).then(labels => {
    const sel = document.getElementById('project');
    sel.innerHTML = labels.map(l => `<option value="${l}">${l}</option>`).join('');
    currentProject = labels[0] || null;
    sel.value = currentProject;
    refreshState();
  });
  refreshReference();
}
document.getElementById('project').onchange = (e) => { currentProject = e.target.value; refreshState(); };

/* ---- Ideogram character reference -- one global photo + optional mask ---- */
const refThumb = document.getElementById('refThumb');
const refStatus = document.getElementById('refStatus');
const refMaskStatus = document.getElementById('refMaskStatus');
function refreshReference() {
  return fetch('/character-reference-status').then(r => r.json()).then(j => {
    if (j.has_reference) {
      refThumb.src = `/character-reference?t=${Date.now()}`;
      refThumb.style.display = '';
      refStatus.textContent = '';
    } else {
      refThumb.style.display = 'none';
      refStatus.textContent = 'No reference photo set';
      refStatus.style.color = '#e57373';
    }
    refMaskStatus.textContent = j.has_reference_mask ? 'Mask set' : 'No mask (using whole photo)';
  });
}
const refFileInput = document.getElementById('refFileInput');
refFileInput.onchange = async () => {
  const file = refFileInput.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  await fetch('/upload-character-reference', { method: 'POST', body: buf });
  refFileInput.value = '';
  await refreshReference();
};
document.getElementById('setReferenceBtn').onclick = () => refFileInput.click();
refThumb.onclick = () => refFileInput.click();
document.getElementById('paintReferenceMaskBtn').onclick = () => {
  if (!refThumb.src || refThumb.style.display === 'none') { alert('Upload a reference photo first.'); return; }
  openReferencePaint();
};

function refreshState() {
  if (!currentProject) return;
  fetch(`/state?project=${encodeURIComponent(currentProject)}`).then(r => r.json()).then(rows => {
    state = rows;
    render();
  });
}

function resultList(names) {
  const wrap = el('div', { class: 'swaplist' });
  (names || []).forEach(name => {
    const img = el('img', {});
    img.src = imgUrl(name);
    img.onclick = () => openLightbox(name);
    const info = el('div', { class: 'swapinfo', text: 'i' });
    const tooltip = el('div', { class: 'tooltip' });
    info.appendChild(tooltip);
    const del = el('div', { class: 'swapdel', text: '×' });
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete this result (${name})? This can't be undone.`)) return;
      const qs = new URLSearchParams({ project: currentProject, file: name });
      const r = await fetch(`/remove-result?${qs}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { alert(j.error || 'delete failed'); return; }
      await refreshState();
    };
    const thumb = el('div', { class: 'swapthumb' }, img, info, del);
    wrap.appendChild(thumb);
    const qs = new URLSearchParams({ project: currentProject, file: name });
    fetch(`/swap-params?${qs}`).then(r => r.json()).then(p => {
      if (!p.ok) return;
      tooltip.innerHTML = `<b>Prompt:</b> ${p.prompt}`;
      thumb.classList.add('has-info');
    });
  });
  return wrap;
}

function stageThumb(name, label) {
  if (!name) return el('div', { class: 'placeholder', text: 'none yet' });
  const img = el('img', {});
  img.src = imgUrl(name);
  img.onclick = () => openLightbox(name);
  return img;
}

let rowSettings = {};
function captureRowSettings() {
  state.forEach(row => {
    const prev = rowSettings[row.stem] || {};
    const get = (id, fallback) => {
      const node = document.getElementById(id);
      return node ? node.value : fallback;
    };
    rowSettings[row.stem] = {
      sel: get('sel_' + row.stem, prev.sel ?? 'largest'),
      bias: get('bias_' + row.stem, prev.bias ?? '0.15'),
      target: get('target_' + row.stem, prev.target ?? '4200'),
    };
  });
}

function render() {
  captureRowSettings();
  const rows = document.getElementById('rows');
  rows.innerHTML = '';
  state.forEach(row => {
    const settings = rowSettings[row.stem];
    const cropCell = el('div', { class: 'stage' },
      el('h3', { text: '1. Crop' }),
      stageThumb(row.crop),
      controlsBlock(
        [labeled('Face', select('sel_' + row.stem, ['largest', 'center', '0', '-1'], settings.sel)),
         labeled('Head room', input('bias_' + row.stem, settings.bias, 46))],
        [runBtn(() => runCrop(row), row.crop ? 'Re-crop' : 'Crop'),
         adjustBtn(() => openCrop(row))],
      ),
    );

    const upscaleCell = el('div', { class: 'stage' },
      el('h3', { text: '2. Upscale' }),
      stageThumb(row.upscale),
      controlsBlock(
        [labeled('Target', input('target_' + row.stem, settings.target, 56))],
        [runBtn(() => runUpscale(row), row.upscale ? 'Re-upscale' : 'Upscale', !row.crop)],
      ),
    );

    const maskCell = el('div', { class: 'stage' },
      el('h3', { text: '3. Mask' }),
      stageThumb(row.maskPreview),
      controlsBlock(
        [],
        [runBtn(() => openPaint(row), row.mask ? 'Edit mask' : 'Paint mask', false),
         runBtn(() => openAutoMask(row), 'Auto mask', false)],
      ),
    );

    const ideogramWrap = resultList(row.ideograms);
    const ideogramCell = el('div', { class: 'stage' },
      el('h3', { text: '4. Ideogram (character ref)' }),
      (row.ideograms && row.ideograms.length) ? ideogramWrap : el('div', { class: 'placeholder', text: 'none yet' }),
      controlsBlock(
        [labeled('Expression (optional)', input('expression_' + row.stem, '', 160))],
        [runBtn(() => runIdeogram(row), 'Run Ideogram', !row.mask)],
      ),
    );

    const thumb = el('img', {});
    thumb.src = imgUrl(row.original);
    thumb.onclick = () => openLightbox(row.original);
    const thumbWrap = el('div', { class: 'rowthumb' }, thumb);
    rows.appendChild(el('div', { class: 'row' },
      el('div', { class: 'rowlabel' }, thumbWrap, document.createTextNode(row.original), removeBtn(row)),
      cropCell, upscaleCell, maskCell, ideogramCell,
    ));
  });
}

function labeled(text, node) {
  return el('label', { style: 'font-size:10px;color:#999;display:flex;flex-direction:column;gap:2px;' },
    document.createTextNode(text), node);
}
function select(id, options, selected) {
  const s = el('select', { id });
  options.forEach(o => s.appendChild(el('option', { value: o, text: o })));
  if (selected !== undefined && options.includes(selected)) s.value = selected;
  return s;
}
function input(id, value, width) {
  return el('input', { id, value, style: `width:${width}px` });
}
function controlsBlock(inputs, actions) {
  return el('div', { class: 'controls' },
    el('div', { class: 'controls-inputs' }, ...inputs),
    el('div', { class: 'controls-actions' }, ...actions),
  );
}
function runBtn(fn, label, disabled) {
  const b = el('button', { text: label });
  if (disabled) b.disabled = true;
  b.onclick = async () => {
    b.disabled = true;
    const original = b.textContent;
    b.textContent = '...';
    try { await fn(); } catch (e) { alert(e.message || e); }
    b.textContent = original;
    b.disabled = false;
  };
  return b;
}
function adjustBtn(onClick) {
  const b = el('button', { text: 'Adjust...' });
  b.onclick = onClick;
  return b;
}
function removeBtn(row) {
  const b = el('button', { text: 'Remove photo', style: 'color:#f88;border-color:#633;' });
  b.onclick = async () => {
    if (!confirm(`Remove "${row.original}" and everything generated from it? This can't be undone.`)) return;
    b.disabled = true;
    try {
      const qs = new URLSearchParams({ project: currentProject, original: row.original });
      const r = await fetch(`/remove?${qs}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'remove failed');
      await refreshState();
    } catch (e) { alert(e.message || e); b.disabled = false; }
  };
  return b;
}

async function runCrop(row) {
  const select = document.getElementById('sel_' + row.stem).value;
  const bias = document.getElementById('bias_' + row.stem).value;
  const qs = new URLSearchParams({ project: currentProject, stem: row.stem, original: row.original, select, head_bias: bias });
  const r = await fetch(`/run/crop?${qs}`, { method: 'POST' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'crop failed');
  await refreshState();
}

async function runUpscale(row) {
  const target = document.getElementById('target_' + row.stem).value;
  const qs = new URLSearchParams({ project: currentProject, stem: row.stem, target });
  const r = await fetch(`/run/upscale?${qs}`, { method: 'POST' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'upscale failed');
  await refreshState();
}

async function runIdeogram(row) {
  const expression = document.getElementById('expression_' + row.stem).value.trim();
  const qs = new URLSearchParams({ project: currentProject, stem: row.stem, expression });
  const r = await fetch(`/run/ideogram?${qs}`, { method: 'POST' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'ideogram run failed');
  await refreshState();
}

/* ---- mask paint view (operates on the stage-2 upscaled image) ---- */
const paintView = document.getElementById('paintView');
const paintBase = document.getElementById('paintBase');
const paintPaint = document.getElementById('paintPaint');
const paintBaseCtx = paintBase.getContext('2d');
const paintCtx = paintPaint.getContext('2d', { willReadFrequently: true });
const paintCursor = document.getElementById('paintCursor');
let paintTool = 'paint', paintBrush = 300, paintDrawing = false, plx = 0, ply = 0, paintHistory = [];
let paintRow = null;
let paintMode = 'target'; // 'target' (per-photo _3mask.png) or 'reference' (global reference mask)
let paintBaseImage = null; // which stage's image was actually painted on, for 'target' mode

function loadPaintCanvas(imageUrl, maskUrl) {
  const img = new Image();
  img.onload = () => {
    const w = img.naturalWidth, h = img.naturalHeight;
    paintBase.width = paintPaint.width = w;
    paintBase.height = paintPaint.height = h;
    paintBaseCtx.drawImage(img, 0, 0);
    paintCtx.clearRect(0, 0, w, h);
    paintHistory = [];

    if (maskUrl) {
      fetch(maskUrl).then(r => {
        if (!r.ok) return r.json().then(j => { throw new Error(j.error || 'failed to load mask'); });
        return r.blob();
      }).then(mblob => {
        const maskImg = new Image();
        maskImg.onload = () => {
          const off = document.createElement('canvas');
          off.width = w; off.height = h;
          const octx = off.getContext('2d');
          octx.drawImage(maskImg, 0, 0, w, h);
          const data = octx.getImageData(0, 0, w, h);
          const out = paintCtx.createImageData(w, h);
          for (let i = 0; i < data.data.length; i += 4) {
            if (data.data[i] > 128) { out.data[i]=255; out.data[i+1]=0; out.data[i+2]=0; out.data[i+3]=255; }
          }
          paintCtx.putImageData(out, 0, 0);
          savePaintHistory();
          fitPaintZoom();
        };
        maskImg.src = URL.createObjectURL(mblob);
      }).catch(e => {
        alert(e.message || e);
        savePaintHistory();
        fitPaintZoom();
      });
    } else {
      savePaintHistory();
      fitPaintZoom();
    }
  };
  img.src = imageUrl;
}

function openPaint(row, maskUrlOverride) {
  paintMode = 'target';
  paintRow = row;
  // Masking no longer requires an upscale first -- paint against whichever
  // stage is furthest along (every row always has at least the original).
  paintBaseImage = row.upscale || row.crop || row.original;
  document.getElementById('paintTitle').textContent = row.original;
  document.getElementById('paintStatus').textContent = '';
  document.getElementById('paintHint').innerHTML = 'Red = will be regenerated. Drag to paint/erase. <kbd>X</kbd> toggles eraser.';
  paintView.style.display = 'flex';
  const maskUrl = maskUrlOverride !== undefined ? maskUrlOverride : (row.mask ? imgUrl(row.mask) : null);
  loadPaintCanvas(imgUrl(paintBaseImage), maskUrl);
}

function openAutoMask(row) {
  // Face-detection-based starting mask (ellipse over face+hair + a neck
  // rectangle, see face_fal.build_head_hair_mask) loaded into the same
  // paint canvas as a regular mask edit -- touch it up and Save like any
  // hand-painted mask, this just saves painting the common shape by hand.
  const base = row.upscale || row.crop || row.original;
  const qs = new URLSearchParams({ project: currentProject, image: base });
  openPaint(row, `/suggest-mask?${qs}`);
}

function openReferencePaint() {
  paintMode = 'reference';
  document.getElementById('paintTitle').textContent = 'Character reference mask';
  document.getElementById('paintStatus').textContent = '';
  document.getElementById('paintHint').innerHTML = 'Red = the character to extract (leave unpainted to use the whole photo). Drag to paint/erase. <kbd>X</kbd> toggles eraser.';
  paintView.style.display = 'flex';
  const hasMask = refMaskStatus.textContent === 'Mask set';
  loadPaintCanvas(refThumb.src, hasMask ? `/character-reference-mask?t=${Date.now()}` : null);
}

function fitPaintZoom() {
  // Default to showing the whole image on open -- a 4200px square is
  // several times wider than any screen, so opening at 100% zoom (1 image
  // pixel per CSS pixel) left most of it scrolled off-screen with no
  // indication there was more to see.
  const wrap = document.getElementById('paintCanvasWrap');
  const availW = wrap.clientWidth - 60, availH = wrap.clientHeight - 60;
  const scale = Math.min(availW / paintPaint.width, availH / paintPaint.height, 1);
  const pct = Math.max(5, Math.min(300, Math.round(scale * 100)));
  document.getElementById('zoom').value = pct;
  applyPaintZoom();
}
document.getElementById('paintBack').onclick = () => { paintView.style.display = 'none'; };

/* ---- interactive crop view -- drag/resize a square over the original ---- */
const cropView = document.getElementById('cropView');
const cropImg = document.getElementById('cropImg');
const cropStage = document.getElementById('cropStage');
const cropBox = document.getElementById('cropBox');
let cropRow = null, cropScale = 1, cropNatW = 0, cropNatH = 0;

function openCrop(row) {
  cropRow = row;
  document.getElementById('cropTitle').textContent = row.original;
  document.getElementById('cropStatus').textContent = '';
  cropView.style.display = 'flex';

  const select = (document.getElementById('sel_' + row.stem) || {}).value || 'largest';
  const headBias = (document.getElementById('bias_' + row.stem) || {}).value || '0.15';

  cropImg.onload = () => {
    cropNatW = cropImg.naturalWidth;
    cropNatH = cropImg.naturalHeight;
    const wrap = document.getElementById('cropCanvasWrap');
    const availW = wrap.clientWidth - 60, availH = wrap.clientHeight - 60;
    cropScale = Math.min(availW / cropNatW, availH / cropNatH, 1);
    const dispW = cropNatW * cropScale, dispH = cropNatH * cropScale;
    cropImg.style.width = dispW + 'px';
    cropImg.style.height = dispH + 'px';
    cropStage.style.width = dispW + 'px';
    cropStage.style.height = dispH + 'px';

    const qs = new URLSearchParams({ project: currentProject, original: row.original, select, head_bias: headBias });
    fetch(`/suggest-crop?${qs}`).then(r => r.json()).then((box) => {
      setCropBox(box.left * cropScale, box.top * cropScale, box.side * cropScale);
    });
  };
  cropImg.src = imgUrl(row.original);
}
document.getElementById('cropBack').onclick = () => { cropView.style.display = 'none'; };

function setCropBox(left, top, size) {
  cropBox.style.left = left + 'px';
  cropBox.style.top = top + 'px';
  cropBox.style.width = size + 'px';
  cropBox.style.height = size + 'px';
}
function clampCropBox(left, top, size) {
  const maxSize = Math.min(cropNatW, cropNatH) * cropScale;
  size = Math.max(20, Math.min(size, maxSize));
  left = Math.max(0, Math.min(left, cropNatW * cropScale - size));
  top = Math.max(0, Math.min(top, cropNatH * cropScale - size));
  return { left, top, size };
}

let cropDragMode = null, cropDragStartX = 0, cropDragStartY = 0, cropStartLeft = 0, cropStartTop = 0, cropStartSize = 0;

cropBox.addEventListener('pointerdown', (e) => {
  cropDragMode = e.target.classList.contains('handle') ? 'resize' : 'move';
  cropDragStartX = e.clientX; cropDragStartY = e.clientY;
  cropStartLeft = parseFloat(cropBox.style.left); cropStartTop = parseFloat(cropBox.style.top); cropStartSize = parseFloat(cropBox.style.width);
  e.stopPropagation();
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => {
  if (!cropDragMode) return;
  const dx = e.clientX - cropDragStartX, dy = e.clientY - cropDragStartY;
  if (cropDragMode === 'move') {
    const { left, top, size } = clampCropBox(cropStartLeft + dx, cropStartTop + dy, cropStartSize);
    setCropBox(left, top, size);
  } else {
    const delta = Math.max(dx, dy);
    const { left, top, size } = clampCropBox(cropStartLeft, cropStartTop, cropStartSize + delta);
    setCropBox(left, top, size);
  }
});
window.addEventListener('pointerup', () => { cropDragMode = null; });

document.getElementById('cropConfirm').onclick = async () => {
  const status = document.getElementById('cropStatus');
  status.textContent = 'Saving...';
  const left = Math.round(parseFloat(cropBox.style.left) / cropScale);
  const top = Math.round(parseFloat(cropBox.style.top) / cropScale);
  const side = Math.round(parseFloat(cropBox.style.width) / cropScale);
  const qs = new URLSearchParams({ project: currentProject, stem: cropRow.stem, original: cropRow.original, left, top, side });
  const r = await fetch(`/run/crop?${qs}`, { method: 'POST' });
  const j = await r.json();
  if (!j.ok) { status.textContent = j.error || 'Crop failed.'; return; }
  status.textContent = 'Saved.';
  await refreshState();
  cropView.style.display = 'none';
};

function savePaintHistory() {
  paintHistory.push(paintCtx.getImageData(0, 0, paintPaint.width, paintPaint.height));
  if (paintHistory.length > 40) paintHistory.shift();
}
function paintPos(e) {
  const rect = paintPaint.getBoundingClientRect();
  return { x: (e.clientX - rect.left) * (paintPaint.width / rect.width), y: (e.clientY - rect.top) * (paintPaint.height / rect.height) };
}
function paintStrokeTo(x, y) {
  paintCtx.lineCap = 'round'; paintCtx.lineJoin = 'round'; paintCtx.lineWidth = paintBrush;
  paintCtx.globalCompositeOperation = paintTool === 'erase' ? 'destination-out' : 'source-over';
  paintCtx.strokeStyle = 'rgba(255,0,0,1)';
  paintCtx.beginPath(); paintCtx.moveTo(plx, ply); paintCtx.lineTo(x, y); paintCtx.stroke();
  paintCtx.beginPath(); paintCtx.arc(x, y, paintBrush / 2, 0, Math.PI * 2); paintCtx.fillStyle = 'rgba(255,0,0,1)'; paintCtx.fill();
}
paintPaint.addEventListener('pointerdown', (e) => { paintDrawing = true; const p = paintPos(e); plx = p.x; ply = p.y; paintStrokeTo(p.x, p.y); });
window.addEventListener('pointermove', (e) => {
  if (paintView.style.display !== 'flex') return;
  const z = parseFloat(document.getElementById('zoom').value) / 100;
  paintCursor.style.left = e.clientX + 'px'; paintCursor.style.top = e.clientY + 'px';
  paintCursor.style.width = (paintBrush * z) + 'px'; paintCursor.style.height = (paintBrush * z) + 'px';
  if (!paintDrawing) return;
  const p = paintPos(e); paintStrokeTo(p.x, p.y); plx = p.x; ply = p.y;
});
window.addEventListener('pointerup', () => { if (paintDrawing) savePaintHistory(); paintDrawing = false; });
paintPaint.addEventListener('pointerleave', () => { paintCursor.style.display = 'none'; });
paintPaint.addEventListener('pointerenter', () => { paintCursor.style.display = 'block'; });

document.getElementById('toolPaint').onclick = () => setPaintTool('paint');
document.getElementById('toolErase').onclick = () => setPaintTool('erase');
function setPaintTool(t) {
  paintTool = t;
  document.getElementById('toolPaint').classList.toggle('active', t === 'paint');
  document.getElementById('toolErase').classList.toggle('active', t === 'erase');
}
document.getElementById('size').oninput = (e) => { paintBrush = parseInt(e.target.value, 10); document.getElementById('sizeLabel').textContent = paintBrush; };
document.getElementById('zoom').oninput = applyPaintZoom;
function applyPaintZoom() {
  const z = parseFloat(document.getElementById('zoom').value) / 100;
  document.getElementById('zoomLabel').textContent = Math.round(z * 100);
  const w = paintPaint.width * z, h = paintPaint.height * z;
  document.getElementById('paintStage').style.width = w + 'px';
  document.getElementById('paintStage').style.height = h + 'px';
  [paintBase, paintPaint].forEach(c => { c.style.width = w + 'px'; c.style.height = h + 'px'; });
}
document.getElementById('undo').onclick = () => {
  if (paintHistory.length <= 1) return;
  paintHistory.pop();
  paintCtx.putImageData(paintHistory[paintHistory.length - 1], 0, 0);
};
document.getElementById('clear').onclick = () => { paintCtx.clearRect(0, 0, paintPaint.width, paintPaint.height); savePaintHistory(); };
window.addEventListener('keydown', (e) => {
  if (paintView.style.display !== 'flex') return;
  if (e.repeat) return;
  if (e.key === 'x' || e.key === 'X') setPaintTool(paintTool === 'erase' ? 'paint' : 'erase');
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); document.getElementById('undo').click(); }
});

document.getElementById('paintSave').onclick = () => {
  const w = paintPaint.width, h = paintPaint.height;
  const data = paintCtx.getImageData(0, 0, w, h);
  const out = paintCtx.createImageData(w, h);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = data.data[i + 3] > 0 ? 255 : 0;
    out.data[i] = v; out.data[i+1] = v; out.data[i+2] = v; out.data[i+3] = 255;
  }
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  off.getContext('2d').putImageData(out, 0, 0);
  off.toBlob((blob) => {
    const [url, after] = paintMode === 'reference'
      ? ['/save-reference-mask', refreshReference]
      : [`/save-mask?${new URLSearchParams({ project: currentProject, stem: paintRow.stem, image: paintBaseImage })}`, refreshState];
    fetch(url, { method: 'POST', body: blob }).then(r => r.json()).then((j) => {
      document.getElementById('paintStatus').textContent = j.ok ? 'Saved.' : (j.error || 'Save failed.');
      if (j.ok) {
        after();
        paintView.style.display = 'none';
      }
    });
  }, 'image/png');
};

function uploadFile(file) {
  if (!currentProject || !file) return Promise.resolve();
  const status = document.getElementById('uploadStatus');
  status.textContent = `Uploading ${file.name}...`;
  return file.arrayBuffer().then((buf) => {
    const qs = new URLSearchParams({ project: currentProject, name: file.name || 'pasted.png' });
    return fetch(`/upload?${qs}`, { method: 'POST', body: buf });
  }).then((r) => r.json()).then((j) => {
    status.textContent = j.ok ? `Added ${j.file}.` : 'Upload failed.';
    return refreshState();
  });
}

document.getElementById('uploadBtn').onclick = () => document.getElementById('fileInput').click();
document.getElementById('fileInput').onchange = async (e) => {
  for (const file of e.target.files) await uploadFile(file);
  e.target.value = '';
};

window.addEventListener('paste', (e) => {
  // Only on the main pipeline view -- pasting while the crop/mask overlays
  // are open isn't "add a new photo", it'd be ambiguous with those tools'
  // own interactions.
  if (paintView.style.display === 'flex' || cropView.style.display === 'flex') return;
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find((i) => i.type.startsWith('image/'));
  if (!imageItem) return;
  uploadFile(imageItem.getAsFile());
});

refreshProjects();
</script>
</body>
</html>
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--project", action="append", required=True,
        help="Label=images_dir[,out_dir] -- repeatable, adds a dropdown entry per project",
    )
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    # FAL_KEY is already checked at face_fal's own import time (above this
    # point already, if it's missing). IDEOGRAM_API_KEY has no such guard --
    # it's only needed for the Ideogram engine and already has its own clear
    # error at call time (see ideogram_character_swap).
    projects = parse_projects(args.project)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(projects))
    url = f"http://127.0.0.1:{args.port}/"
    for label, (images_dir, out_dir) in projects.items():
        print(f"{label}: images from {images_dir}, writing to {out_dir}")
    print(f"Serving at {url}")
    subprocess.run(["open", url], check=False)
    server.serve_forever()


if __name__ == "__main__":
    main()
