"""
AWS Lambda entry point. Wraps watch_and_process.run_cycle() (the same
single-pass function used by `python3 watch_and_process.py --once`) behind
an API Gateway HTTP API, so the `face` app's own triggerPipeline() pings (on
user actions) or an EventBridge scheduled rule (the periodic-poll backstop --
see the "faceswap-pipeline-cycle" rule, added after an earlier external
cron-job.org setup turned out to have silently stopped firing for 3+ days)
can each kick off one pipeline pass via a plain invocation instead of a
persistent local process.

A full cycle (download/crop/mask several photos, wait on fal.ai calls) can
take well over 30s, but API Gateway HTTP APIs hard-cap the integration
timeout at 30s (not configurable) -- so the HTTP-triggered path here only
validates the secret and asynchronously self-invokes this same function
with an internal marker to do the real work, then returns immediately. The
async invocation isn't bound by that 30s cap, only by this function's own
configured Timeout.

POST /webhook/training is a second route on this same function/API Gateway
(RouteKey is $default, so every path lands here -- see fal_webhook.py for
why) that fal.ai calls the moment a training job finishes, so a lead's swaps
can start immediately instead of waiting for the next polling cycle to
notice. It's verified via fal's own ED25519 webhook signature, not
TRIGGER_SECRET, and uses the same fast-ack-then-async-self-invoke shape for
the same 30s-cap reason.

Env vars (set on the Lambda function, not read from .env -- there is none
in this image):
    SUPABASE_URL, SUPABASE_SECRET_KEY, FAL_KEY  -- same as local .env
    TRIGGER_SECRET                              -- shared secret checked
                                                    against ?secret=... on
                                                    every request
    WEBHOOK_BASE_URL                            -- this function's own
                                                    public URL (e.g.
                                                    https://<id>.execute-api...)
                                                    so pipeline.py can hand
                                                    fal.ai a webhook_url
                                                    pointing back at
                                                    /webhook/training. Training
                                                    falls back to poll-only
                                                    (no webhook) if unset.
    DRY_RUN=1                                   -- optional: stub out the
                                                    paid fal.ai calls
                                                    (train_lora.submit,
                                                    face_fal.face_swap_with_lora)
                                                    so a real invocation can
                                                    be used to verify the
                                                    deployment itself --
                                                    env vars, bundled
                                                    RetinaFace weights,
                                                    Supabase connectivity --
                                                    without spending real
                                                    training/inference cost.
                                                    Leaves a placeholder
                                                    face_models/swap_jobs
                                                    row behind for anything
                                                    it touches; delete those
                                                    before a real run.
"""

from __future__ import annotations

import base64
import json
import os
from unittest.mock import patch

import boto3

import fal_webhook
import supabase_io as sio
from watch_and_process import run_cycle

_ASYNC_MARKER = "_async_worker"
_WEBHOOK_ASYNC_MARKER = "_webhook_async_worker"

lambda_client = boto3.client("lambda")


def _provided_secret(event: dict) -> str | None:
    query = event.get("queryStringParameters") or {}
    if query.get("secret"):
        return query["secret"]
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    return headers.get("x-trigger-secret")


def _run_cycle_once() -> dict:
    dry_run = os.environ.get("DRY_RUN") == "1"
    client = sio.get_client()
    if dry_run:
        with patch("train_lora.submit", return_value="dry-run-request-id"), patch(
            "face_fal.face_swap_with_lora", return_value=["https://example.com/dry-run-result.jpg"]
        ):
            run_cycle(client)
    else:
        run_cycle(client)
    return {"ok": True, "dryRun": dry_run}


def _handle_training_webhook(event, context) -> dict:
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    raw_body = event.get("body") or ""
    body = base64.b64decode(raw_body) if event.get("isBase64Encoded") else raw_body.encode("utf-8")

    request_id = headers.get("x-fal-webhook-request-id", "")
    ok = fal_webhook.verify_signature(
        request_id=request_id,
        user_id=headers.get("x-fal-webhook-user-id", ""),
        timestamp=headers.get("x-fal-webhook-timestamp", ""),
        signature_hex=headers.get("x-fal-webhook-signature", ""),
        body=body,
    )
    if not ok:
        print("[lambda_handler] fal.ai webhook signature verification FAILED")
        return {"statusCode": 401, "body": json.dumps({"error": "invalid signature"})}

    lambda_client.invoke(
        FunctionName=context.invoked_function_arn,
        InvocationType="Event",
        Payload=json.dumps({_WEBHOOK_ASYNC_MARKER: True, "request_id": request_id}),
    )
    return {"statusCode": 200, "body": json.dumps({"ok": True})}


def handler(event, context):
    if event.get(_WEBHOOK_ASYNC_MARKER):
        try:
            return fal_webhook.handle_training_complete(sio.get_client(), event["request_id"])
        except Exception as exc:  # noqa: BLE001 -- surfaced via CloudWatch on the async invocation
            print(f"[lambda_handler] webhook handling failed: {exc!r}")
            raise

    if event.get(_ASYNC_MARKER):
        # Self-invoked (asynchronously) to actually do the work -- not an
        # HTTP request, no API Gateway response shape needed.
        try:
            return _run_cycle_once()
        except Exception as exc:  # noqa: BLE001 -- surfaced via CloudWatch on the async invocation
            print(f"[lambda_handler] cycle failed: {exc!r}")
            raise

    if event.get("rawPath") == "/webhook/training":
        return _handle_training_webhook(event, context)

    # EventBridge's own scheduled-rule invocations (the periodic-poll
    # backstop) call this function directly, not through API Gateway -- no
    # TRIGGER_SECRET to check, since only this AWS account's IAM can create
    # or fire that rule in the first place (same trust boundary the secret
    # exists to provide for the public HTTPS path below).
    if event.get("source") == "aws.events":
        try:
            return _run_cycle_once()
        except Exception as exc:  # noqa: BLE001 -- surfaced via CloudWatch
            print(f"[lambda_handler] scheduled cycle failed: {exc!r}")
            raise

    expected_secret = os.environ.get("TRIGGER_SECRET")
    if expected_secret and _provided_secret(event) != expected_secret:
        return {"statusCode": 401, "body": json.dumps({"error": "unauthorized"})}

    lambda_client.invoke(
        FunctionName=context.invoked_function_arn,
        InvocationType="Event",
        Payload=json.dumps({_ASYNC_MARKER: True}),
    )
    return {"statusCode": 202, "body": json.dumps({"ok": True, "accepted": True})}
