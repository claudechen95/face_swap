"""Minimal .env loader (no extra dependency) + typed settings."""

from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"


def load_dotenv(path: Path = ENV_PATH) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


class Settings(BaseModel):
    youtube_api_key: str = ""
    ideogram_api_key: str = ""
    gmail_credentials: str = "credentials.json"
    sender_name: str = ""
    product_url: str = "https://faceswap.fit"
    rev_share_pct: str = "20"
    # Ideogram doesn't publish a confirmed per-call price for this endpoint (checked
    # developer.ideogram.ai directly - see research notes). Left blank by default so
    # `generate` reports call counts/latency honestly instead of a fabricated total;
    # fill in from your Ideogram billing page once known for a real dollar total.
    ideogram_cost_per_image_usd: str = ""

    @classmethod
    def load(cls) -> "Settings":
        load_dotenv()
        return cls(
            youtube_api_key=os.environ.get("YOUTUBE_API_KEY", ""),
            ideogram_api_key=os.environ.get("IDEOGRAM_API_KEY", ""),
            gmail_credentials=os.environ.get("GMAIL_CREDENTIALS", "credentials.json"),
            sender_name=os.environ.get("SENDER_NAME", ""),
            product_url=os.environ.get("PRODUCT_URL", "https://faceswap.fit"),
            rev_share_pct=os.environ.get("REV_SHARE_PCT", "20"),
            ideogram_cost_per_image_usd=os.environ.get("IDEOGRAM_COST_PER_IMAGE_USD", ""),
        )
