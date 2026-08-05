"""
Per-lead orchestration for the automated pipeline. watch_and_process.py
calls these functions; all the actual ML work is delegated to the existing,
already-tuned face_swap code (train_lora.submit/fal_client.status/result,
face_fal.build_head_hair_mask/face_swap_with_lora) -- this module only adds
the Supabase-backed bookkeeping (via supabase_io) around them, replacing the
old local-folder + manual-copy-paste workflow.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import traceback
import urllib.request

import fal_client

import crop_training_data
import face_fal
import train_lora
import supabase_io as sio

STEPS = 1000
LEARNING_RATE = 0.0001
SWAP_PROMPT_TEMPLATE = "{trigger}, natural candid portrait photo, smiling, same lighting and framing"
SWAP_STRENGTH = 0.55  # see face_swap_notes.md -- 0.5-0.6 keeps the scene's original scale


def _trigger_phrase(owner_id) -> str:
    return f"sks{str(owner_id).replace('-', '')[:16]}"


def train_for_lead(client, column: str, owner_id) -> None:
    """
    Download a lead's face photos, crop them, and submit training to fal.ai.
    Fire-and-forget: this only submits the job (fal_client.submit is
    async/queue-based, not the blocking .subscribe()) so one
    watch_and_process cycle can kick off many leads' trainings without
    blocking on any of them. poll_training() checks completion later.
    """
    model = sio.get_face_model(client, column, owner_id)
    if model is None:
        model = sio.create_face_model(client, column, owner_id, status="pending")

    tmp = tempfile.mkdtemp(prefix="face_swap_train_")
    try:
        raw_dir = os.path.join(tmp, "raw")
        cropped_dir = os.path.join(tmp, "cropped")
        local_paths = sio.download_photos(client, column, owner_id, "face", raw_dir)
        if not local_paths:
            raise RuntimeError("no face photos found")

        crop_result = crop_training_data.crop_folder(raw_dir, cropped_dir)
        if not crop_result["ok"]:
            raise RuntimeError(f"crop failed for every photo: {crop_result['failures']}")

        trigger_phrase = _trigger_phrase(owner_id)
        request_id = train_lora.submit(cropped_dir, trigger_phrase, STEPS, LEARNING_RATE)

        sio.update_face_model(
            client,
            model["id"],
            status="training",
            trigger_phrase=trigger_phrase,
            fal_request_id=request_id,
            error=None,
        )
        print(f"[train] {column}={owner_id}: submitted {request_id} (trigger={trigger_phrase})")
    except Exception as exc:
        sio.update_face_model(client, model["id"], status="failed", error=repr(exc))
        print(f"[train] {column}={owner_id}: FAILED {exc!r}")
        traceback.print_exc()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def poll_training(client, model: dict) -> None:
    """Check one in-progress training job; finalize to 'ready'/'failed' if fal.ai is done."""
    request_id = model["fal_request_id"]
    try:
        status = fal_client.status(train_lora.APP, request_id, with_logs=False)
    except Exception as exc:
        print(f"[poll] model={model['id']}: status check failed {exc!r}")
        return

    if not isinstance(status, fal_client.Completed):
        return  # still queued/in-progress -- nothing to do this cycle

    try:
        result = fal_client.result(train_lora.APP, request_id)
        lora_url = result["diffusers_lora_file"]["url"]
        sio.update_face_model(client, model["id"], status="ready", lora_url=lora_url, error=None)
        print(f"[poll] model={model['id']}: ready ({lora_url})")
    except Exception as exc:
        sio.update_face_model(client, model["id"], status="failed", error=repr(exc))
        print(f"[poll] model={model['id']}: FAILED to fetch result {exc!r}")


def swap_for_lead(client, model: dict, column: str, owner_id, targets: list[dict]) -> None:
    """Run the proven mask+swap recipe (face_swap_notes.md) for each pending target photo."""
    lora_url = model["lora_url"]
    prompt = SWAP_PROMPT_TEMPLATE.format(trigger=model["trigger_phrase"])

    tmp = tempfile.mkdtemp(prefix="face_swap_swap_")
    try:
        for target in targets:
            job = sio.create_swap_job(client, column, owner_id, target["id"], status="processing")
            try:
                local_path = sio.download_photo(client, target["storage_path"], tmp)
                mask_path = face_fal.build_head_hair_mask(local_path)

                urls = face_fal.face_swap_with_lora(
                    image_path=local_path,
                    mask_path=mask_path,
                    lora_url=lora_url,
                    prompt=prompt,
                    lora_scale=1.0,
                    strength=SWAP_STRENGTH,
                    num_images=1,
                )
                result_local = os.path.join(tmp, f"result_{target['id']}.jpg")
                urllib.request.urlretrieve(urls[0], result_local)

                storage_path = sio.upload_result(client, column, owner_id, result_local)
                sio.update_swap_job(client, job["id"], status="done", result_storage_path=storage_path, error=None)
                print(f"[swap] target={target['id']}: done -> {storage_path}")
            except Exception as exc:
                sio.update_swap_job(client, job["id"], status="failed", error=repr(exc))
                print(f"[swap] target={target['id']}: FAILED {exc!r}")
                traceback.print_exc()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
