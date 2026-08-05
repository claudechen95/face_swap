import argparse
import json
import os
import tempfile
import threading
import time
import zipfile

import fal_client

APP = "fal-ai/flux-lora-portrait-trainer"


def parse_args():
    p = argparse.ArgumentParser(description="Train a FLUX portrait LoRA via fal.ai")
    p.add_argument("--name", required=True, help="Output prefix, e.g. character2 or character2_1000steps")
    p.add_argument("--photos-dir", help="Folder of cropped training photos (required unless --request-id is given)")
    p.add_argument("--trigger", help="Trigger phrase, e.g. sksperson2 (required unless --request-id is given)")
    p.add_argument("--steps", type=int, default=1000)
    p.add_argument("--learning-rate", type=float, default=0.0001)
    p.add_argument("--request-id", help="Skip submission and just poll/fetch an already-submitted job")
    args = p.parse_args()
    if args.request_id is None and (not args.photos_dir or not args.trigger):
        p.error("--photos-dir and --trigger are required unless --request-id is given")
    return args


def submit(photos_dir, trigger, steps, learning_rate):
    paths = sorted(
        p for p in os.listdir(photos_dir)
        if p.lower().endswith((".jpg", ".jpeg", ".png"))
    )
    fd, zip_path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    with zipfile.ZipFile(zip_path, "w") as zf:
        for name in paths:
            zf.write(os.path.join(photos_dir, name), arcname=name)
    print(f"Zipped {len(paths)} photos -> {zip_path}", flush=True)

    images_data_url = None
    last_exc = None
    for attempt in range(1, 4):
        print(f"Uploading zip (attempt {attempt}/3)...", flush=True)
        stop_heartbeat = threading.Event()

        def heartbeat(start=time.time()):
            while not stop_heartbeat.wait(15):
                print(f"  ...still uploading ({int(time.time() - start)}s elapsed)", flush=True)

        hb_thread = threading.Thread(target=heartbeat, daemon=True)
        hb_thread.start()
        try:
            images_data_url = fal_client.upload_file(zip_path)
            break
        except Exception as exc:
            last_exc = exc
            print(f"Upload attempt {attempt}/3 failed: {exc}", flush=True)
            if attempt < 3:
                time.sleep(5 * attempt)
        finally:
            stop_heartbeat.set()
            hb_thread.join()
    if images_data_url is None:
        raise last_exc
    print(f"Uploaded training zip: {images_data_url}", flush=True)

    handle = fal_client.submit(
        APP,
        arguments={
            "images_data_url": images_data_url,
            "trigger_phrase": trigger,
            "steps": steps,
            "learning_rate": learning_rate,
            "create_masks": True,
            "subject_crop": True,
        },
    )
    return handle.request_id


def main():
    args = parse_args()

    request_id = args.request_id
    if request_id is None:
        request_id = submit(args.photos_dir, args.trigger, args.steps, args.learning_rate)
        open(f"{args.name}_train_request_id.txt", "w").write(request_id)
        print(f"Submitted request_id: {request_id}", flush=True)

    while True:
        status = fal_client.status(APP, request_id, with_logs=False)
        print(type(status).__name__, flush=True)
        if isinstance(status, fal_client.Completed):
            break
        time.sleep(10)

    result = fal_client.result(APP, request_id)
    lora_url = result["diffusers_lora_file"]["url"]
    open(f"lora_url_{args.name}.txt", "w").write(lora_url)
    json.dump(result, open(f"lora_training_result_{args.name}.json", "w"), indent=2)

    print("DONE", flush=True)
    print("lora_url:", lora_url, flush=True)


if __name__ == "__main__":
    main()
