import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { normalizePhone } from './phone.js';
import { captureReferralCode, getReferralCode } from './referral.js';

captureReferralCode();

const SUPABASE_URL = 'https://vmiufreohdigjazlupnl.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_7nfagmcp_2US_6rqtHQjTg_6nca5V7T';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const urlParams = new URLSearchParams(location.search);
const urlToken = urlParams.get('token');
const urlViewAs = urlParams.get('viewAs');

// A legacy shareable link (?token=), an admin "view as" link (?viewAs=), or a real signed-in session.
let authMode = null; // { type: 'token', token } | { type: 'viewAs', viewAs } | { type: 'session', accessToken }

function apiBody(kind, extra) {
  let base = {};
  if (authMode.type === 'token') base = { token: authMode.token };
  else if (authMode.type === 'viewAs') base = { viewAs: authMode.viewAs };
  return { ...base, ...(kind ? { kind } : {}), ...extra };
}

function apiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (authMode.type === 'session') headers.Authorization = `Bearer ${authMode.accessToken}`;
  return headers;
}

const states = document.querySelectorAll('.upload-state');
const showState = (name) => {
  states.forEach((el) => {
    el.hidden = el.dataset.state !== name;
  });
};

const readyState = document.querySelector('[data-state="ready"]');
const faceSection = readyState.querySelector('[data-section="face"]');
const targetSection = readyState.querySelector('[data-section="target"]');
const resultsSection = readyState.querySelector('[data-section="results"]');

function showError(errorEl, message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

// ---------------------------------------------------------------------------
// Shared file-row rendering + upload/remove, used by both the face and the
// target dropzones (they differ only in `kind` and which section they live in).
// ---------------------------------------------------------------------------

function createFileList(fileListEl) {
  function addFileRow(name, thumbUrl) {
    const li = document.createElement('li');
    li.className = 'file-row';

    const top = document.createElement('div');
    top.className = 'file-row-top';

    const thumb = document.createElement('img');
    thumb.className = 'file-row-thumb';
    thumb.src = thumbUrl;
    thumb.alt = '';

    const nameEl = document.createElement('span');
    nameEl.className = 'file-row-name';
    nameEl.textContent = name;

    const status = document.createElement('span');
    status.className = 'file-row-status';
    status.textContent = 'Uploading…';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'file-row-remove';
    removeBtn.setAttribute('aria-label', `Remove ${name}`);
    removeBtn.textContent = '✕';
    removeBtn.disabled = true;

    top.append(thumb, nameEl, status, removeBtn);

    const bar = document.createElement('div');
    bar.className = 'file-row-bar';
    bar.appendChild(document.createElement('span'));

    li.append(top, bar);
    fileListEl.prepend(li);

    return { li, status, removeBtn, objectUrl: thumbUrl };
  }

  function markRowDone(row) {
    row.li.classList.add('is-done');
    row.status.textContent = 'Uploaded';
  }

  function markRowError(row, message) {
    row.li.classList.add('is-error');
    row.status.textContent = message || 'Failed';
  }

  return { addFileRow, markRowDone, markRowError };
}

async function removeRow(row, confirmedPath, kind, errorEl, onRemoved) {
  row.removeBtn.disabled = true;
  const previousText = row.status.textContent;
  row.status.textContent = 'Removing…';

  if (confirmedPath) {
    const response = await fetch('/api/upload-remove', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(apiBody(kind, { path: confirmedPath })),
    });
    if (!response.ok) {
      row.status.textContent = previousText;
      row.removeBtn.disabled = false;
      showError(errorEl, "Couldn't remove that photo — try again.");
      return;
    }
    if (onRemoved) onRemoved(confirmedPath);
  }

  URL.revokeObjectURL(row.objectUrl);
  row.li.remove();
}

async function uploadFile(file, kind, helpers, errorEl, onConfirmed) {
  const objectUrl = URL.createObjectURL(file);
  const row = helpers.addFileRow(file.name, objectUrl);
  let confirmedPath = null;

  row.removeBtn.addEventListener('click', () => removeRow(row, confirmedPath, kind, errorEl, (path) => onConfirmed?.onRemoved?.(path)));

  const signResponse = await fetch('/api/upload-sign', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(apiBody(kind, { contentType: file.type })),
  });
  const signBody = await signResponse.json().catch(() => ({}));
  if (!signResponse.ok) {
    helpers.markRowError(row, signBody.error || 'Failed');
    row.removeBtn.disabled = false;
    return false;
  }

  const { error: uploadError } = await supabase.storage
    .from(signBody.bucket)
    .uploadToSignedUrl(signBody.path, signBody.signToken, file);

  if (uploadError) {
    helpers.markRowError(row, 'Failed');
    row.removeBtn.disabled = false;
    return false;
  }

  const confirmResponse = await fetch('/api/upload-confirm', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(apiBody(kind, { path: signBody.path })),
  });

  const confirmBody = await confirmResponse.json().catch(() => ({}));

  if (!confirmResponse.ok) {
    helpers.markRowError(row, confirmResponse.status === 422 ? 'Rejected' : 'Failed');
    if (confirmBody.error) showError(errorEl, confirmBody.error);
    row.removeBtn.disabled = false;
    return false;
  }

  confirmedPath = signBody.path;
  helpers.markRowDone(row);
  row.removeBtn.disabled = false;
  if (onConfirmed?.onDone) onConfirmed.onDone(confirmedPath, confirmBody, objectUrl);
  return true;
}

// ---------------------------------------------------------------------------
// Face section -- the single required reference photo. Finishes itself
// automatically (no "I'm done" step) as soon as it's uploaded.
// ---------------------------------------------------------------------------

const faceDropzone = faceSection.querySelector('[data-dropzone]');
const faceFileInput = faceSection.querySelector('#face-file-input');
const faceErrorEl = faceSection.querySelector('.upload-error');
const faceFileList = faceSection.querySelector('.file-list');
const faceSubEl = faceSection.querySelector('[data-sub]');
const faceHelpers = createFileList(faceFileList);
const faceRowsByPath = new Map();
const faceMaskOpenBtn = faceSection.querySelector('[data-face-mask-open]');
const faceMaskOpenLabelEl = faceMaskOpenBtn.querySelector('[data-face-mask-open-label]');

let faceRemaining = 0;
let faceUploaded = 0;
let faceMin = 0;
let faceNotified = false;
let faceNotifying = false;
let facePhotoUrl = null;
let faceMaskUrl = null;
let faceMaskReviewed = false;

function updateFaceMaskLinkState() {
  faceMaskOpenBtn.hidden = !facePhotoUrl;
  faceMaskOpenLabelEl.textContent = faceMaskReviewed ? 'Edit your face mask' : 'Review your face mask';
}

function updateFaceSub() {
  faceSubEl.textContent = faceRemaining <= 0 ? "You've sent your photo — thank you!" : 'Send one clear, well-lit photo of your face, facing the camera.';
}

function updateFaceDropzoneState() {
  faceDropzone.classList.toggle('is-disabled', faceRemaining <= 0);
}

function onFaceRemoved(path) {
  faceRemaining += 1;
  faceUploaded -= 1;
  faceRowsByPath.delete(path);
  facePhotoUrl = null;
  faceMaskUrl = null;
  faceMaskReviewed = false;
  updateFaceDropzoneState();
  updateFaceSub();
  updateFaceMaskLinkState();
  updateTargetLockState();
}

async function notifyFaceDone() {
  if (faceNotified || faceNotifying) return;
  faceNotifying = true;

  const response = await fetch('/api/notify-done', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(apiBody('face', {})),
  });

  faceNotifying = false;

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showError(faceErrorEl, body.error || 'Something went wrong — try again.');
    (body.badPaths || []).forEach((path) => {
      const row = faceRowsByPath.get(path);
      if (row) faceHelpers.markRowError(row, 'Multiple people');
    });
    return;
  }

  faceNotified = true;
  fetchAndRenderResults();
}

