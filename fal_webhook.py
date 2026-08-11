"""
fal.ai webhook receiver for training-job completion -- lets a face_model
flip to 'ready' (and any pending swaps for it start) the moment fal.ai is
actually done, instead of waiting for the next polling cycle to notice.
poll_training() (pipeline.py) remains the fallback/backstop path: if a
webhook is ever missed or arrives before WEBHOOK_BASE_URL is configured, the
next cycle's polling still finds and finalizes it -- this module is purely
an optimization on top of that, never a replacement for it.

See https://docs.fal.ai/model-apis/model-endpoints/webhooks

Signature verification: fal.ai signs every webhook POST with one of a
rotating set of ED25519 keys (fetched from a JWKS endpoint) over
"{request_id}\\n{user_id}\\n{timestamp}\\n{sha256(body)}", delivered via the
X-Fal-Webhook-* headers. This must be verified before trusting the payload --
anyone who found this URL could otherwise fake a "training complete" event
and get free swap inference run against a lora_url of their choosing.
"""

from __future__ import annotations

import base64
import hashlib
import time

import httpx
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

JWKS_URL = "https://rest.alpha.fal.ai/.well-known/jwks.json"
TIMESTAMP_TOLERANCE_SECONDS = 300  # reject replays of an old, previously-valid signature

_jwks_cache: list[dict] | None = None
_jwks_cache_at: float = 0
JWKS_CACHE_SECONDS = 24 * 60 * 60


def _get_jwks_keys() -> list[dict]:
    global _jwks_cache, _jwks_cache_at
    if _jwks_cache is None or (time.time() - _jwks_cache_at) > JWKS_CACHE_SECONDS:
        resp = httpx.get(JWKS_URL, timeout=10)
        resp.raise_for_status()
        _jwks_cache = resp.json().get("keys", [])
        _jwks_cache_at = time.time()
    return _jwks_cache


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def verify_signature(request_id: str, user_id: str, timestamp: str, signature_hex: str, body: bytes) -> bool:
    if not (request_id and user_id and timestamp and signature_hex):
        return False
    try:
        timestamp_int = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(time.time() - timestamp_int) > TIMESTAMP_TOLERANCE_SECONDS:
        return False
    try:
        signature = bytes.fromhex(signature_hex)
    except (TypeError, ValueError):
        return False

    message = "\n".join([request_id, user_id, timestamp, hashlib.sha256(body).hexdigest()]).encode("utf-8")

    try:
        keys = _get_jwks_keys()
    except Exception as exc:
        print(f"[fal_webhook] JWKS fetch failed: {exc!r}")
        return False

    for key_info in keys:
        public_key_b64 = key_info.get("x")
        if not public_key_b64:
            continue
        try:
            VerifyKey(_b64url_decode(public_key_b64)).verify(message, signature)
            return True
        except BadSignatureError:
            continue
        except Exception as exc:
            print(f"[fal_webhook] key check failed ({key_info.get('kid', '?')}): {exc!r}")
            continue
    return False


def handle_training_complete(client, request_id: str) -> dict:
    """
    Finalize one training job (reuses pipeline.poll_training's own
    fal_client.result()-and-update-status logic) and, if it just became
    'ready', immediately run any pending swaps for it.
    """
    import pipeline
    import supabase_io as sio

    model = sio.get_face_model_by_request_id(client, request_id)
    if model is None:
        print(f"[fal_webhook] no face_model for request_id={request_id}")
        return {"ok": True, "skipped": "unknown request_id"}
    if model["status"] != "training":
        # fal.ai retries webhook delivery -- and a cron cycle could have
        # already polled and finalized this first. Either way, re-finalizing
        # is a no-op we should skip, not an error.
        print(f"[fal_webhook] model={model['id']} already {model['status']}, skipping")
        return {"ok": True, "skipped": f"already {model['status']}"}

    pipeline.poll_training(client, model)

    model = sio.get_face_model_by_request_id(client, request_id)
    if model and model["status"] == "ready":
        column, owner_id, targets = sio.pending_targets_for_model(client, model)
        if targets:
            print(f"[fal_webhook] model={model['id']}: training ready, swapping {len(targets)} target(s) immediately")
            pipeline.swap_for_lead(client, model, column, owner_id, targets)

    return {"ok": True}
