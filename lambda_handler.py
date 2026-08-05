"""
AWS Lambda entry point. Wraps watch_and_process.run_cycle() (the same
single-pass function used by `python3 watch_and_process.py --once`) behind
an API Gateway HTTP API, so an external scheduler (cron-job.org) can trigger
one pipeline pass via a plain HTTPS GET/POST instead of a persistent local
process.

A full cycle (download/crop/mask several photos, wait on fal.ai calls) can
take well over 30s, but API Gateway HTTP APIs hard-cap the integration
timeout at 30s (not configurable) -- so the HTTP-triggered path here only
validates the secret and asynchronously self-invokes this same function
with an internal marker to do the real work, then returns immediately. The
async invocation isn't bound by that 30s cap, only by this function's own
configured Timeout.

Env vars (set on the Lambda function, not read from .env -- there is none
in this image):
    SUPABASE_URL, SUPABASE_SECRET_KEY, FAL_KEY  -- same as local .env
    TRIGGER_SECRET                              -- shared secret checked
                                                    against ?secret=... on
                                                    every request
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

import json
import os
from unittest.mock import patch

import boto3

import supabase_io as sio
from watch_and_process import run_cycle

_ASYNC_MARKER = "_async_worker"

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


def handler(event, context):
    if event.get(_ASYNC_MARKER):
        # Self-invoked (asynchronously) to actually do the work -- not an
        # HTTP request, no API Gateway response shape needed.
        try:
            return _run_cycle_once()
        except Exception as exc:  # noqa: BLE001 -- surfaced via CloudWatch on the async invocation
            print(f"[lambda_handler] cycle failed: {exc!r}")
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
