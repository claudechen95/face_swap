# Coach Outreach Pipeline — Spec

Goal: for each dating-coach lead, make a personalized "see yourself in other photos" demo
with faceswap.fit-quality output, and put a ready-to-review Gmail draft in the user's inbox.
**The pipeline never sends email.** A human reviews every grid and every draft.

**Corrected 2026-11-13:** faceswap.fit swaps a person's face onto *other* photos (the live
product's free-preview flow lets a user pick from a library of target photos and see their
own face in them). An earlier version of this spec incorrectly described the demo as a
hairstyle/beard preview tool that edits the lead's own photo - that doesn't match the real
product and was corrected after generating a batch of demo images on the wrong premise.

First milestone: run end-to-end on **10 tier-A leads**, then stop and let the user judge output
quality before scaling.

---

## 1. Stack & setup

- Python 3.11, managed with `uv`. Single CLI: `outreach` (Typer).
- Libraries: `httpx`, `pillow`, `opencv-python`, `insightface` + `onnxruntime` (buffalo_l), `numpy`, `google-api-python-client`, `google-auth-oauthlib`, `jinja2`, `pydantic`, `pyyaml`.
- `.env` (never commit):
  - `YOUTUBE_API_KEY` — YouTube Data API v3
  - `IDEOGRAM_API_KEY` — image generation (character-reference inpaint, same engine the live product uses)
  - `GMAIL_CREDENTIALS=credentials.json` — OAuth desktop client; requests **only** the `gmail.compose` scope
  - `SENDER_NAME`, `PRODUCT_URL`, `REV_SHARE_PCT`
  - `IDEOGRAM_COST_PER_IMAGE_USD` — optional, for a real dollar total in `generate`'s summary
- Repo layout:
  ```
  outreach/
    cli.py          # Typer entrypoint
    leads.py        # CSV in/out, slugging, state
    fetch.py        # photo + recent-video fetch
    faces.py        # detection, quality gate, identity embedding
    generate.py     # Generator interface + Ideogram character-swap backend
    grid.py         # before/after composite
    review.py       # static review page -> approved.csv
    drafts.py       # Gmail draft creation
    purge.py        # data deletion
    settings.py     # .env loader
  templates/email.txt.j2, dm.txt.j2, review.html.j2
  config/targets.yaml, config/targets/*.jpg + *_mask.png
  data/leads.csv    # input (exported from the Sheet)
  work/<slug>/      # per-lead artifacts (gitignored)
  state.json        # per-lead stage + timestamps (gitignored)
  ```

## 2. Input

`data/leads.csv`, exported from the "Dating Coach Leads" Sheet. Columns used: `Name, Tier, Status, Platform, Handle, URL, Contact found`.

- `slug` = lowercase name, non-alphanumerics → `-`.
- Filter flags on every command: `--tier A`, `--limit N`, `--only <slug>`.
- Skip leads whose Status is anything but `Not contacted`.

## 3. Stages (each idempotent, resumable, recorded in `state.json`)

### 3.1 `outreach fetch`
- **YouTube** (handle `@x` → `channels.list?forHandle=`, `UC…` id → `channels.list?id=`):
  - avatar: `snippet.thumbnails.high.url`
  - last 10 uploads via the uploads playlist → each video's `maxres`/`high` thumbnail (via `videos.list`, since `playlistItems` doesn't reliably carry `maxres`), plus title + URL of the most recent video (used in the email)
  - save to `work/<slug>/candidates/`, metadata to `work/<slug>/meta.json`
- **Instagram / TikTok:** do **not** scrape. Look for a manually dropped `work/<slug>/manual.jpg`; if missing, mark `needs_manual_photo` and move on.
- Respect quota: back off on 403/429; cache everything so reruns cost nothing.

### 3.2 `outreach filter` — face quality gate
Using InsightFace on every candidate, keep the best image that passes **all**:
- exactly one face with detection score ≥ 0.7 (thumbnails with two people → reject)
- face box short side ≥ 256 px
- |yaw| ≤ 25°, |pitch| ≤ 20°
- sharpness: variance of Laplacian on the face crop ≥ 100
- not obviously stylized/graphic (small face box + high edge density heuristic)

Rank passing images by face size × det score. Save `work/<slug>/source.jpg` and its ArcFace embedding (`embedding.npy`). If none pass → `no_usable_photo`. Expect 30–50% of leads to land here; that's fine.

