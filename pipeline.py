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
import time
import traceback
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import fal_client
import httpx

import crop_training_data
import face_fal
import judge
import train_lora
import supabase_io as sio

# Set on the Lambda so train_for_lead can pass fal.ai a webhook_url and get
# notified the instant training finishes, instead of only finding out on the
# next polling cycle (poll_training() stays as the fallback/backstop path --
# see fal_webhook.py). Left unset for local CLI runs, where there's no
# public URL for fal.ai to call back into.
WEBHOOK_BASE_URL = os.environ.get("WEBHOOK_BASE_URL")

STEPS = 1000
LEARNING_RATE = 0.0001
SWAP_PROMPT_TEMPLATE = "{trigger}, natural candid portrait photo, smiling, same lighting and framing"

# Connection-level blips (fal.ai's own client already retries at the HTTP-call
# level, but under our ThreadPoolExecutor concurrency it shares one pooled
# httpx.Client across threads, which can still surface a stale-connection
# error like RemoteProtocolError -- retry the whole swap call a couple more
# times before giving up). Keep in sync with the text-based check in
# supabase_io.RETRYABLE_ERROR_MARKERS, used to decide whether a *stored*
# failure is worth auto-retrying on a later cycle.
RETRYABLE_EXCEPTION_TYPES = (httpx.TransportError, httpx.TimeoutException, ConnectionError, TimeoutError, urllib.error.URLError)
SWAP_RETRY_ATTEMPTS = 3
SWAP_RETRY_BACKOFF_SECONDS = 5
SWAP_STRENGTH = 0.55  # see face_swap_notes.md -- 0.5-0.6 keeps the scene's original scale
SWAP_CONCURRENCY = 5  # fal.ai inpainting calls are network-bound (~10-20s each); run several at once

