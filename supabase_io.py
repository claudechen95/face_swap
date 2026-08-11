"""
Thin Supabase I/O helpers for the automated pipeline (pipeline.py /
watch_and_process.py). Mirrors the identity/table conventions already
established by the face web app -- see:
  - /Users/Claude/workspace/face/api/_lib/identity.js  (owner column pair,
    storage prefix, MIN_PHOTOS)
  - /Users/Claude/workspace/face/api/upload-init.js    (uploaded_photos
    query + storage download pattern)

(submission_id, user_id) is a nullable pair on every lead-owned table,
exactly one of which is set. `kind` on uploaded_photos distinguishes 'face'
vs 'target' photos. Owners are identified throughout this module as a
(column, id) pair, e.g. ("submission_id", 24) or ("user_id", "<uuid>").

Requires SUPABASE_URL and SUPABASE_SECRET_KEY in the environment (same
values as the face app's Vercel env -- copy into a local .env here, do not
commit them).
"""

from __future__ import annotations

import os
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

from supabase import create_client, Client

BUCKET = "user-photos"
MIN_FACE_PHOTOS = 6  # keep in sync with face/api/_lib/identity.js PHOTO_KINDS.face.min

# Text markers identifying a *stored* swap_jobs.error as a transient/network
# failure worth auto-retrying, rather than a permanent one (bad photo, no
# face detected) that would just burn fal.ai credits forever on retry. Keep
# in sync with pipeline.RETRYABLE_EXCEPTION_TYPES, which classifies the live
# exception the moment it happens (this text-based check is only needed
# because by the time list_leads_ready_to_swap() runs, all we have left is
# the repr() string that got stored on the row). STALE_PROCESSING_MARKER is
# reap_stale_processing_swap_jobs()'s own synthetic error text, included here
# so a reaped job flows straight into the same auto-retry path.
STALE_PROCESSING_MARKER = "StaleProcessingTimeout"
RETRYABLE_ERROR_MARKERS = ("RemoteProtocolError", "ConnectError", "ConnectTimeout", "ReadTimeout", "PoolTimeout", "ConnectionError", "TimeoutError", "URLError", "Server disconnected", STALE_PROCESSING_MARKER)
MAX_AUTO_SWAP_RETRIES = 3
STALE_PROCESSING_MINUTES = 15  # comfortably longer than any healthy single swap (~30-60s) or even a full Lambda timeout (15 min)


def _is_retryable_error(error_text: str | None) -> bool:
    return bool(error_text) and any(marker in error_text for marker in RETRYABLE_ERROR_MARKERS)


def get_client() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SECRET_KEY"]
    return create_client(url, key)


def _other_column(column: str) -> str:
    return "user_id" if column == "submission_id" else "submission_id"


def download_photos(client: Client, column: str, owner_id, kind: str, dst_dir: str) -> list[str]:
    """Download every uploaded_photos row of `kind` for this owner into dst_dir. Returns local paths."""
    os.makedirs(dst_dir, exist_ok=True)
    rows = (
        client.table("uploaded_photos")
        .select("id, storage_path")
        .eq(column, owner_id)
        .eq("kind", kind)
        .order("created_at")
        .execute()
        .data
    )
    local_paths = []
    for row in rows:
        storage_path = row["storage_path"]
        data = client.storage.from_(BUCKET).download(storage_path)
        local_path = os.path.join(dst_dir, os.path.basename(storage_path))
        with open(local_path, "wb") as f:
            f.write(data)
        local_paths.append(local_path)
    return local_paths


def list_target_photos(client: Client, column: str, owner_id) -> list[dict]:
    """All target-kind uploaded_photos rows for this owner (id + storage_path + bucket)."""
    return (
        client.table("uploaded_photos")
        .select("id, storage_path, bucket")
        .eq(column, owner_id)
        .eq("kind", "target")
        .order("created_at")
        .execute()
        .data
    )


def download_photo(client: Client, storage_path: str, dst_dir: str, bucket: str = BUCKET) -> str:
    os.makedirs(dst_dir, exist_ok=True)
    data = client.storage.from_(bucket).download(storage_path)
    local_path = os.path.join(dst_dir, os.path.basename(storage_path))
    with open(local_path, "wb") as f:
        f.write(data)
    return local_path


def upload_result(client: Client, column: str, owner_id, local_path: str) -> str:
    """Upload a finished swap result into the lead's results/ prefix. Returns the storage path."""
    prefix = str(owner_id)
    ext = os.path.splitext(local_path)[1] or ".jpg"
    storage_path = f"{prefix}/results/{uuid.uuid4()}{ext}"
    with open(local_path, "rb") as f:
        client.storage.from_(BUCKET).upload(
            storage_path, f.read(), {"content-type": "image/jpeg"}
        )
    return storage_path


