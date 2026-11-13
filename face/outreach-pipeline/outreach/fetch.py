"""Photo + recent-video fetch for YouTube leads; manual-drop fallback for IG/TikTok."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

import httpx

from .leads import Lead

YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
RECENT_VIDEO_COUNT = 10
MAX_RETRIES = 5


class FetchError(Exception):
    pass


class NeedsManualPhoto(Exception):
    """Raised for non-YouTube leads with no work/<slug>/manual.jpg yet."""


def _get_with_backoff(client: httpx.Client, url: str, params: dict) -> dict:
    """Backs off on 403 (quota) / 429 (rate limit); everything else raises."""
    delay = 1.0
    for attempt in range(MAX_RETRIES):
        resp = client.get(url, params=params)
        if resp.status_code in (403, 429):
            if attempt == MAX_RETRIES - 1:
                raise FetchError(f"YouTube API gave up after retries: {resp.status_code} {resp.text}")
            time.sleep(delay)
            delay *= 2
            continue
        if resp.status_code != 200:
            raise FetchError(f"YouTube API error {resp.status_code}: {resp.text}")
        return resp.json()
    raise FetchError("unreachable")


def _channel_id_param(handle: str, url: str) -> tuple[str, str]:
    """Returns (param_name, value) for channels.list - `id` for raw channel IDs,
    `forHandle` for everything else (works with or without a leading @)."""
    candidate = handle or url.rsplit("/", 1)[-1]
    if candidate.startswith("UC") and len(candidate) == 24:
        return "id", candidate
    return "forHandle", candidate.lstrip("@")


def fetch_channel(client: httpx.Client, api_key: str, handle: str, url: str) -> dict:
    param_name, value = _channel_id_param(handle, url)
    data = _get_with_backoff(
        client,
        f"{YOUTUBE_API_BASE}/channels",
        {"part": "snippet,contentDetails", param_name: value, "key": api_key},
    )
    items = data.get("items") or []
    if not items:
        raise FetchError(f"No YouTube channel found for {param_name}={value}")
    return items[0]


def fetch_recent_videos(client: httpx.Client, api_key: str, uploads_playlist_id: str, count: int = RECENT_VIDEO_COUNT) -> list[dict]:
    data = _get_with_backoff(
        client,
        f"{YOUTUBE_API_BASE}/playlistItems",
        {
            "part": "snippet",
            "playlistId": uploads_playlist_id,
            "maxResults": count,
            "key": api_key,
        },
    )
    items = data.get("items") or []
    video_ids = [item["snippet"]["resourceId"]["videoId"] for item in items]
    if not video_ids:
        return []

    # playlistItems thumbnails aren't reliably maxres; videos.list is.
    videos_data = _get_with_backoff(
        client,
        f"{YOUTUBE_API_BASE}/videos",
        {"part": "snippet", "id": ",".join(video_ids), "key": api_key},
    )
    by_id = {v["id"]: v for v in videos_data.get("items") or []}

    videos = []
    for item in items:
        vid = item["snippet"]["resourceId"]["videoId"]
        video = by_id.get(vid)
        if not video:
            continue
        thumbs = video["snippet"]["thumbnails"]
        thumb_url = (thumbs.get("maxres") or thumbs.get("high") or thumbs.get("standard") or thumbs["default"])["url"]
        videos.append(
            {
                "video_id": vid,
                "title": video["snippet"]["title"],
                "url": f"https://www.youtube.com/watch?v={vid}",
                "thumbnail_url": thumb_url,
            }
        )
    return videos


def _download(client: httpx.Client, url: str, dest: Path) -> None:
    if dest.exists():
        return  # cached - reruns cost nothing
    resp = client.get(url)
    resp.raise_for_status()
    dest.write_bytes(resp.content)


def fetch_lead(lead: Lead, api_key: str, client: Optional[httpx.Client] = None) -> dict:
    """Fetches avatar + recent video thumbnails for a YouTube lead and caches
    them under work/<slug>/candidates/. Writes work/<slug>/meta.json.

    Non-YouTube leads are not scraped (SPEC.md 3.1) - raises NeedsManualPhoto
    unless work/<slug>/manual.jpg already exists.
    """
    candidates_dir = lead.work_dir / "candidates"

    if lead.platform.strip().lower() != "youtube":
        manual_path = lead.work_dir / "manual.jpg"
        if manual_path.exists():
            return {"platform": lead.platform, "manual_photo": True}
        raise NeedsManualPhoto(f"{lead.slug}: drop a photo at {manual_path} (IG/TikTok not scraped)")

    owns_client = client is None
    client = client or httpx.Client(timeout=30.0)
    try:
        candidates_dir.mkdir(parents=True, exist_ok=True)

        channel = fetch_channel(client, api_key, lead.handle, lead.url)
        avatar_url = channel["snippet"]["thumbnails"]["high"]["url"]
        _download(client, avatar_url, candidates_dir / "avatar.jpg")

        uploads_playlist_id = channel["contentDetails"]["relatedPlaylists"]["uploads"]
        videos = fetch_recent_videos(client, api_key, uploads_playlist_id)
        for i, video in enumerate(videos):
            _download(client, video["thumbnail_url"], candidates_dir / f"video_{i:02d}.jpg")

        meta = {
            "channel_id": channel["id"],
            "channel_title": channel["snippet"]["title"],
            "avatar_candidate": "avatar.jpg",
            "video_candidates": [f"video_{i:02d}.jpg" for i in range(len(videos))],
            "most_recent_video": videos[0] if videos else None,
            "videos": videos,
        }
        (lead.work_dir / "meta.json").write_text(json.dumps(meta, indent=2))
        return meta
    finally:
        if owns_client:
            client.close()