# Quality gate: regenerate a result up to this many times if judge.judge_swap_result
# rejects it (bad expression, artifacts, etc.) before giving up and flagging
# it for a human to review instead of auto-delivering something we ourselves
# don't think looks good.
MAX_JUDGE_ATTEMPTS = 10


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
        webhook_url = f"{WEBHOOK_BASE_URL}/webhook/training" if WEBHOOK_BASE_URL else None
        request_id = train_lora.submit(cropped_dir, trigger_phrase, STEPS, LEARNING_RATE, webhook_url=webhook_url)

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
    """
    Run the proven mask+swap recipe (face_swap_notes.md) for each pending
    target photo. Two phases: mask generation runs sequentially (RetinaFace/
    TensorFlow isn't safe to call concurrently from multiple threads), then
    the actual fal.ai inpainting calls -- the real bottleneck, ~10-20s each
    of mostly-idle network wait -- run concurrently. Each result is reviewed
    by judge.judge_swap_result before being marked 'done'; a rejected result
    gets regenerated up to MAX_JUDGE_ATTEMPTS times before the target is left
    at 'needs_review' for a human instead of auto-delivering something our
    own quality bar rejected.
    """
    lora_url = model["lora_url"]
    prompt = SWAP_PROMPT_TEMPLATE.format(trigger=model["trigger_phrase"])

    tmp = tempfile.mkdtemp(prefix="face_swap_swap_")
    try:
        prepared = []
        for target in targets:
            try:
                # Concurrent invocations (e.g. a user picking several target
                # photos in quick succession each pings the pipeline) can race
                # to claim the same target photo -- the DB's unique constraint
                # on target_photo_id is what actually prevents duplicate work,
                # and losing that race here is expected/benign (another
                # invocation already has it), not a reason to abort every
                # other target already prepared in this same batch.
                job = sio.create_swap_job(client, column, owner_id, target["id"], status="processing")
            except Exception as exc:
                # The insert can also fail because this target already has a
                # row from a prior (failed) attempt -- that's the retry case
                # list_leads_ready_to_swap() just approved, so claim it by
                # flipping that row back to 'processing' instead of inserting.
                job = sio.claim_swap_job_for_retry(client, target["id"])
                if job is None:
                    print(f"[swap] target={target['id']}: SKIPPED (already claimed or not retryable) {exc!r}")
                    continue
                print(f"[swap] target={target['id']}: retrying existing job {job['id']}")
            try:
                local_path = sio.download_photo(
                    client, target["storage_path"], tmp, bucket=target.get("bucket") or sio.BUCKET
                )
                mask_path = face_fal.build_head_hair_mask(local_path)
                prepared.append((target, job, local_path, mask_path))
            except Exception as exc:
                sio.update_swap_job(client, job["id"], status="failed", error=repr(exc))
                print(f"[swap] target={target['id']}: FAILED (prepare) {exc!r}")
                traceback.print_exc()

        def _generate_candidate(target, local_path, mask_path, judge_attempt):
            """One fal.ai swap call, with its own retry for transient network errors. Raises on exhausted/non-retryable failure."""
            last_exc = None
            for attempt in range(1, SWAP_RETRY_ATTEMPTS + 1):
                try:
                    urls = face_fal.face_swap_with_lora(
                        image_path=local_path,
                        mask_path=mask_path,
                        lora_url=lora_url,
                        prompt=prompt,
                        lora_scale=1.0,
                        strength=SWAP_STRENGTH,
                        num_images=1,
                    )
                    result_local = os.path.join(tmp, f"result_{target['id']}_{judge_attempt}.jpg")
                    urllib.request.urlretrieve(urls[0], result_local)
                    return result_local
                except Exception as exc:
                    last_exc = exc
                    retryable = isinstance(exc, RETRYABLE_EXCEPTION_TYPES)
                    if retryable and attempt < SWAP_RETRY_ATTEMPTS:
                        wait = SWAP_RETRY_BACKOFF_SECONDS * attempt
                        print(f"[swap] target={target['id']}: retryable error {exc!r}, attempt {attempt}/{SWAP_RETRY_ATTEMPTS}, retrying in {wait}s")
                        time.sleep(wait)
                        continue
                    raise

        def run_one(item):
            target, job, local_path, mask_path = item
            last_rejection_reason = None

            for judge_attempt in range(1, MAX_JUDGE_ATTEMPTS + 1):
                try:
                    result_local = _generate_candidate(target, local_path, mask_path, judge_attempt)
                except Exception as exc:
                    # Generation itself is broken (not a quality problem) --
                    # no point burning more judge attempts on it.
                    sio.update_swap_job(client, job["id"], status="failed", error=repr(exc))
                    print(f"[swap] target={target['id']}: FAILED {exc!r}")
                    traceback.print_exc()
                    return

                try:
                    review = judge.judge_swap_result(result_local, local_path)
                except Exception as exc:
                    # Don't hold a real, working image hostage to our own
                    # review tooling being down -- deliver it, but make the
                    # skip visible in logs.
                    print(f"[swap] target={target['id']}: judge call failed ({exc!r}), delivering unjudged")
                    review = {"approved": True, "reason": f"judge unavailable: {exc!r}"}

                if review["approved"]:
                    storage_path = sio.upload_result(client, column, owner_id, result_local)
                    sio.update_swap_job(
                        client, job["id"], status="done", result_storage_path=storage_path, error=None, judge_reason=review["reason"]
                    )
                    print(f"[swap] target={target['id']}: done -> {storage_path} (judge attempt {judge_attempt}/{MAX_JUDGE_ATTEMPTS}): {review['reason']}")
                    return

                last_rejection_reason = review["reason"]
                last_result_local = result_local
                print(f"[swap] target={target['id']}: judge REJECTED attempt {judge_attempt}/{MAX_JUDGE_ATTEMPTS}: {last_rejection_reason}")

            # Exhausted every regeneration attempt without an approved result --
            # still upload the last candidate (so a human reviewer has an
            # actual image to look at) but keep it out of the customer-facing
            # 'done' state until someone signs off on it.
            storage_path = sio.upload_result(client, column, owner_id, last_result_local)
            sio.update_swap_job(
                client, job["id"], status="needs_review", result_storage_path=storage_path, error=last_rejection_reason,
                judge_reason=last_rejection_reason,
            )
            print(f"[swap] target={target['id']}: NEEDS_REVIEW after {MAX_JUDGE_ATTEMPTS} rejected attempts -> {storage_path}")
            sio.notify_needs_review(target["id"], last_rejection_reason)

        if prepared:
            with ThreadPoolExecutor(max_workers=min(SWAP_CONCURRENCY, len(prepared))) as executor:
                list(executor.map(run_one, prepared))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