async function handleFaceFiles(fileListInput) {
  faceErrorEl.hidden = true;
  const files = Array.from(fileListInput).filter((file) => {
    if (!ALLOWED_TYPES.has(file.type)) return false;
    if (file.size > MAX_FILE_BYTES) return false;
    return true;
  });

  if (files.length < fileListInput.length) {
    showError(faceErrorEl, 'Some files were skipped — only JPG, PNG, WEBP, or HEIC photos up to 20MB are supported.');
  }

  const accepted = files.slice(0, faceRemaining);
  if (accepted.length < files.length) {
    showError(faceErrorEl, `You can only upload ${faceRemaining} more photo${faceRemaining === 1 ? '' : 's'}.`);
  }

  let justUploaded = false;
  for (const file of accepted) {
    const ok = await uploadFile(file, 'face', faceHelpers, faceErrorEl, {
      onDone: (path, confirmBody, objectUrl) => {
        faceRowsByPath.set(path, true);
        facePhotoUrl = objectUrl;
        faceMaskUrl = (confirmBody && confirmBody.maskUrl) || null;
        faceMaskReviewed = false; // a brand new (or replacement) photo always needs its own review
        justUploaded = true;
      },
      onRemoved: onFaceRemoved,
    });
    if (ok) {
      faceRemaining -= 1;
      faceUploaded += 1;
      updateFaceDropzoneState();
      updateFaceSub();
    }
  }

  if (justUploaded) {
    updateFaceMaskLinkState();
    updateTargetLockState();
    openFaceMaskModal();
  }

  if (faceUploaded >= faceMin) notifyFaceDone();
}

faceDropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  faceDropzone.classList.add('is-dragover');
});
faceDropzone.addEventListener('dragleave', () => faceDropzone.classList.remove('is-dragover'));
faceDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  faceDropzone.classList.remove('is-dragover');
  if (faceRemaining <= 0) return;
  handleFaceFiles(e.dataTransfer.files);
});
faceFileInput.addEventListener('change', () => {
  handleFaceFiles(faceFileInput.files);
  faceFileInput.value = '';
});

// ---------------------------------------------------------------------------
// Target section -- library picker + own uploads (no paywall for now, so
// both are unlocked for everyone). Picking/uploading a photo notifies admin
// once (not per-photo) and never requires an explicit "done" button.
// ---------------------------------------------------------------------------

const targetDropzone = targetSection.querySelector('[data-dropzone]');
const targetFileInput = targetSection.querySelector('#target-file-input');
const targetErrorEl = targetSection.querySelector('.upload-error');
const targetFileList = targetSection.querySelector('.file-list');
const targetSubEl = targetSection.querySelector('[data-sub]');
const targetHelpers = createFileList(targetFileList);
const libraryGrid = targetSection.querySelector('[data-library-grid]');
const libraryShowMoreBtn = targetSection.querySelector('[data-library-show-more]');
const libraryErrorEl = targetSection.querySelector('.library-error');
const targetLockedEl = targetSection.querySelector('[data-target-locked]');
const targetLockedMsgEl = targetSection.querySelector('[data-target-locked-msg]');
const targetLockedReviewBtn = targetSection.querySelector('[data-target-locked-review]');
const targetContentEl = targetSection.querySelector('[data-target-content]');

const LIBRARY_BATCH_SIZE = 24;
let libraryPhotos = [];
let libraryShownCount = 0;
let selectedLibraryPaths = new Set();

let targetRemaining = 0;
let targetUploaded = 0;
let targetMax = 0;
let targetNotified = false;

// Target photos stay locked until the end user has reviewed (saved) their
// auto-generated face mask at least once -- enforced server-side too (see
// hasReviewedFaceMask in api/_lib/identity.js), this is just the UI half.
function updateTargetLockState() {
  const locked = !faceMaskReviewed;
  targetLockedEl.hidden = !locked;
  targetContentEl.hidden = locked;
  if (!locked) return;
  targetLockedMsgEl.textContent = facePhotoUrl ? 'Review your face mask to unlock target photos.' : 'Upload your face photo above to get started.';
  targetLockedReviewBtn.hidden = !facePhotoUrl;
}
targetLockedReviewBtn.addEventListener('click', () => openFaceMaskModal());

function onTargetRemoved() {
  targetRemaining += 1;
  targetUploaded -= 1;
  updateTargetSub();
}

function updateTargetSub() {
  if (targetRemaining <= 0) {
    targetSubEl.textContent = `You've picked all ${targetMax} photos — thank you!`;
  } else if (targetUploaded === 0) {
    targetSubEl.textContent = `Pick the photos you want your face swapped into — dating profile shots, professional headshots, anything you like.`;
  } else {
    targetSubEl.textContent = `Nice, that's ${targetUploaded} of ${targetMax}! Add more anytime — up to ${targetRemaining} more.`;
  }
}

function showLibraryError(message) {
  libraryErrorEl.textContent = message;
  libraryErrorEl.hidden = false;
}

// The pipeline is already pinged directly by /api/library and
// /api/upload-confirm on every single pick -- this only sends the admin
// ntfy push, which should happen once per lead (not once per photo), so
// it's gated by a flag rather than re-sent on every pick.
async function notifyTargetDoneOnce() {
  if (targetNotified) return;
  targetNotified = true;
  try {
    await fetch('/api/notify-done', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(apiBody('target', {})) });
  } catch (err) {
    console.error('notify-done (target) failed', err);
  }
}

function buildLibraryCard(photo) {
  const li = document.createElement('li');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'library-card';
  btn.setAttribute('aria-label', 'Select this photo');

  const img = document.createElement('img');
  img.src = photo.url;
  img.alt = '';
  img.loading = 'lazy';

  const check = document.createElement('span');
  check.className = 'library-card-check';
  check.textContent = '✓';

  btn.append(img, check);
  li.appendChild(btn);
  libraryGrid.appendChild(li);

  if (selectedLibraryPaths.has(photo.storagePath)) {
    btn.classList.add('is-selected');
  }

  btn.addEventListener('click', () => toggleLibrarySelection(photo, btn));
}

function renderNextLibraryBatch() {
  const previousHeight = libraryGrid.scrollHeight;
  const isFirstBatch = libraryShownCount === 0;

  const batch = libraryPhotos.slice(libraryShownCount, libraryShownCount + LIBRARY_BATCH_SIZE);
  batch.forEach(buildLibraryCard);
  libraryShownCount += batch.length;
  libraryShowMoreBtn.hidden = libraryShownCount >= libraryPhotos.length;

  if (!isFirstBatch) {
    libraryGrid.scrollTo({ top: previousHeight, behavior: 'smooth' });
  }
}

function applyLibrarySelectionState(photo, cardEl, selected) {
  if (selected) {
    selectedLibraryPaths.add(photo.storagePath);
    cardEl.classList.add('is-selected');
    targetRemaining -= 1;
    targetUploaded += 1;
  } else {
    selectedLibraryPaths.delete(photo.storagePath);
    cardEl.classList.remove('is-selected');
    targetRemaining += 1;
    targetUploaded -= 1;
  }
  updateTargetSub();
}

