"""Gmail draft creation (SPEC.md 3.6). No send code path exists here - only
users.drafts.create, and only the gmail.compose OAuth scope is ever requested."""

from __future__ import annotations

import base64
import csv
import json
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from jinja2 import Environment, FileSystemLoader

from .leads import Lead, ROOT

SCOPES = ["https://www.googleapis.com/auth/gmail.compose"]
TOKEN_PATH = ROOT / "token.json"
TEMPLATES_DIR = ROOT / "templates"
OUT_DIR = ROOT / "out"
STATUS_CSV = OUT_DIR / "status.csv"

_jinja_env = Environment(loader=FileSystemLoader(TEMPLATES_DIR))


class NoEmailAddress(Exception):
    pass


def _email_context(lead: Lead, settings, meta: dict) -> dict:
    recent_video = (meta or {}).get("most_recent_video") or {}
    return {
        "first_name": lead.first_name,
        "recent_video_title": recent_video.get("title", "your latest video"),
        "rev_share_pct": settings.rev_share_pct,
        "sender_name": settings.sender_name,
        "product_url": settings.product_url,
    }


def render_email(lead: Lead, settings, meta: dict) -> tuple[str, str]:
    """Renders templates/email.txt.j2 and splits its `Subject: ...` first
    line from the body. Returns (subject, body)."""
    rendered = _jinja_env.get_template("email.txt.j2").render(**_email_context(lead, settings, meta))
    first_line, _, rest = rendered.partition("\n")
    if not first_line.startswith("Subject:"):
        raise ValueError("templates/email.txt.j2 must start with 'Subject: ...'")
    subject = first_line[len("Subject:") :].strip()
    return subject, rest.lstrip("\n")


def render_dm(lead: Lead, settings, meta: dict) -> str:
    return _jinja_env.get_template("dm.txt.j2").render(**_email_context(lead, settings, meta))


def _get_gmail_service(credentials_path: Path):
    creds: Optional[Credentials] = None
    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(credentials_path), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_PATH.write_text(creds.to_json())
    return build("gmail", "v1", credentials=creds)


def _build_raw_message(to_email: str, subject: str, body: str, attachment_path: Path) -> str:
    message = MIMEMultipart()
    message["to"] = to_email
    message["subject"] = subject
    message.attach(MIMEText(body, "plain"))

    part = MIMEApplication(attachment_path.read_bytes(), Name=attachment_path.name)
    part["Content-Disposition"] = f'attachment; filename="{attachment_path.name}"'
    message.attach(part)

    return base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")


def create_draft(lead: Lead, settings, meta: dict, credentials_path: Path) -> dict:
    """Creates a Gmail draft (never sends). Raises NoEmailAddress if the lead
    has no usable email - caller should fall back to render_dm instead."""
    if not lead.email:
        raise NoEmailAddress(lead.slug)

    subject, body = render_email(lead, settings, meta)
    grid_path = lead.work_dir / "grid.jpg"
    raw = _build_raw_message(lead.email, subject, body, grid_path)

    service = _get_gmail_service(credentials_path)
    return service.users().drafts().create(userId="me", body={"message": {"raw": raw}}).execute()


def write_dm_file(lead: Lead, settings, meta: dict) -> Path:
    dm_path = lead.work_dir / "dm.txt"
    dm_path.write_text(render_dm(lead, settings, meta))
    return dm_path


def append_status(name: str, status: str, date: str) -> None:
    """Appends to out/status.csv so the user can paste status back into the
    lead-tracking Sheet. Creates the file with a header on first use."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    is_new = not STATUS_CSV.exists()
    with STATUS_CSV.open("a", newline="") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(["Name", "Status", "Date"])
        writer.writerow([name, status, date])
