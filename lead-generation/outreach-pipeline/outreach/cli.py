"""Typer entrypoint wiring all pipeline stages together (SPEC.md 3).

Every command is idempotent/resumable: it re-derives what's already done from
state.json and only does fresh work for leads that need it. No command here
ever sends an email - `draft` only creates Gmail drafts or local dm.txt files.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import typer

from . import drafts, grid as grid_mod, purge as purge_mod, review as review_mod
from .faces import NoUsablePhoto, filter_lead
from .fetch import NeedsManualPhoto, fetch_lead
from .generate import (
    GenerateReport,
    GenerationFailed,
    IdeogramGenerator,
    TargetResult,
    generate_lead,
    load_targets_config,
)
from .leads import ROOT, filter_leads, get_stage, load_leads, set_stage
from .settings import Settings

app = typer.Typer(help="Coach outreach pipeline - fetch, filter, generate, grid, review, draft.")

TARGETS_CONFIG_PATH = ROOT / "config" / "targets.yaml"


def _load_targets_config() -> dict:
    """Resolves targets_dir relative to the project root regardless of where
    `outreach` is invoked from."""
    config = load_targets_config(TARGETS_CONFIG_PATH)
    config["targets_dir"] = str(ROOT / config["targets_dir"])
    return config

TierOption = typer.Option(None, "--tier", help="Only this tier, e.g. A")
LimitOption = typer.Option(None, "--limit", help="Cap the number of leads")
OnlyOption = typer.Option(None, "--only", help="Only this lead's slug")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _selected_leads(tier: Optional[str], limit: Optional[int], only: Optional[str]) -> list:
    leads = load_leads()
    selected = filter_leads(leads, tier=tier, limit=limit, only=only)
    if not selected:
        typer.echo("No leads matched the given filters (or all are already past 'Not contacted').")
    return selected


def _load_meta(lead) -> dict:
    meta_path = lead.work_dir / "meta.json"
    return json.loads(meta_path.read_text()) if meta_path.exists() else {}


@app.command()
def fetch(tier: Optional[str] = TierOption, limit: Optional[int] = LimitOption, only: Optional[str] = OnlyOption):
    """Fetch avatar + recent video thumbnails (YouTube) or check for a manually-dropped photo (others)."""
    settings = Settings.load()
    if not settings.youtube_api_key:
        typer.echo("YOUTUBE_API_KEY is not set in .env - YouTube leads will fail.", err=True)

    leads = _selected_leads(tier, limit, only)
    now = _now()
    ok = needs_manual = errors = 0
    for lead in leads:
        try:
            fetch_lead(lead, settings.youtube_api_key)
            set_stage(lead.slug, "fetch", now, status="ok")
            ok += 1
        except NeedsManualPhoto as e:
            set_stage(lead.slug, "fetch", now, status="needs_manual_photo", error=str(e))
            needs_manual += 1
        except Exception as e:
            set_stage(lead.slug, "fetch", now, status="error", error=str(e))
            errors += 1
    typer.echo(f"fetch: {ok} ok, {needs_manual} need a manual photo, {errors} errored (of {len(leads)})")


@app.command(name="filter")
def filter_cmd(tier: Optional[str] = TierOption, limit: Optional[int] = LimitOption, only: Optional[str] = OnlyOption):
    """Face quality gate: pick the best candidate photo per lead."""
    leads = _selected_leads(tier, limit, only)
    now = _now()
    ok = no_photo = errors = 0
    for lead in leads:
        try:
            result = filter_lead(lead)
            source_kind = "video_thumbnail" if result.path.stem.startswith("video_") else result.path.stem
            set_stage(
                lead.slug,
                "filter",
                now,
                status="ok",
                det_score=result.det_score,
                face_area=result.face_area,
                source_kind=source_kind,
            )
            ok += 1
        except NoUsablePhoto as e:
            set_stage(lead.slug, "filter", now, status="no_usable_photo", error=str(e))
            no_photo += 1
        except Exception as e:
            set_stage(lead.slug, "filter", now, status="error", error=str(e))
            errors += 1
    typer.echo(f"filter: {ok} ok, {no_photo} no usable photo, {errors} errored (of {len(leads)})")


@app.command()
def generate(tier: Optional[str] = TierOption, limit: Optional[int] = LimitOption, only: Optional[str] = OnlyOption):
    """Swap the lead's face onto the configured target photos via Ideogram, gated by ArcFace identity similarity."""
    settings = Settings.load()
    if not settings.ideogram_api_key:
        typer.echo("IDEOGRAM_API_KEY is not set in .env - generate will fail.", err=True)
    config = _load_targets_config()
    generator = IdeogramGenerator(api_key=settings.ideogram_api_key)

    leads = _selected_leads(tier, limit, only)
    now = _now()
    ok = failed = errors = 0
    total_attempts = 0
    total_latency = 0.0
    for lead in leads:
        try:
            report = generate_lead(lead, config, generator)
            total_attempts += len(report.attempts)
            total_latency += sum(a["latency_s"] for a in report.attempts)
            set_stage(
                lead.slug,
                "generate",
                now,
                status="ok",
                survived={target_id: r.similarity for target_id, r in report.survived.items()},
                attempts=report.attempts,
            )
            ok += 1
        except GenerationFailed as e:
            set_stage(lead.slug, "generate", now, status="generation_failed", error=str(e))
            failed += 1
        except Exception as e:
            set_stage(lead.slug, "generate", now, status="error", error=str(e))
            errors += 1

    typer.echo(f"generate: {ok} ok, {failed} failed identity gate, {errors} errored (of {len(leads)})")
    typer.echo(f"generate: {total_attempts} image calls, {total_latency:.0f}s total latency")
    if settings.ideogram_cost_per_image_usd:
        cost = total_attempts * float(settings.ideogram_cost_per_image_usd)
        per_lead = cost / len(leads) if leads else 0
        typer.echo(f"generate: ~${cost:.2f} total spend (${per_lead:.2f}/lead) at your configured $/image rate")
    else:
        typer.echo("generate: set IDEOGRAM_COST_PER_IMAGE_USD in .env for a dollar total (check your Ideogram billing page)")