async function toggleLibrarySelection(photo, cardEl) {
  libraryErrorEl.hidden = true;
  const wasSelected = selectedLibraryPaths.has(photo.storagePath);

  if (!wasSelected && targetRemaining <= 0) {
    showLibraryError(`You've reached the ${targetMax}-photo limit.`);
    return;
  }

  cardEl.disabled = true;
  cardEl.classList.add('is-pending');
  applyLibrarySelectionState(photo, cardEl, !wasSelected);

  const response = await fetch(wasSelected ? '/api/upload-remove' : '/api/library', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(apiBody('target', wasSelected ? { path: photo.storagePath } : { libraryPhotoId: photo.id })),
  }).catch(() => null);

  cardEl.disabled = false;
  cardEl.classList.remove('is-pending');

  if (!response || !response.ok) {
    applyLibrarySelectionState(photo, cardEl, wasSelected);
    const body = await response?.json().catch(() => ({}));
    showLibraryError((body && body.error) || `Couldn't ${wasSelected ? 'remove' : 'select'} that photo — try again.`);
    return;
  }

  if (typeof posthog !== 'undefined') posthog.capture(wasSelected ? 'library_photo_deselected' : 'library_photo_selected');
  fetchAndRenderResults();
  if (!wasSelected) notifyTargetDoneOnce();
}

libraryShowMoreBtn.addEventListener('click', renderNextLibraryBatch);

async function handleTargetFiles(fileListInput) {
  targetErrorEl.hidden = true;
  const files = Array.from(fileListInput).filter((file) => {
    if (!ALLOWED_TYPES.has(file.type)) return false;
    if (file.size > MAX_FILE_BYTES) return false;
    return true;
  });

  if (files.length < fileListInput.length) {
    showError(targetErrorEl, 'Some files were skipped — only JPG, PNG, WEBP, or HEIC photos up to 20MB are supported.');
  }

  const accepted = files.slice(0, targetRemaining);
  if (accepted.length < files.length) {
    showError(targetErrorEl, `You can only upload ${targetRemaining} more photo${targetRemaining === 1 ? '' : 's'}.`);
  }

  let addedAny = false;
  for (const file of accepted) {
    const ok = await uploadFile(file, 'target', targetHelpers, targetErrorEl, { onRemoved: onTargetRemoved });
    if (ok) {
      targetRemaining -= 1;
      targetUploaded += 1;
      updateTargetSub();
      addedAny = true;
    }
  }

  if (addedAny) {
    fetchAndRenderResults();
    notifyTargetDoneOnce();
  }
}

targetDropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  targetDropzone.classList.add('is-dragover');
});
targetDropzone.addEventListener('dragleave', () => targetDropzone.classList.remove('is-dragover'));
targetDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  targetDropzone.classList.remove('is-dragover');
  if (targetRemaining <= 0) return;
  handleTargetFiles(e.dataTransfer.files);
});
targetFileInput.addEventListener('change', () => {
  handleTargetFiles(targetFileInput.files);
  targetFileInput.value = '';
});

// ---------------------------------------------------------------------------
// Shared mask-canvas editor -- one instance per <canvas>, used for the face
// photo's own mask and for a target photo's two masks (itself + a copy of
// the reviewed face mask). Mask strength (0-255, stored in the alpha
// channel) lives in an off-screen "coverage" layer, completely separate from
// what's drawn on the visible canvas -- painting and the auto-mask import
// both write into that layer at full opacity; the visible canvas is just a
// translucent read-only *view* of it, re-rendered after every edit. Painting
// translucent dabs straight onto the visible canvas would otherwise compound
// via alpha blending along a stroke until that area looked solid opaque,
// unlike the cleanly imported auto-mask.
// ---------------------------------------------------------------------------

// Drawn overlay uses translucent red at up to this alpha for display only --
// the coverage layer itself is always full-opacity.
const MASK_OVERLAY_ALPHA_MAX = 128;

function loadImageEl(imgEl, src) {
  return new Promise((resolve, reject) => {
    imgEl.onload = resolve;
    imgEl.onerror = reject;
    imgEl.src = src;
  });
}

// ---------------------------------------------------------------------------
// Client-side auto-mask -- runs MediaPipe's selfie_multiclass segmenter
// entirely in the browser (WASM) to give each mask modal a pixel-accurate
// hair+face starting point instead of a blank canvas. Same model and
// category convention as face_swap/mediapipe_segment.py's standalone script
// (hair=1, face-skin=3), ported to the browser since this editor already
// runs client-side and Vercel's Node serverless functions have no Python/ML
// runtime to run that script in. Unlike the Python version, there's no
// RetinaFace person-selection pass here -- every uploaded photo in this flow
// is a single-person selfie or the user's own target photo, so isolating
// "which person's blob" the way the multi-person pipeline tool needs to
// isn't a real requirement here.
// ---------------------------------------------------------------------------

const MEDIAPIPE_TASKS_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20';
const MEDIAPIPE_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm';
const SELFIE_MULTICLASS_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
// 1 = hair, 3 = face-skin in this model's category set -- matches
// mediapipe_segment.py's HAIR_FACE_CATEGORIES.
const HAIR_FACE_CATEGORY_INDICES = new Set([1, 3]);

let segmenterPromise = null;
function getImageSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import(MEDIAPIPE_TASKS_VISION_URL);
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: SELFIE_MULTICLASS_MODEL_URL },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })();
  }
  return segmenterPromise;
}

// Segments an already-loaded <img>, returns a white(=regenerate)-on-black
// canvas at the segmenter's own output resolution (the Tasks API matches the
// input image's dimensions, not the model's fixed internal 256x256) with a
// soft feathered edge -- ready to feed into a mask editor via applyMaskSource,
// same convention as a fetched PNG mask.
async function computeAutoMaskCanvas(imgEl) {
  // MediaPipe's segmenter reads the image via WebGL (texImage2D), which
  // throws a SecurityError on a cross-origin image unless it was loaded in
  // CORS mode -- the display <img> elements aren't (plain .src assignment),
  // so reload the same URL through a throwaway crossOrigin='anonymous' image
  // first. The browser cache makes this a no-op network-wise.
  const corsImg = new Image();
  corsImg.crossOrigin = 'anonymous';
  await loadImageEl(corsImg, imgEl.src);

  const segmenter = await getImageSegmenter();
  const result = segmenter.segment(corsImg);
  const categoryMask = result.categoryMask;
  const { width, height } = categoryMask;
  const categories = categoryMask.getAsUint8Array();

  const raw = document.createElement('canvas');
  raw.width = width;
  raw.height = height;
  const rawCtx = raw.getContext('2d');
  const imageData = rawCtx.createImageData(width, height);
  for (let i = 0; i < categories.length; i++) {
    const v = HAIR_FACE_CATEGORY_INDICES.has(categories[i]) ? 255 : 0;
    imageData.data[i * 4] = v;
    imageData.data[i * 4 + 1] = v;
    imageData.data[i * 4 + 2] = v;
    imageData.data[i * 4 + 3] = 255;
  }
  rawCtx.putImageData(imageData, 0, 0);
  categoryMask.close();
  result.close();

  // Feather radius scales with image size, same resolution-independent-ratio
  // convention as the Python script's feather_ratio.
  const featherPx = Math.max(2, Math.round(Math.min(width, height) * 0.01));
  const feathered = document.createElement('canvas');
  feathered.width = width;
  feathered.height = height;
  const featheredCtx = feathered.getContext('2d');
  featheredCtx.filter = `blur(${featherPx}px)`;
  featheredCtx.drawImage(raw, 0, 0);
  return feathered;
}

