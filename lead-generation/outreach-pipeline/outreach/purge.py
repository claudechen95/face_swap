"""Data deletion (SPEC.md 3.7). Embeddings are never stored anywhere but
work/<slug>/, so deleting that directory is the entire deletion story."""

from __future__ import annotations

import shutil
from datetime import datetime, timedelta, timezone

from .leads import STATE_JSON, WORK_DIR, _read_state, _write_state


def purge_slug(slug: str) -> bool:
    """Deletes work/<slug>/ and its state.json entry. Returns False if there
    was nothing to delete (e.g. already purged, or a 'no' reply for a slug
    that never made it past fetch)."""
    work_dir = WORK_DIR / slug
    existed = work_dir.exists()
    if existed:
        shutil.rmtree(work_dir)

    state = _read_state(STATE_JSON)
    if slug in state:
        del state[slug]
        _write_state(state, STATE_JSON)
        existed = True
    return existed


def _latest_stage_time(lead_state: dict) -> datetime | None:
    stamps = [s.get("at") for s in lead_state.get("stages", {}).values() if s.get("at")]
    if not stamps:
        return None
    return max(datetime.fromisoformat(s) for s in stamps)


def purge_older_than(days: int, status: str) -> list[str]:
    """Purges every lead whose latest recorded stage activity is older than
    `days` and whose state.json `reply_status` field equals `status` (a
    free-form tag the user sets manually - e.g. after reading a "no" reply in
    Gmail; this pipeline never reads replies itself, see SPEC.md out-of-scope).
    Returns the slugs purged."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    state = _read_state(STATE_JSON)
    purged = []
    for slug, lead_state in list(state.items()):
        if lead_state.get("reply_status") != status:
            continue
        latest = _latest_stage_time(lead_state)
        if latest and latest.astimezone(timezone.utc) < cutoff:
            purge_slug(slug)
            purged.append(slug)
    return purged


def set_reply_status(slug: str, status: str) -> None:
    state = _read_state(STATE_JSON)
    lead_state = state.setdefault(slug, {"stages": {}})
    lead_state["reply_status"] = status
    _write_state(state, STATE_JSON)
