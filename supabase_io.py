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
import uuid

from supabase import create_client, Client

BUCKET = "user-photos"
MIN_FACE_PHOTOS = 6  # keep in sync with face/api/_lib/identity.js PHOTO_KINDS.face.min


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
    """All target-kind uploaded_photos rows for this owner (id + storage_path)."""
    return (
        client.table("uploaded_photos")
        .select("id, storage_path")
        .eq(column, owner_id)
        .eq("kind", "target")
        .order("created_at")
        .execute()
        .data
    )


def download_photo(client: Client, storage_path: str, dst_dir: str) -> str:
    os.makedirs(dst_dir, exist_ok=True)
    data = client.storage.from_(BUCKET).download(storage_path)
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
    without a matching swap_jobs row yet.
    """
    ready_models = list_face_models_by_status(client, "ready")
    if not ready_models:
        return []

    existing_job_target_ids = {
        row["target_photo_id"]
        for row in client.table("swap_jobs").select("target_photo_id").execute().data
    }

    pending = []
    for model in ready_models:
        column, owner_id = (
            ("submission_id", model["submission_id"])
            if model["submission_id"] is not None
            else ("user_id", model["user_id"])
        )
        targets = list_target_photos(client, column, owner_id)
        pending_targets = [t for t in targets if t["id"] not in existing_job_target_ids]
        if pending_targets:
            pending.append({"model": model, "column": column, "owner_id": owner_id, "targets": pending_targets})
    return pending


def delete_failed_face_models(client: Client) -> int:
    """Delete failed face_models rows so their owners are re-picked-up by list_leads_ready_to_train()."""
    rows = client.table("face_models").delete().eq("status", "failed").execute().data
    return len(rows)


def delete_failed_swap_jobs(client: Client) -> int:
    """Delete failed swap_jobs rows so their target photo is re-picked-up by list_leads_ready_to_swap()."""
    rows = client.table("swap_jobs").delete().eq("status", "failed").execute().data
    return len(rows)