function createMaskCanvasEditor(canvas, { getBrushSize, getTool }) {
  const ctx = canvas.getContext('2d');
  const coverage = document.createElement('canvas');
  const coverageCtx = coverage.getContext('2d');
  let isDrawing = false;

  // Shows the actual brush footprint while painting -- the CSS crosshair
  // cursor alone gives no sense of how big a dab the current brush size will
  // leave. mix-blend-mode:difference keeps the dashed ring visible against
  // the painted red overlay and the photo underneath it, light or dark.
  const wrap = canvas.parentElement;
  const cursorEl = document.createElement('div');
  cursorEl.className = 'mask-brush-cursor';
  wrap.appendChild(cursorEl);

  function updateCursor(e) {
    const wrapRect = wrap.getBoundingClientRect();
    const size = getBrushSize() * 2;
    cursorEl.style.left = `${e.clientX - wrapRect.left}px`;
    cursorEl.style.top = `${e.clientY - wrapRect.top}px`;
    cursorEl.style.width = `${size}px`;
    cursorEl.style.height = `${size}px`;
  }

  function pointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  // The brush-size slider is in on-screen pixels, not canvas pixels -- a
  // real photo's native resolution (often 3000px+) displayed in a much
  // smaller modal would otherwise make even the max brush size invisible.
  function scale() {
    return canvas.width / canvas.getBoundingClientRect().width;
  }

  function renderCoverageToDisplay() {
    const source = coverageCtx.getImageData(0, 0, coverage.width, coverage.height);
    const overlay = ctx.createImageData(coverage.width, coverage.height);
    for (let i = 0; i < source.data.length; i += 4) {
      overlay.data[i] = 255;
      overlay.data[i + 1] = 0;
      overlay.data[i + 2] = 0;
      overlay.data[i + 3] = Math.round((source.data[i + 3] / 255) * MASK_OVERLAY_ALPHA_MAX);
    }
    ctx.putImageData(overlay, 0, 0);
  }

  function paintAndRender(e) {
    coverageCtx.globalCompositeOperation = getTool() === 'erase' ? 'destination-out' : 'source-over';
    coverageCtx.fillStyle = 'rgba(255,0,0,1)';
    coverageCtx.beginPath();
    coverageCtx.arc(pointFromEvent(e).x, pointFromEvent(e).y, getBrushSize() * scale(), 0, Math.PI * 2);
    coverageCtx.fill();
    renderCoverageToDisplay();
  }

  canvas.addEventListener('pointerdown', (e) => {
    isDrawing = true;
    updateCursor(e);
    paintAndRender(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    updateCursor(e);
    if (isDrawing) paintAndRender(e);
  });
  canvas.addEventListener('pointerenter', (e) => {
    updateCursor(e);
    cursorEl.style.display = 'block';
  });
  canvas.addEventListener('pointerleave', () => {
    cursorEl.style.display = 'none';
  });
  window.addEventListener('pointerup', () => {
    isDrawing = false;
  });

  // Shared by loadMask (a fetched PNG) and loadAutoMask (a freshly computed
  // MediaPipe segmentation canvas) -- both produce a white(=regenerate)-on-
  // black source image, decoded here into the coverage layer's alpha channel
  // at full strength (0-255 data, not display alpha), then rendered as the
  // translucent red overlay.
  function applyMaskSource(source) {
    const off = document.createElement('canvas');
    off.width = coverage.width;
    off.height = coverage.height;
    const offCtx = off.getContext('2d');
    offCtx.drawImage(source, 0, 0, off.width, off.height);
    const sourceData = offCtx.getImageData(0, 0, off.width, off.height);
    const data = coverageCtx.createImageData(off.width, off.height);
    for (let i = 0; i < sourceData.data.length; i += 4) {
      data.data[i] = 255;
      data.data[i + 1] = 0;
      data.data[i + 2] = 0;
      data.data[i + 3] = sourceData.data[i];
    }
    coverageCtx.putImageData(data, 0, 0);
    renderCoverageToDisplay();
  }

  return {
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
      coverage.width = width;
      coverage.height = height;
      ctx.clearRect(0, 0, width, height);
      coverageCtx.clearRect(0, 0, width, height);
    },
    async loadMask(maskUrl) {
      const maskImg = new Image();
      maskImg.crossOrigin = 'anonymous'; // drawn into a canvas that's then read back via getImageData
      await loadImageEl(maskImg, maskUrl);
      applyMaskSource(maskImg);
    },
    // Computes a fresh MediaPipe hair+face mask from the photo already shown
    // in this editor and loads it the same way loadMask would.
    async loadAutoMask(photoImgEl) {
      const maskCanvas = await computeAutoMaskCanvas(photoImgEl);
      applyMaskSource(maskCanvas);
    },
    // Reads from the coverage layer (the real 0-255 mask data), not the
    // visible display canvas, so export is unaffected by display-only alpha.
    exportDataUrl() {
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = coverage.width;
      exportCanvas.height = coverage.height;
      const exportCtx = exportCanvas.getContext('2d');
      const data = coverageCtx.getImageData(0, 0, coverage.width, coverage.height);
      const exported = exportCtx.createImageData(coverage.width, coverage.height);
      for (let i = 0; i < data.data.length; i += 4) {
        const v = data.data[i + 3];
        exported.data[i] = v;
        exported.data[i + 1] = v;
        exported.data[i + 2] = v;
        exported.data[i + 3] = 255;
      }
      exportCtx.putImageData(exported, 0, 0);
      return exportCanvas.toDataURL('image/png');
    },
    setEnabled(enabled) {
      canvas.classList.toggle('is-disabled', !enabled);
      if (!enabled) cursorEl.style.display = 'none';
    },
  };
}

// ---------------------------------------------------------------------------
// Face mask editor -- a paint/erase canvas over the uploaded face photo,
// pre-filled with the auto-generated mask (see api/_lib/ideogram.js's
// buildFaceMask). Saving marks the mask reviewed, which is what unlocks the
// target section (see updateTargetLockState above).
// ---------------------------------------------------------------------------

const faceMaskModal = document.querySelector('[data-face-mask-modal]');
const faceMaskCloseBtn = faceMaskModal.querySelector('[data-face-mask-close]');
const faceMaskImg = faceMaskModal.querySelector('[data-face-mask-img]');
const faceMaskCanvas = faceMaskModal.querySelector('[data-face-mask-canvas]');
const faceMaskToolBtns = faceMaskModal.querySelectorAll('[data-face-mask-tool]');
const faceMaskBrushSize = faceMaskModal.querySelector('[data-face-mask-brush-size]');
const faceMaskErrorEl = faceMaskModal.querySelector('[data-face-mask-error]');
const faceMaskSaveBtn = faceMaskModal.querySelector('[data-face-mask-save]');

let faceMaskTool = 'paint';
let faceMaskLastFocused = null;

faceMaskToolBtns.forEach((btn) => btn.addEventListener('click', () => {
  faceMaskTool = btn.dataset.faceMaskTool;
  faceMaskToolBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
}));

const faceMaskEditor = createMaskCanvasEditor(faceMaskCanvas, {
  getBrushSize: () => Number(faceMaskBrushSize.value),
  getTool: () => faceMaskTool,
});

// Loads whichever mask already exists at maskUrl (the user's own prior save,
// if any -- mask_storage_path is a stable, reused destination, so a non-null
// URL here means real prior content most of the time). If there's none yet,
// or the fetch fails (a freshly created swap_jobs row's mask_storage_path
// has nothing uploaded to it until the user's first save/approve), computes
// a fresh MediaPipe auto-mask from the photo as the starting point instead.
async function loadStoredOrAutoMask(editor, maskUrl, photoImgEl) {
  if (maskUrl) {
    try {
      await editor.loadMask(maskUrl);
      return;
    } catch (err) {
      console.warn('stored mask failed to load, computing auto-mask instead', err);
    }
  }
  await editor.loadAutoMask(photoImgEl);
}

