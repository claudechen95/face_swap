"""CSV in/out, slugging, and per-lead state for the outreach pipeline."""

from __future__ import annotations

import csv
import json
import re
import threading
from pathlib import Path
from typing import Optional

from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
LEADS_CSV = ROOT / "data" / "leads.csv"
STATE_JSON = ROOT / "state.json"
WORK_DIR = ROOT / "work"

NOT_CONTACTED = "Not contacted"

_SLUG_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_state_lock = threading.Lock()


def slugify(name: str) -> str:
    slug = _SLUG_NON_ALNUM.sub("-", name.strip().lower()).strip("-")
    return slug or "lead"


class Lead(BaseModel):
    row: int
    name: str
    tier: str
    platform: str
    handle: str
    url: str
    contact_found: str
    status: str
    slug: str

    @property
    def email(self) -> Optional[str]:
        """`Contact found` sometimes holds an email, sometimes a URL/note - only
        treat it as an email if it looks like one."""
        value = self.contact_found.strip()
        if "@" in value and " " not in value and "." in value.split("@", 1)[1]:
            return value
        return None

    @property
    def first_name(self) -> str:
        return self.name.split()[0] if self.name.split() else self.name

    @property
    def work_dir(self) -> Path:
        return WORK_DIR / self.slug


def load_leads(csv_path: Path = LEADS_CSV) -> list[Lead]:
    leads: list[Lead] = []
    with csv_path.open(newline="", encoding="utf-8") as f:
        for raw in csv.DictReader(f):
            name = (raw.get("Name") or "").strip()
            if not name:
                continue
            leads.append(
                Lead(
                    row=int(raw.get("#") or 0),
                    name=name,
                    tier=(raw.get("Tier") or "").strip(),
                    platform=(raw.get("Platform") or "").strip(),
                    handle=(raw.get("Handle") or "").strip(),
                    url=(raw.get("URL") or "").strip(),
                    contact_found=(raw.get("Contact found") or "").strip(),
                    status=(raw.get("Status") or "").strip() or NOT_CONTACTED,
                    slug=slugify(name),
                )
            )
    return leads


def filter_leads(
    leads: list[Lead],
    tier: Optional[str] = None,
    limit: Optional[int] = None,
    only: Optional[str] = None,
) -> list[Lead]:
    """Applies the pipeline's standard filters. Always drops anything whose
    Status isn't 'Not contacted', per SPEC.md section 2."""
    result = [lead for lead in leads if lead.status == NOT_CONTACTED]
    if only:
        result = [lead for lead in result if lead.slug == only]
    if tier:
        result = [lead for lead in result if lead.tier.upper() == tier.upper()]
    if limit is not None:
        result = result[:limit]
    return result


# --- state.json -------------------------------------------------------------
#
# Shape: {"<slug>": {"stages": {"<stage>": {"status": "...", "at": "...", ...}}}}
# One file, one lock, read-modify-write on every call so concurrent `outreach`
# invocations for different leads don't clobber each other's stage records.


def _read_state(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _write_state(state: dict, path: Path) -> None:
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, sort_keys=True)
    tmp.replace(path)


def get_lead_state(slug: str, path: Path = STATE_JSON) -> dict:
    with _state_lock:
        return _read_state(path).get(slug, {"stages": {}})


def get_stage(slug: str, stage: str, path: Path = STATE_JSON) -> Optional[dict]:
    return get_lead_state(slug, path).get("stages", {}).get(stage)


def set_stage(slug: str, stage: str, timestamp: str, **fields) -> None:
    """Records that `stage` ran for `slug`. `timestamp` (ISO string) is passed
    in by the caller rather than read here, so every lead processed within one
    `outreach` command invocation gets the same stamp and this module stays a
    pure function of its arguments for testing."""
    with _state_lock:
        state = _read_state(STATE_JSON)
        lead_state = state.setdefault(slug, {"stages": {}})
        lead_state["stages"][stage] = {"at": timestamp, **fields}
        _write_state(state, STATE_JSON)
