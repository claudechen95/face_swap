"""Static review page -> approved.csv (SPEC.md 3.5). No server: the page
itself builds approved.csv client-side via a download button; the user saves
it to work/approved.csv before running `outreach draft`."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

from .drafts import render_email
from .leads import Lead, ROOT, WORK_DIR, get_stage

TEMPLATES_DIR = ROOT / "templates"
REVIEW_HTML = WORK_DIR / "review.html"
APPROVED_CSV = WORK_DIR / "approved.csv"

_STAGE_LABELS = {
    "needs_manual_photo": "Needs a manually-dropped photo (IG/TikTok, not scraped)",
    "no_usable_photo": "No candidate photo passed the face quality gate",
    "generation_failed": "Fewer than 2 swaps survived the identity gate",
}


def _blocked_reason(slug: str) -> str:
    for stage in ("fetch", "filter", "generate", "grid"):
        info = get_stage(slug, stage)
        if info and info.get("status") not in ("ok", None):
            return info.get("error") or _STAGE_LABELS.get(info["status"], info["status"])
    return "not yet processed"


def _lead_card(lead: Lead, settings) -> dict:
    grid_path = lead.work_dir / "grid.jpg"
    if not grid_path.exists():
        return {
            "slug": lead.slug,
            "name": lead.name,
            "tier": lead.tier,
            "blocked": True,
            "blocked_reason": _blocked_reason(lead.slug),
        }

    meta_path = lead.work_dir / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    generate_stage = get_stage(lead.slug, "generate") or {}
    similarities = generate_stage.get("survived", {})
    filter_stage = get_stage(lead.slug, "filter") or {}

    subject, body = render_email(lead, settings, meta)
    return {
        "slug": lead.slug,
        "name": lead.name,
        "tier": lead.tier,
        "blocked": False,
        "grid_rel": str(grid_path.relative_to(WORK_DIR)),
        "similarities": similarities,
        "email_subject": subject,
        "email_body": body,
        "has_email": lead.email is not None,
        # video_thumbnail means no avatar/manual photo passed the quality gate,
        # so the source is an auto-extracted frame - these are frequently
        # mid-sentence/exaggerated clickbait expressions rather than an
        # ordinary photo (see faces.py's _is_deliberately_chosen). Flagged here
        # instead of trying to auto-detect "normal expression", which isn't
        # reliable without a dedicated model - a human glance at the grid is.
        "source_is_thumbnail": filter_stage.get("source_kind") == "video_thumbnail",
    }


def build_review_page(leads: list[Lead], settings) -> Path:
    cards = [_lead_card(lead, settings) for lead in leads]
    env = Environment(loader=FileSystemLoader(TEMPLATES_DIR))
    template = env.get_template("review.html.j2")
    html = template.render(cards=cards)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    REVIEW_HTML.write_text(html)
    return REVIEW_HTML


def load_approved(path: Path = APPROVED_CSV) -> dict[str, str]:
    """Reads approved.csv (columns: slug, approved, note). Returns
    {slug: note} for every row marked approved."""
    if not path.exists():
        return {}
    approved = {}
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            if (row.get("approved") or "").strip().lower() in ("true", "1", "yes"):
                approved[row["slug"].strip()] = (row.get("note") or "").strip()
    return approved