async function openFaceMaskModal() {
  if (!facePhotoUrl) return;
  faceMaskErrorEl.hidden = true;
  faceMaskLastFocused = document.activeElement;
  faceMaskModal.hidden = false;
  faceMaskCloseBtn.focus();
  if (typeof posthog !== 'undefined') posthog.capture('face_mask_modal_opened');

  try {
    await loadImageEl(faceMaskImg, facePhotoUrl);
    faceMaskEditor.resize(faceMaskImg.naturalWidth, faceMaskImg.naturalHeight);
    await loadStoredOrAutoMask(faceMaskEditor, faceMaskUrl, faceMaskImg);
  } catch (err) {
    console.error('load face mask failed', err);
    faceMaskErrorEl.textContent = "Couldn't load your photo. Please try again.";
    faceMaskErrorEl.hidden = false;
  }
}

function closeFaceMaskModal() {
  faceMaskModal.hidden = true;
  if (faceMaskLastFocused) faceMaskLastFocused.focus();
}

faceMaskCloseBtn.addEventListener('click', closeFaceMaskModal);
faceMaskModal.addEventListener('click', (e) => {
  if (e.target === faceMaskModal) closeFaceMaskModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !faceMaskModal.hidden) closeFaceMaskModal();
});

faceMaskOpenBtn.addEventListener('click', () => openFaceMaskModal());

faceMaskSaveBtn.addEventListener('click', async () => {
  faceMaskErrorEl.hidden = true;
  faceMaskSaveBtn.disabled = true;
  faceMaskSaveBtn.textContent = 'Saving…';

  try {
    const response = await fetch('/api/results-init', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(apiBody(null, { action: 'save-face-mask', maskDataUrl: faceMaskEditor.exportDataUrl() })),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || 'save-face-mask failed');

    faceMaskReviewed = true;
    updateFaceMaskLinkState();
    updateTargetLockState();
    if (typeof posthog !== 'undefined') posthog.capture('face_mask_saved');
    closeFaceMaskModal();
  } catch (err) {
    console.error('save-face-mask failed', err);
    faceMaskErrorEl.textContent = "Couldn't save your mask — try again.";
    faceMaskErrorEl.hidden = false;
  }

  faceMaskSaveBtn.disabled = false;
  faceMaskSaveBtn.innerHTML = 'Save &amp; continue <span>→</span>';
});

// ---------------------------------------------------------------------------
// Target mask editor -- the end user reviews (and can edit) a target photo's
// own auto-generated mask plus a copy of their already-reviewed face mask,
// then approves the real swap themselves (see api/results-init.js's
// approve-swap action) -- this used to be a manual admin step.
// ---------------------------------------------------------------------------

const targetMaskModal = document.querySelector('[data-target-mask-modal]');
const targetMaskCloseBtn = targetMaskModal.querySelector('[data-target-mask-close]');
const targetMaskImg = targetMaskModal.querySelector('[data-target-mask-img]');
const targetMaskCanvas = targetMaskModal.querySelector('[data-target-mask-canvas]');
const targetMaskReferenceImg = targetMaskModal.querySelector('[data-target-mask-reference-img]');
const targetMaskReferenceCanvas = targetMaskModal.querySelector('[data-target-mask-reference-canvas]');
const targetMaskToolBtns = targetMaskModal.querySelectorAll('[data-target-mask-tool]');
const targetMaskBrushSize = targetMaskModal.querySelector('[data-target-mask-brush-size]');
const targetMaskErrorEl = targetMaskModal.querySelector('[data-target-mask-error]');
const targetMaskApproveBtn = targetMaskModal.querySelector('[data-target-mask-approve]');
const targetMaskProcessingEl = targetMaskModal.querySelector('[data-target-mask-processing]');

let targetMaskTool = 'paint';
let targetMaskLastFocused = null;
let targetMaskCurrentJob = null;

targetMaskToolBtns.forEach((btn) => btn.addEventListener('click', () => {
  targetMaskTool = btn.dataset.targetMaskTool;
  targetMaskToolBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
}));

const targetMaskEditor = createMaskCanvasEditor(targetMaskCanvas, {
  getBrushSize: () => Number(targetMaskBrushSize.value),
  getTool: () => targetMaskTool,
});
const targetMaskReferenceEditor = createMaskCanvasEditor(targetMaskReferenceCanvas, {
  getBrushSize: () => Number(targetMaskBrushSize.value),
  getTool: () => targetMaskTool,
});

// While a swap is actually running (the approve-swap call blocks on a real
// Ideogram request for up to ~2 minutes), the masks underneath it shouldn't
// be editable -- there's nothing left to paint against once the request is
// already in flight with whatever mask was exported.
function setTargetMaskEditingEnabled(enabled) {
  targetMaskEditor.setEnabled(enabled);
  targetMaskReferenceEditor.setEnabled(enabled);
  targetMaskToolBtns.forEach((btn) => { btn.disabled = !enabled; });
  targetMaskBrushSize.disabled = !enabled;
}

async function openTargetMaskModal(job) {
  targetMaskCurrentJob = job;
  targetMaskErrorEl.hidden = true;
  targetMaskLastFocused = document.activeElement;
  targetMaskModal.hidden = false;
  targetMaskCloseBtn.focus();
  if (typeof posthog !== 'undefined') posthog.capture('target_mask_modal_opened');

  try {
    await Promise.all([loadImageEl(targetMaskImg, job.targetUrl), loadImageEl(targetMaskReferenceImg, job.referenceUrl)]);
    targetMaskEditor.resize(targetMaskImg.naturalWidth, targetMaskImg.naturalHeight);
    targetMaskReferenceEditor.resize(targetMaskReferenceImg.naturalWidth, targetMaskReferenceImg.naturalHeight);
    await loadStoredOrAutoMask(targetMaskEditor, job.maskUrl, targetMaskImg);
    // The reference mask is a copy of the already-reviewed face mask (see
    // api/_lib/swapJob.js), not independently auto-masked -- if it's
    // missing, leave that canvas blank/unedited rather than erroring the
    // whole modal.
    if (job.referenceMaskUrl) await targetMaskReferenceEditor.loadMask(job.referenceMaskUrl);
  } catch (err) {
    console.error('load target mask failed', err);
    targetMaskErrorEl.textContent = "Couldn't load this photo. Please try again.";
    targetMaskErrorEl.hidden = false;
  }
}

function closeTargetMaskModal() {
  targetMaskModal.hidden = true;
  targetMaskCurrentJob = null;
  if (targetMaskLastFocused) targetMaskLastFocused.focus();
}

targetMaskCloseBtn.addEventListener('click', closeTargetMaskModal);
targetMaskModal.addEventListener('click', (e) => {
  if (e.target === targetMaskModal) closeTargetMaskModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !targetMaskModal.hidden) closeTargetMaskModal();
});

targetMaskApproveBtn.addEventListener('click', async () => {
  const job = targetMaskCurrentJob;
  if (!job) return;
  targetMaskApproveBtn.disabled = true;
  targetMaskApproveBtn.textContent = 'Running swap…';
  targetMaskErrorEl.hidden = true;
  setTargetMaskEditingEnabled(false);
  targetMaskProcessingEl.hidden = false;

  try {
    const payload = { action: 'approve-swap', jobId: job.jobId, maskDataUrl: targetMaskEditor.exportDataUrl() };
    // Only sent when this job actually has a reference mask to edit -- a job
    // whose auto-mask generation failed has nothing to export.
    if (job.referenceMaskUrl) payload.referenceMaskDataUrl = targetMaskReferenceEditor.exportDataUrl();
    const res = await fetch('/api/results-init', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(apiBody(null, payload)),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || 'approve-swap failed');

    if (body.status === 'failed') {
      targetMaskErrorEl.textContent = 'Swap failed: ' + body.error;
      targetMaskErrorEl.hidden = false;
      targetMaskProcessingEl.hidden = true;
      setTargetMaskEditingEnabled(true);
    } else {
      if (typeof posthog !== 'undefined') posthog.capture('target_mask_approved');
      closeTargetMaskModal();
      await fetchAndRenderResults();
      pollForUpdates();
    }
  } catch (err) {
    console.error('approve-swap failed', err);
    targetMaskErrorEl.textContent = 'Could not run the swap. Please try again.';
    targetMaskErrorEl.hidden = false;
    targetMaskProcessingEl.hidden = true;
    setTargetMaskEditingEnabled(true);
  }

  targetMaskApproveBtn.disabled = false;
  targetMaskApproveBtn.textContent = 'Approve & run swap →';
});