def get_face_model(client: Client, column: str, owner_id) -> dict | None:
    # .maybe_single().execute() returns None itself (not a response with
    # .data = None) when zero rows match, in this supabase-py version.
    response = client.table("face_models").select("*").eq(column, owner_id).maybe_single().execute()
    return response.data if response is not None else None


def get_face_model_by_request_id(client: Client, request_id: str) -> dict | None:
    """Used by fal_webhook.py -- a training-complete webhook only carries fal's
    own request_id, not the (column, owner_id) pair get_face_model() needs."""
    response = client.table("face_models").select("*").eq("fal_request_id", request_id).maybe_single().execute()
    return response.data if response is not None else None


def create_face_model(client: Client, column: str, owner_id, **fields) -> dict:
    row = {"submission_id": None, "user_id": None, **fields, column: owner_id}
    return client.table("face_models").insert(row).execute().data[0]


def update_face_model(client: Client, model_id, **fields) -> dict:
    return (
        client.table("face_models")
        .update(fields)
        .eq("id", model_id)
        .execute()
        .data[0]
    )


def create_swap_job(client: Client, column: str, owner_id, target_photo_id, **fields) -> dict:
    row = {
        "submission_id": None,
        "user_id": None,
        "target_photo_id": target_photo_id,
        **fields,
        column: owner_id,
    }
    return client.table("swap_jobs").insert(row).execute().data[0]


def update_swap_job(client: Client, job_id, **fields) -> dict:
    return (
        client.table("swap_jobs")
        .update(fields)
        .eq("id", job_id)
        .execute()
        .data[0]
    )


def claim_swap_job_for_retry(client: Client, target_photo_id) -> dict | None:
    """
    Retry a target photo by flipping its existing 'failed' row back to
    'processing', rather than inserting a new row -- swap_jobs has a unique
    constraint on target_photo_id (that's what makes create_swap_job's
    insert-based claim safe under concurrent invocations), so a second row
    for the same photo is never possible, retry or not.

    The .eq("status", "failed") filter makes this an atomic compare-and-swap:
    if another invocation already claimed the retry first, this affects 0
    rows and returns None here, rather than both invocations processing the
    same photo.
    """
    rows = (
        client.table("swap_jobs")
        .update({"status": "processing", "error": None})
        .eq("target_photo_id", target_photo_id)
        .eq("status", "failed")
        .execute()
        .data
    )
    return rows[0] if rows else None


