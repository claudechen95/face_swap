"""
Automated pipeline runner: polls Supabase for leads that finished uploading
their face photos or their target photos, and drives crop -> train -> swap
via pipeline.py, replacing the old manual per-lead script + zip-file
workflow.

Usage:
    python3 watch_and_process.py            # loop forever, poll every 30s
    python3 watch_and_process.py --once      # run a single cycle and exit (cron-friendly)
    python3 watch_and_process.py --retry     # also clear failed rows so they're retried this cycle
    python3 watch_and_process.py --interval 60
"""

from __future__ import annotations

import argparse
import time

from dotenv import load_dotenv

import pipeline
import supabase_io as sio

DEFAULT_INTERVAL = 30


def run_cycle(client) -> None:
    for column, owner_id in sio.list_leads_ready_to_train(client):
        pipeline.train_for_lead(client, column, owner_id)

    for model in sio.list_face_models_by_status(client, "training"):
        pipeline.poll_training(client, model)

    for pending in sio.list_leads_ready_to_swap(client):
        pipeline.swap_for_lead(client, pending["model"], pending["column"], pending["owner_id"], pending["targets"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Run a single cycle and exit")
    parser.add_argument("--retry", action="store_true", help="Clear failed rows so they're retried this run")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL, help="Seconds between cycles (loop mode)")
    args = parser.parse_args()

    load_dotenv()
    client = sio.get_client()

    if args.retry:
        cleared_models = sio.delete_failed_face_models(client)
        cleared_jobs = sio.delete_failed_swap_jobs(client)
        print(f"[retry] cleared {cleared_models} failed face_models, {cleared_jobs} failed swap_jobs")

    if args.once:
        run_cycle(client)
        return

    print(f"Watching for work every {args.interval}s (Ctrl+C to stop)...")
    while True:
        try:
            run_cycle(client)
        except Exception as exc:
            # Never let one bad cycle kill the loop -- log and keep polling.
            print(f"[cycle] unexpected error: {exc!r}")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