@app.command()
def grid(tier: Optional[str] = TierOption, limit: Optional[int] = LimitOption, only: Optional[str] = OnlyOption):
    """Build the before/after composite for every lead with surviving swaps."""
    config = _load_targets_config()
    targets_by_id = {target["id"]: target for target in config["targets"]}

    leads = _selected_leads(tier, limit, only)
    now = _now()
    ok = skipped = errors = 0
    for lead in leads:
        generate_stage = get_stage(lead.slug, "generate")
        if not generate_stage or generate_stage.get("status") != "ok":
            skipped += 1
            continue
        try:
            report = GenerateReport()
            for target_id, sim in generate_stage.get("survived", {}).items():
                report.survived[target_id] = TargetResult(target_id, lead.work_dir / f"target_{target_id}.jpg", sim)
            grid_mod.build_grid(lead, report, targets_by_id)
            set_stage(lead.slug, "grid", now, status="ok")
            ok += 1
        except Exception as e:
            set_stage(lead.slug, "grid", now, status="error", error=str(e))
            errors += 1
    typer.echo(f"grid: {ok} ok, {skipped} skipped (generate not ok), {errors} errored (of {len(leads)})")


@app.command()
def review(tier: Optional[str] = TierOption, limit: Optional[int] = LimitOption, only: Optional[str] = OnlyOption):
    """Render work/review.html - open it in a browser, approve leads, download approved.csv."""
    settings = Settings.load()
    leads = _selected_leads(tier, limit, only)
    path = review_mod.build_review_page(leads, settings)
    typer.echo(f"Wrote {path}")
    typer.echo(f"Open it in a browser, approve leads, then save the downloaded approved.csv to {review_mod.APPROVED_CSV}")
    typer.echo("before running `outreach draft`. Nothing is sent from this step.")


@app.command()
def draft(tier: Optional[str] = TierOption, limit: Optional[int] = LimitOption, only: Optional[str] = OnlyOption):
    """Create Gmail drafts for approved leads with an email; write dm.txt for the rest. Never sends anything."""
    settings = Settings.load()
    if not Path(settings.gmail_credentials).exists():
        typer.echo(f"GMAIL_CREDENTIALS file not found at {settings.gmail_credentials}", err=True)
        raise typer.Exit(1)

    approved = review_mod.load_approved()
    if not approved:
        typer.echo(f"No approved leads in {review_mod.APPROVED_CSV} - run `outreach review` first.")
        raise typer.Exit(0)

    leads_by_slug = {lead.slug: lead for lead in _selected_leads(tier, limit, only)}
    now = _now()
    today = now[:10]
    drafted = dm_written = errors = 0
    for slug in approved:
        lead = leads_by_slug.get(slug)
        if not lead:
            continue
        meta = _load_meta(lead)
        try:
            if lead.email:
                drafts.create_draft(lead, settings, meta, Path(settings.gmail_credentials))
                set_stage(lead.slug, "draft", now, status="ok", channel="gmail_draft")
                drafted += 1
            else:
                drafts.write_dm_file(lead, settings, meta)
                set_stage(lead.slug, "draft", now, status="ok", channel="dm_file")
                dm_written += 1
            drafts.append_status(lead.name, "Demo made", today)
        except Exception as e:
            set_stage(lead.slug, "draft", now, status="error", error=str(e))
            errors += 1

    typer.echo(f"draft: {drafted} Gmail drafts created, {dm_written} dm.txt files written, {errors} errored")
    typer.echo("No send code path exists in this tool - review every draft/dm.txt by hand before sending.")
    typer.echo("Send max 10-15/day, ideally from a dedicated domain. Skip female coaches and any lead where")
    typer.echo("the edit could read as mocking - ask first instead. Honor any 'no' immediately:")
    typer.echo("  outreach purge --slug <slug>")


@app.command()
def purge(
    slug: Optional[str] = typer.Option(None, "--slug"),
    older_than: Optional[str] = typer.Option(None, "--older-than", help="e.g. 30d"),
    status: Optional[str] = typer.Option(None, "--status", help="matches a lead's manually-set reply_status"),
):
    """Delete a lead's local images/embeddings. --older-than/--status relies on
    reply_status being set by hand (this tool never reads replies itself)."""
    if slug:
        removed = purge_mod.purge_slug(slug)
        typer.echo(f"purged {slug}" if removed else f"nothing to purge for {slug}")
        return
    if older_than and status:
        days = int(older_than.rstrip("dD"))
        purged = purge_mod.purge_older_than(days, status)
        typer.echo(f"purged {len(purged)} lead(s): {', '.join(purged) if purged else '(none matched)'}")
        return
    typer.echo("Specify --slug <slug>, or both --older-than <Nd> and --status <tag>.", err=True)
    raise typer.Exit(1)


if __name__ == "__main__":
    app()