def reap_stale_processing_swap_jobs(client: Client, stale_after_minutes: int = STALE_PROCESSING_MINUTES) -> int:
    """
    Mark swap_jobs stuck in 'processing' with no update in stale_after_minutes
    as a retryable 'failed'. A row can get orphaned there if the Lambda
    invocation handling it dies mid-flight -- e.g. a concurrent invocation
    losing the create_swap_job claim race on a *different* target photo in
    the same batch used to crash the whole cycle before it ever reached this
    target's actual swap call (see pipeline.swap_for_lead). Without this,
    'processing' is permanently excluded from list_leads_ready_to_swap(), so
    a photo stuck this way would sit forever with no error and no retry.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=stale_after_minutes)).isoformat()
    rows = (
        client.table("swap_jobs")
        .update({"status": "failed", "error": f"{STALE_PROCESSING_MARKER}: no update in {stale_after_minutes}+ minutes"})
        .eq("status", "processing")
        .lt("updated_at", cutoff)
        .execute()
        .data
    )
    return len(rows)


def notify_needs_review(target_photo_id, reason: str | None) -> None:
    """
    Fire-and-forget ntfy alert (same topic/service the face app's Node API
    already uses -- see face/api/notify-done.js) so the team actually finds
    out a result needs a manual look, per the "we'll get back to you within
    24 hours" promise shown on the results page. Never raises -- a
    notification failure shouldn't be treated as the swap job itself failing.
    """
    topic = os.environ.get("NTFY_TOPIC")
    if not topic:
        print("Missing NTFY_TOPIC env var -- skipping needs_review notification")
        return
    try:
        req = urllib.request.Request(
            f"https://ntfy.sh/{topic}",
            method="POST",
            data=(reason or "No reason given").encode("utf-8"),
            headers={
                "Title": "Swap result needs review",
                "Tags": "warning",
                "Click": "https://faceswap.fit/admin",
            },
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:
        print(f"[notify_needs_review] ntfy failed for target={target_photo_id}: {exc!r}")


def _owners_with_face_photo_counts(client: Client) -> dict[tuple[str, object], int]:
    rows = (
        client.table("uploaded_photos")
        .select("submission_id, user_id")
        .eq("kind", "face")
        .execute()
        .data
    )
    counts: dict[tuple[str, object], int] = {}
    for row in rows:
        key = ("submission_id", row["submission_id"]) if row["submission_id"] is not None else ("user_id", row["user_id"])
        counts[key] = counts.get(key, 0) + 1
    return counts


def list_leads_ready_to_train(client: Client) -> list[tuple[str, object]]:
    """Owners with >= MIN_FACE_PHOTOS face photos and no face_models row yet."""
    counts = _owners_with_face_photo_counts(client)
    existing = client.table("face_models").select("submission_id, user_id").execute().data
    existing_keys = {
        ("submission_id", row["submission_id"]) if row["submission_id"] is not None else ("user_id", row["user_id"])
        for row in existing
    }
    return [
        owner
        for owner, count in counts.items()
        if count >= MIN_FACE_PHOTOS and owner not in existing_keys
    ]


def list_face_models_by_status(client: Client, status: str) -> list[dict]:
    return client.table("face_models").select("*").eq("status", status).execute().data


def list_leads_ready_to_swap(client: Client) -> list[dict]:
    """
    face_models rows with status='ready' that have at least one target photo
    needing a swap: either no swap_jobs row yet, or every existing row for
    that photo is a retryable failure (see RETRYABLE_ERROR_MARKERS) and it
    hasn't exceeded MAX_AUTO_SWAP_RETRIES attempts. Non-retryable failures
    (bad photo, no face detected) and photos already done/processing are
    left alone.
    """
    ready_models = list_face_models_by_status(client, "ready")
    if not ready_models:
        return []

    jobs_by_target_id: dict[int, list[dict]] = {}
    for row in client.table("swap_jobs").select("target_photo_id, status, error").execute().data:
        jobs_by_target_id.setdefault(row["target_photo_id"], []).append(row)

    def _needs_swap(target_id: int) -> bool:
        jobs = jobs_by_target_id.get(target_id)
        if not jobs:
            return True
        if any(j["status"] in ("done", "processing") for j in jobs):
            return False
        return len(jobs) < MAX_AUTO_SWAP_RETRIES and all(_is_retryable_error(j["error"]) for j in jobs)

    pending = []
    for model in ready_models:
        column, owner_id = (
            ("submission_id", model["submission_id"])
            if model["submission_id"] is not None
            else ("user_id", model["user_id"])
        )
        targets = list_target_photos(client, column, owner_id)
        pending_targets = [t for t in targets if _needs_swap(t["id"])]
        if pending_targets:
            pending.append({"model": model, "column": column, "owner_id": owner_id, "targets": pending_targets})
    return pending


def pending_targets_for_model(client: Client, model: dict) -> tuple[str, object, list[dict]]:
    """
    Same 'needs a swap' filtering as list_leads_ready_to_swap(), scoped to a
    single already-ready model -- used by fal_webhook.py to swap immediately
    after a training-complete webhook instead of waiting for the next full
    cycle to notice via list_leads_ready_to_swap().
    """
    column, owner_id = (
        ("submission_id", model["submission_id"])
        if model["submission_id"] is not None
        else ("user_id", model["user_id"])
    )
    targets = list_target_photos(client, column, owner_id)
    if not targets:
        return column, owner_id, []

    target_ids = [t["id"] for t in targets]
    jobs_by_target_id: dict[int, list[dict]] = {}
    for row in client.table("swap_jobs").select("target_photo_id, status, error").in_("target_photo_id", target_ids).execute().data:
        jobs_by_target_id.setdefault(row["target_photo_id"], []).append(row)

    def _needs_swap(target_id: int) -> bool:
        jobs = jobs_by_target_id.get(target_id)
        if not jobs:
            return True
        if any(j["status"] in ("done", "processing") for j in jobs):
            return False
        return len(jobs) < MAX_AUTO_SWAP_RETRIES and all(_is_retryable_error(j["error"]) for j in jobs)

    return column, owner_id, [t for t in targets if _needs_swap(t["id"])]


def delete_failed_face_models(client: Client) -> int:
    """Delete failed face_models rows so their owners are re-picked-up by list_leads_ready_to_train()."""
    rows = client.table("face_models").delete().eq("status", "failed").execute().data
    return len(rows)


def delete_failed_swap_jobs(client: Client) -> int:
    """Delete failed swap_jobs rows so their target photo is re-picked-up by list_leads_ready_to_swap()."""
    rows = client.table("swap_jobs").delete().eq("status", "failed").execute().data
    return len(rows)