// ---------------------------------------------------------------------------
// Results section -- status + lightbox. No paywall for now: downloads are
// unlocked for everyone.
// ---------------------------------------------------------------------------

const gridEl = resultsSection.querySelector('[data-results-grid]');
const resultsEmptyEl = resultsSection.querySelector('[data-results-empty]');

const lightbox = document.querySelector('[data-lightbox]');
const lightboxImg = lightbox.querySelector('[data-lightbox-img]');
const lightboxDownload = lightbox.querySelector('[data-lightbox-download]');
const lightboxCloseBtn = lightbox.querySelector('[data-lightbox-close]');
let lightboxLastFocused = null;

function openLightbox(url, downloadUrl) {
  lightboxLastFocused = document.activeElement;
  lightboxImg.src = url;
  lightboxDownload.href = downloadUrl;
  lightbox.hidden = false;
  lightboxCloseBtn.focus();
  if (typeof posthog !== 'undefined') posthog.capture('result_photo_expanded');
}

function closeLightbox() {
  lightbox.hidden = true;
  lightboxImg.src = '';
  if (lightboxLastFocused) lightboxLastFocused.focus();
}

lightboxCloseBtn.addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
});

async function submitFeedback(targetPhotoId, liked) {
  try {
    const response = await fetch('/api/results-init', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(apiBody(null, { action: 'feedback', targetPhotoId, liked })),
    });
    if (!response.ok) throw new Error('Feedback request failed');
    if (typeof posthog !== 'undefined') posthog.capture('result_feedback', { liked });
    return true;
  } catch (err) {
    console.error('submitFeedback failed', err);
    return false;
  }
}

async function submitEditRequest(targetPhotoId, comment) {
  try {
    const response = await fetch('/api/results-init', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(apiBody(null, { action: 'feedback', targetPhotoId, comment })),
    });
    if (!response.ok) throw new Error('Edit request failed');
    if (typeof posthog !== 'undefined') posthog.capture('result_edit_requested');
    return true;
  } catch (err) {
    console.error('submitEditRequest failed', err);
    return false;
  }
}

async function requestRegenerate(targetPhotoId) {
  const response = await fetch('/api/results-init', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(apiBody(null, { action: 'regenerate', targetPhotoId })),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not regenerate');
  if (typeof posthog !== 'undefined') posthog.capture('result_regenerate_requested');
}

function renderJobs(jobs, regenerateCap) {
  gridEl.innerHTML = '';
  if (!jobs.length) {
    gridEl.hidden = true;
    resultsEmptyEl.hidden = false;
    return;
  }
  gridEl.hidden = false;
  resultsEmptyEl.hidden = true;

  const STATUS_LABELS = { done: 'Ready', failed: 'Failed', queued: 'Queued', processing: 'Processing', needs_review: 'In review', mask_review: 'Review & swap' };

  jobs.forEach((job) => {
    const statusClass = ['done', 'failed', 'queued', 'needs_review', 'mask_review'].includes(job.status) ? job.status.replace('_', '-') : 'pending';

    const li = document.createElement('li');
    li.className = `result-card is-${statusClass}`;

    if (job.status === 'done' && job.url) {
      const photoBtn = document.createElement('button');
      photoBtn.type = 'button';
      photoBtn.className = 'result-card-photo';
      photoBtn.setAttribute('aria-label', 'View full-size photo');
      const img = document.createElement('img');
      img.src = job.url;
      img.alt = '';
      photoBtn.appendChild(img);
      photoBtn.addEventListener('click', () => openLightbox(job.url, job.downloadUrl));
      li.appendChild(photoBtn);
    }

    if (job.status === 'mask_review' && job.targetUrl) {
      const photoBtn = document.createElement('button');
      photoBtn.type = 'button';
      photoBtn.className = 'result-card-photo';
      photoBtn.setAttribute('aria-label', 'Review and swap this photo');
      const img = document.createElement('img');
      img.src = job.targetUrl;
      img.alt = '';
      photoBtn.appendChild(img);
      photoBtn.addEventListener('click', () => openTargetMaskModal(job));
      li.appendChild(photoBtn);
    }

    const status = document.createElement('div');
    status.className = 'result-card-status';

    const row = document.createElement('div');
    row.className = 'result-card-status-row';

    const label = document.createElement('span');
    label.className = 'result-card-status-label';
    const dot = document.createElement('span');
    dot.className = 'result-card-status-dot';
    const labelText = document.createElement('span');
    labelText.textContent = STATUS_LABELS[job.status] || STATUS_LABELS.processing;
    label.append(dot, labelText);
    row.appendChild(label);

    if (job.status === 'done' && job.url) {
      const link = document.createElement('a');
      link.href = job.downloadUrl;
      link.download = '';
      link.innerHTML = '<span aria-hidden="true">↓</span>Download';
      row.appendChild(link);
    }
    status.appendChild(row);

    if (job.status === 'done' && job.url) {
      const feedback = document.createElement('div');
      feedback.className = 'result-feedback';

      const likeBtn = document.createElement('button');
      likeBtn.type = 'button';
      likeBtn.className = 'feedback-btn';
      likeBtn.setAttribute('aria-label', 'I like this swap');
      likeBtn.textContent = '👍';
      if (job.liked === true) likeBtn.classList.add('is-active');

      const dislikeBtn = document.createElement('button');
      dislikeBtn.type = 'button';
      dislikeBtn.className = 'feedback-btn';
      dislikeBtn.setAttribute('aria-label', "I don't like this swap");
      dislikeBtn.textContent = '👎';
      if (job.liked === false) dislikeBtn.classList.add('is-active');

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'feedback-btn';
      editBtn.setAttribute('aria-label', 'Request an edit to this swap');
      editBtn.textContent = '✏️';
      if (job.comment) editBtn.classList.add('is-active');

      const editForm = document.createElement('form');
      editForm.className = 'result-edit-form';
      editForm.hidden = true;

      const editTextarea = document.createElement('textarea');
      editTextarea.placeholder = 'What should we change about this one?';
      editTextarea.maxLength = 1000;
      editTextarea.value = job.comment || '';

      const editSubmitBtn = document.createElement('button');
      editSubmitBtn.type = 'submit';
      editSubmitBtn.className = 'button-link';
      editSubmitBtn.textContent = job.comment ? 'Update request' : 'Send request';

      editForm.append(editTextarea, editSubmitBtn);

      editBtn.addEventListener('click', () => {
        editForm.hidden = !editForm.hidden;
        if (!editForm.hidden) editTextarea.focus();
      });

      editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const comment = editTextarea.value.trim();
        if (!comment) return;
        editSubmitBtn.disabled = true;
        editSubmitBtn.textContent = 'Sending…';
        const ok = await submitEditRequest(job.targetPhotoId, comment);
        editSubmitBtn.disabled = false;
        editSubmitBtn.textContent = ok ? 'Update request' : 'Send request';
        if (ok) {
          editBtn.classList.add('is-active');
          editForm.hidden = true;
        }
      });

      const regenBtn = document.createElement('button');
      regenBtn.type = 'button';
      regenBtn.className = 'button-link';
      regenBtn.textContent = 'Regenerate';
      regenBtn.hidden = job.liked !== false;
      if (job.regenerateCount >= regenerateCap) {
        regenBtn.disabled = true;
        regenBtn.textContent = "Regenerate limit reached — email us";
      }

      const setLiked = (liked) => {
        likeBtn.classList.toggle('is-active', liked === true);
        dislikeBtn.classList.toggle('is-active', liked === false);
        if (job.regenerateCount < regenerateCap) regenBtn.hidden = liked !== false;
      };

      likeBtn.addEventListener('click', async () => {
        likeBtn.disabled = true;
        dislikeBtn.disabled = true;
        if (await submitFeedback(job.targetPhotoId, true)) setLiked(true);
        likeBtn.disabled = false;
        dislikeBtn.disabled = false;
      });

      dislikeBtn.addEventListener('click', async () => {
        likeBtn.disabled = true;
        dislikeBtn.disabled = true;
        if (await submitFeedback(job.targetPhotoId, false)) setLiked(false);
        likeBtn.disabled = false;
        dislikeBtn.disabled = false;
      });

      regenBtn.addEventListener('click', async () => {
        regenBtn.disabled = true;
        regenBtn.textContent = 'Regenerating…';
        try {
          await requestRegenerate(job.targetPhotoId);
          await fetchAndRenderResults();
          pollForUpdates();
        } catch (err) {
          console.error('requestRegenerate failed', err);
          regenBtn.disabled = false;
          regenBtn.textContent = 'Regenerate';
        }
      });

      feedback.append(likeBtn, dislikeBtn, editBtn, regenBtn);
      status.append(feedback, editForm);
    }

    if (job.status === 'queued' || job.status === 'needs_review') {
      const sub = document.createElement('p');
      sub.className = 'result-card-status-sub';
      sub.textContent =
        job.status === 'queued' ? 'Waiting in the queue' : "Our team is reviewing this one — we'll get back to you within 24 hours.";
      status.appendChild(sub);
    }

    if (job.status === 'mask_review') {
      const reviewBtn = document.createElement('button');
      reviewBtn.type = 'button';
      reviewBtn.className = 'button-link';
      reviewBtn.textContent = 'Review & swap →';
      reviewBtn.addEventListener('click', () => openTargetMaskModal(job));
      status.appendChild(reviewBtn);
    }

    li.appendChild(status);
    gridEl.appendChild(li);
  });
}