### 3.3 `outreach generate`
- `Generator` interface: `swap(target_path, reference_path, mask_path=None) -> Path`. `IdeogramGenerator` calls Ideogram's character-reference inpaint endpoint (`v2/image/inpaint/ideogram-3-character`) - the same engine `api/_lib/ideogram.js` uses in production: target photo + mask (black=edit/white=preserve at the API boundary) + the lead's own photo as `character_reference_images`.
- Target photos come from `config/targets.yaml` (default 3): real photos from the live product's reference library (`face_swap/target/`), each with its own **hand-painted mask** where available (`load_painted_mask`) - preferred over the algorithmic fallback (`build_face_contour_mask`, an InsightFace 106-landmark jaw contour) since a human-painted mask is higher quality than any automatic estimate.
- **Identity gate:** ArcFace cosine similarity(lead's source photo, swap result) must be ≥ `IDENTITY_THRESHOLD` (0.30 as of 2026-11-13, lowered from an initial 0.45 after live testing showed 0.45 rejected results that were visually clearly the same person - recalibrate after reviewing a full real batch). Below → retry once, then drop that target. Fewer than 2 surviving targets → `generation_failed`.
- Log per-attempt similarity/latency to `state.json` (`generate` stage's `attempts` list).
- **Never train a model (LoRA or otherwise) on a lead's face.** Single-image swaps only.

### 3.4 `outreach grid`
- Pillow composite: the lead's own photo + each surviving swap, labeled "Before" / target labels, consistent face-centered crop per panel (computed independently per image since Ideogram's output resolution can differ from the input), 1600 px wide JPEG, small `faceswap.fit` mark bottom-right. Save `work/<slug>/grid.jpg`.

### 3.5 `outreach review`
- Render `work/review.html` (Jinja): one card per lead with the grid, identity similarity scores, and the drafted email text. Approve/reject toggle per lead plus optional note.
- Static page, no server: a "Download approved.csv" button builds the CSV client-side from checkbox/note state and triggers a browser download. Save it to `work/approved.csv` before running `outreach draft`.
- **Human judgment calls this step exists for:** the pipeline has no automated gender filter (the CSV only tracks audience gender, not the coach's own) - skip female coaches, and anything that could read as mocking, per section 5.

### 3.6 `outreach draft`
- For approved leads **with an email address** in `Contact found`: create a Gmail **draft** (`users.drafts.create`) with `grid.jpg` attached, rendered from `templates/email.txt.j2`.
- For approved leads without an email: write `work/<slug>/dm.txt` from `templates/dm.txt.j2` for the user to paste manually.
- Mark state `drafted` and append to `out/status.csv` (`Name, Status=Demo made, Date`) so the user can paste the status back into the Sheet.
- **No send code path exists.** Do not add one.

### 3.7 `outreach purge`
- `--slug x` deletes `work/<slug>/` and its `state.json` entry (e.g. someone asks to be removed).
- `--older-than 30d --status no_reply` does the same for every lead whose latest recorded stage activity is older than N days and whose state.json `reply_status` field matches (a free-form tag set by hand - this pipeline never reads replies itself).
- Embeddings are never stored anywhere but `work/<slug>/`.

## 4. Email template (`templates/email.txt.j2`)

```
Subject: Made you a profile-photo preview, {{ first_name }}

Hi {{ first_name }},

Loved your video "{{ recent_video_title }}". The part about guys not having good photos to work with stuck with me.

So I ran your photo through a tool I built, faceswap.fit. It puts a guy's actual face into other photos - different settings, outfits, angles - so he can preview new dating-profile shots without booking a photographer. Attached are a few examples on you.

Your clients could use it to line up strong profile photo options before a shoot, or skip the shoot entirely. Happy to give you free access to use with clients, plus {{ rev_share_pct }}% of anything your audience buys through your link.

Worth a 10-minute call?

{{ sender_name }}
{{ product_url }}

(If this isn't your thing, reply "no" and I'll delete the images.)
```

`templates/dm.txt.j2`: same pitch in ≤ 4 sentences, no attachment reference (user attaches the grid manually).

## 5. Volume & sending guidance (for the human, printed by `outreach draft`)
- Send 10–15/day max, ideally from a dedicated domain, not a personal Gmail.
- Skip female coaches and any lead where the demo could read as mocking; ask first instead.
- Honor any "no" immediately: `outreach purge --slug <slug>`.

## 6. Acceptance for milestone 1
- `outreach fetch filter generate grid review --tier A --limit 10` completes, reruns are no-ops.
- Review page shows ≥ 5 leads with a usable grid; each surviving swap passes the identity gate.
- `outreach draft` creates Gmail drafts only for approved leads with emails; nothing is sent.
- Total spend and per-lead cost are printed at the end (requires `IDEOGRAM_COST_PER_IMAGE_USD`; Ideogram doesn't publish a confirmed per-call price for this endpoint).

## 7. Out of scope (v1)
Auto-sending, follow-up sequences, IG/TikTok scraping, LoRA training on leads, posting any lead's images publicly.