// True while there's still work the pipeline could finish -- any job still
// processing/queued (includes freshly-regenerated jobs, which start back at
// "queued" the moment their old swap_jobs row is deleted).
function hasInFlightWork(data) {
  return (data.jobs || []).some((job) => job.status === 'processing' || job.status === 'queued');
}

// Single source of truth for fetching + rendering the results section --
// used on init, after a notify-done ping, and by both poll loops below.
async function fetchAndRenderResults() {
  const response = await fetch('/api/results-init', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(apiBody(null, {})),
  });
  if (!response.ok) return null;
  const data = await response.json();
  renderJobs(data.jobs || [], data.regenerateCap);
  return data;
}

let pollingForUpdates = false;

// The page otherwise only ever fetches results once, on load -- without this,
// a swap that finishes (or a regenerate that completes) after the page is
// open would never show up until the user manually refreshes.
async function pollForUpdates(attempt = 0) {
  if (pollingForUpdates) return; // avoid overlapping loops if called twice (e.g. right after a regenerate)
  pollingForUpdates = true;
  try {
    while (attempt < 90) {
      // ~8s * 90 =12min -- generous enough to cover the judge's worst-case
      // 10-attempt retry loop (observed up to ~2.5 min), then give up
      // quietly and let the user refresh manually.
      await new Promise((resolve) => setTimeout(resolve, 8000));
      const data = await fetchAndRenderResults();
      if (!data) return;
      if (!hasInFlightWork(data)) return;
      attempt += 1;
    }
  } catch (err) {
    console.error('pollForUpdates failed', err);
  } finally {
    pollingForUpdates = false;
  }
}

// ---------------------------------------------------------------------------
// Sign-in / sign-up (shared across every state)
// ---------------------------------------------------------------------------

const signinState = document.querySelector('[data-state="signin"]');
const signinPhoneForm = signinState.querySelector('[data-signin-phone-form]');
const signinOtpForm = signinState.querySelector('[data-signin-otp-form]');
const signinPhoneError = signinPhoneForm.querySelector('.upload-error');
const signinOtpError = signinOtpForm.querySelector('.upload-error');
const signinOtpPhoneEl = signinOtpForm.querySelector('[data-signin-otp-phone]');
const signinOtpBackBtn = signinOtpForm.querySelector('[data-signin-otp-back]');
const signinPhoneSubmitBtn = signinPhoneForm.querySelector('button[type="submit"]');
const signinOtpSubmitBtn = signinOtpForm.querySelector('button[type="submit"]');
const signinNameField = signinPhoneForm.querySelector('[data-signin-name-field]');
const signinNameInput = signinNameField.querySelector('input');
const signinEmailField = signinPhoneForm.querySelector('[data-signin-email-field]');
const signinEmailInput = signinEmailField.querySelector('input');
const signinTitleEl = signinState.querySelector('[data-signin-title]');
const signinSubEl = signinState.querySelector('[data-signin-sub]');

let signinIsSignup = false;
let signinPendingName = '';
let signinPendingEmail = '';
let signinPendingPhone = '';
let signinHasStartedTyping = false;

signinOtpBackBtn.addEventListener('click', () => {
  signinOtpForm.hidden = true;
  signinPhoneForm.hidden = false;
  signinOtpError.hidden = true;
});

signinPhoneForm.addEventListener('focusin', () => {
  if (signinHasStartedTyping) return;
  signinHasStartedTyping = true;
  if (typeof posthog !== 'undefined') {
    posthog.capture('form_started', { mode: signinIsSignup ? 'signup' : 'signin' });
  }
});

signinPhoneForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  signinPhoneError.hidden = true;

  const data = Object.fromEntries(new FormData(signinPhoneForm).entries());
  const name = (data.name || '').trim();
  const email = (data.email || '').trim();
  const rawPhone = (data.phone || '').trim();

  if (signinIsSignup && !name) {
    signinPhoneError.textContent = 'Enter your full name.';
    signinPhoneError.hidden = false;
    return;
  }
  if (signinIsSignup && !email) {
    signinPhoneError.textContent = 'Enter your email address.';
    signinPhoneError.hidden = false;
    return;
  }
  if (!rawPhone) {
    signinPhoneError.textContent = 'Enter your phone number.';
    signinPhoneError.hidden = false;
    return;
  }

  const phone = normalizePhone(rawPhone);

  signinPhoneSubmitBtn.disabled = true;
  signinPhoneSubmitBtn.textContent = 'Sending…';
  if (typeof posthog !== 'undefined') {
    posthog.capture('otp_requested', { mode: signinIsSignup ? 'signup' : 'signin' });
  }

  const { error } = await supabase.auth.signInWithOtp({
    phone,
    options: { shouldCreateUser: signinIsSignup },
  });

  signinPhoneSubmitBtn.disabled = false;
  signinPhoneSubmitBtn.innerHTML = 'Send code <span>→</span>';

  if (error) {
    if (!signinIsSignup) {
      signinIsSignup = true;
      signinTitleEl.textContent = 'Create your account';
      signinSubEl.textContent = "We'll take you straight to your private page.";
      signinNameField.hidden = false;
      signinNameInput.required = true;
      signinEmailField.hidden = false;
      signinEmailInput.required = true;
      signinPhoneError.textContent = "We couldn't find an account for that number — enter your name to create one.";
      signinPhoneError.hidden = false;
      signinNameInput.focus();
      if (typeof posthog !== 'undefined') posthog.capture('signin_fallback_to_signup');
      return;
    }
    signinPhoneError.textContent = error.message || 'Could not send a code. Check the number and try again.';
    signinPhoneError.hidden = false;
    if (typeof posthog !== 'undefined') posthog.capture('otp_request_failed', { reason: error.message });
    return;
  }

  signinPendingName = name;
  signinPendingEmail = email;
  signinPendingPhone = phone;

  if (signinIsSignup) {
    try {
      await fetch('/api/notify-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone }),
      });
    } catch (err) {
      console.error('signup notify failed', err);
    }
  }

  signinOtpPhoneEl.textContent = phone;
  signinPhoneForm.hidden = true;
  signinOtpForm.hidden = false;
  signinOtpForm.querySelector('input[name="code"]').focus();
});

signinOtpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  signinOtpError.hidden = true;

  const code = (new FormData(signinOtpForm).get('code') || '').trim();
  if (!code) {
    signinOtpError.textContent = 'Enter the code we sent you.';
    signinOtpError.hidden = false;
    return;
  }

  signinOtpSubmitBtn.disabled = true;
  signinOtpSubmitBtn.textContent = 'Verifying…';
  if (typeof posthog !== 'undefined') posthog.capture('otp_verify_attempted');

  const {
    data: { session, user },
    error,
  } = await supabase.auth.verifyOtp({ phone: signinPendingPhone, token: code, type: 'sms' });

  if (error || !session) {
    signinOtpSubmitBtn.disabled = false;
    signinOtpSubmitBtn.innerHTML = 'Verify <span>→</span>';
    signinOtpError.textContent = error ? error.message : 'That code didn’t work. Try again.';
    signinOtpError.hidden = false;
    if (typeof posthog !== 'undefined') posthog.capture('otp_verify_failed', { reason: error && error.message });
    return;
  }

  if (signinIsSignup) {
    const { data: existingProfile } = await supabase.from('profiles').select('id').eq('id', user.id).maybeSingle();
    if (!existingProfile) {
      const profilePayload = { id: user.id, name: signinPendingName, email: signinPendingEmail, phone: signinPendingPhone, referred_by_code: getReferralCode() };
      let profileError = null;
      // Retry once -- a transient network blip here would otherwise silently
      // leave the signed-in user with no profile row, so every later lookup
      // (this page's own reload included) 500s and bounces them back to sign-in.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          ({ error: profileError } = await supabase.from('profiles').insert(profilePayload));
        } catch (err) {
          profileError = err;
        }
        if (!profileError) break;
      }
      if (profileError) {
        console.error('profile insert failed', profileError);
        signinOtpSubmitBtn.disabled = false;
        signinOtpSubmitBtn.innerHTML = 'Verify <span>→</span>';
        signinOtpError.textContent = "Your code was correct, but we couldn't finish setting up your account — please try again.";
        signinOtpError.hidden = false;
        return;
      }
      if (typeof fbq === 'function') fbq('track', 'Lead');
    }
  }

  // Never let a PostHog hiccup (e.g. bot-detection dropping the event) block
  // the reload -- signing in must not depend on analytics succeeding.
  try {
    if (typeof posthog !== 'undefined') {
      posthog.identify(user.id, { phone: signinPendingPhone, ...(signinPendingName ? { name: signinPendingName } : {}), ...(signinPendingEmail ? { email: signinPendingEmail } : {}) });
      posthog.capture('otp_verify_succeeded', { mode: signinIsSignup ? 'signup' : 'signin' });
    }
  } catch (err) {
    console.error('posthog capture failed', err);
  }

  location.reload();
});

function showSigninState() {
  showState('signin');
  if (typeof posthog !== 'undefined') posthog.capture('signin_shown');
}

const loadingErrorEl = document.querySelector('[data-state="loading"] [data-loading-error]');
const retryLinkEl = document.querySelector('[data-state="loading"] [data-retry-link]');
retryLinkEl.addEventListener('click', (e) => {
  e.preventDefault();
  location.reload();
});

// ---------------------------------------------------------------------------
// Init -- loads face, target, and results state in parallel and renders all
// three sections at once (no gating between them).
// ---------------------------------------------------------------------------

async function init() {
  try {
    if (urlViewAs) {
      authMode = { type: 'viewAs', viewAs: urlViewAs };
    } else if (urlToken) {
      authMode = { type: 'token', token: urlToken };
    } else {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        showSigninState();
        return;
      }
      authMode = { type: 'session', accessToken: session.access_token };
    }

    const [faceInitRes, targetInitRes, resultsInitRes] = await Promise.all([
      fetch('/api/upload-init', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(apiBody('face', {})) }),
      fetch('/api/upload-init', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(apiBody('target', {})) }),
      fetch('/api/results-init', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(apiBody(null, {})) }),
    ]);

    if (!faceInitRes.ok || !targetInitRes.ok || !resultsInitRes.ok) {
      if (urlViewAs || urlToken) {
        showState('invalid');
      } else {
        showSigninState();
      }
      return;
    }

    const faceData = await faceInitRes.json();
    const targetData = await targetInitRes.json();
    const resultsData = await resultsInitRes.json();

    readyState.querySelector('[data-name]').textContent = faceData.name;

    // Face section.
    faceRemaining = faceData.remaining;
    faceUploaded = faceData.uploaded;
    faceMin = faceData.min;
    faceNotified = faceUploaded >= faceMin;
    (faceData.photos || []).forEach((photo, i) => {
      const row = faceHelpers.addFileRow(`Photo ${i + 1}`, photo.url);
      faceHelpers.markRowDone(row);
      row.removeBtn.disabled = false;
      row.removeBtn.addEventListener('click', () => removeRow(row, photo.path, 'face', faceErrorEl, onFaceRemoved));
      faceRowsByPath.set(photo.path, true);
      facePhotoUrl = photo.url;
      faceMaskUrl = photo.maskUrl;
      faceMaskReviewed = photo.maskReviewed;
    });
    updateFaceSub();
    updateFaceDropzoneState();
    updateFaceMaskLinkState();
    updateTargetLockState();

    // Target section.
    targetRemaining = targetData.remaining;
    targetUploaded = targetData.uploaded;
    targetMax = targetData.max;
    targetNotified = targetUploaded > 0;
    const ownTargetPhotos = (targetData.photos || []).filter((photo) => !photo.library);
    selectedLibraryPaths = new Set((targetData.photos || []).filter((photo) => photo.library).map((photo) => photo.path));
    ownTargetPhotos.forEach((photo, i) => {
      const row = targetHelpers.addFileRow(`Photo ${i + 1}`, photo.url);
      targetHelpers.markRowDone(row);
      row.removeBtn.disabled = false;
      row.removeBtn.addEventListener('click', () => removeRow(row, photo.path, 'target', targetErrorEl, onTargetRemoved));
    });
    updateTargetSub();

    // Results section.
    renderJobs(resultsData.jobs || [], resultsData.regenerateCap);

    showState('ready');

    try {
      const libraryResponse = await fetch('/api/library');
      if (libraryResponse.ok) {
        const libraryData = await libraryResponse.json();
        libraryPhotos = libraryData.photos || [];
        renderNextLibraryBatch();
      }
    } catch (err) {
      console.error('library fetch failed', err);
    }

    if (hasInFlightWork(resultsData)) pollForUpdates();
  } catch (err) {
    // Network hiccup, cold-start timeout, etc. -- without this, the page
    // would otherwise be stuck showing "Checking your link..." forever
    // since nothing else would ever call showState().
    console.error('init failed', err);
    loadingErrorEl.hidden = false;
  }
}

init();
