import { createClient } from '@supabase/supabase-js';
import { createMaskCanvasEditor, detectFaces, selectFace, type MaskTool } from 'shared';
import { normalizePhone } from './phone.js';
import { captureReferralCode, getReferralCode } from './referral.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabaseConfig.js';

captureReferralCode();

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const urlParams = new URLSearchParams(location.search);
const urlToken = urlParams.get('token');
const urlViewAs = urlParams.get('viewAs');

type AuthMode = { type: 'token'; token: string } | { type: 'viewAs'; viewAs: string } | { type: 'session'; accessToken: string };

// A legacy shareable link (?token=), an admin "view as" link (?viewAs=), or a real signed-in session.
let authMode: AuthMode | null = null;

function apiBody(kind: string | null, extra: Record<string, unknown>): Record<string, unknown> {
  const mode = authMode!;
  let base: Record<string, unknown> = {};
  if (mode.type === 'token') base = { token: mode.token };
  else if (mode.type === 'viewAs') base = { viewAs: mode.viewAs };
  return { ...base, ...(kind ? { kind } : {}), ...extra };
}

function apiHeaders(): Record<string, string> {
  const mode = authMode!;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (mode.type === 'session') headers.Authorization = `Bearer ${mode.accessToken}`;
  return headers;
}

const states = document.querySelectorAll<HTMLElement>('.upload-state');
const showState = (name: string) => {
  states.forEach((el) => {
    el.hidden = el.dataset.state !== name;
  });
};

const readyState = document.querySelector<HTMLElement>('[data-state="ready"]')!;
const faceSection = readyState.querySelector<HTMLElement>('[data-section="face"]')!;
const targetSection = readyState.querySelector<HTMLElement>('[data-section="target"]')!;
const resultsSection = readyState.querySelector<HTMLElement>('[data-section="results"]')!;

function showError(errorEl: HTMLElement, message: string) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

// ---------------------------------------------------------------------------
// Shared file-row rendering + upload/remove, used by both the face and the
// target dropzones (they differ only in `kind` and which section they live in).
// ---------------------------------------------------------------------------

interface FileRow {
  li: HTMLLIElement;
  status: HTMLElement;
  removeBtn: HTMLButtonElement;
  objectUrl: string;
}

function createFileList(fileListEl: HTMLElement) {
  function addFileRow(name: string, thumbUrl: string): FileRow {
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

  function markRowDone(row: FileRow) {
    row.li.classList.add('is-done');
    row.status.textContent = 'Uploaded';
  }

  function markRowError(row: FileRow, message?: string) {
    row.li.classList.add('is-error');
    row.status.textContent = message || 'Failed';
  }

  return { addFileRow, markRowDone, markRowError };
}

type FileListHelpers = ReturnType<typeof createFileList>;

async function removeRow(row: FileRow, confirmedPath: string | null, kind: string, errorEl: HTMLElement, onRemoved?: (path: string) => void): Promise<boolean> {
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
      return false;
    }
    if (onRemoved) onRemoved(confirmedPath);
  }

  URL.revokeObjectURL(row.objectUrl);
  row.li.remove();
  return true;
}

interface UploadCallbacks {
  onDone?: (path: string, confirmBody: Record<string, unknown>, objectUrl: string, row: FileRow) => void;
  onRemoved?: (path: string) => void;
}

async function uploadFile(file: File, kind: string, helpers: FileListHelpers, errorEl: HTMLElement, onConfirmed?: UploadCallbacks): Promise<boolean> {
  const objectUrl = URL.createObjectURL(file);
  const row = helpers.addFileRow(file.name, objectUrl);
  let confirmedPath: string | null = null;

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

  const { error: uploadError } = await supabase.storage.from(signBody.bucket).uploadToSignedUrl(signBody.path, signBody.signToken, file);

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
  if (onConfirmed?.onDone) onConfirmed.onDone(confirmedPath!, confirmBody, objectUrl, row);
  return true;
}

// ---------------------------------------------------------------------------
// Face section -- the single required reference photo. Finishes itself
// automatically (no "I'm done" step) as soon as it's uploaded.
// ---------------------------------------------------------------------------

const faceDropzone = faceSection.querySelector<HTMLElement>('[data-dropzone]')!;
const faceFileInput = faceSection.querySelector<HTMLInputElement>('#face-file-input')!;
const faceErrorEl = faceSection.querySelector<HTMLElement>('.upload-error')!;
const faceFileList = faceSection.querySelector<HTMLElement>('.file-list')!;
const faceSubEl = faceSection.querySelector<HTMLElement>('[data-sub]')!;
const faceHelpers = createFileList(faceFileList);
const faceRowsByPath = new Map<string, boolean>();
const faceMaskOpenBtn = faceSection.querySelector<HTMLButtonElement>('[data-face-mask-open]')!;
const faceMaskOpenLabelEl = faceMaskOpenBtn.querySelector<HTMLElement>('[data-face-mask-open-label]')!;
const facePhotoCardEl = faceSection.querySelector<HTMLElement>('[data-face-photo-card]')!;
const facePhotoCardImg = facePhotoCardEl.querySelector<HTMLImageElement>('[data-face-photo-img]')!;
const facePhotoCardMaskCanvas = facePhotoCardEl.querySelector<HTMLCanvasElement>('[data-face-photo-mask-canvas]')!;
const facePhotoReplaceBtn = facePhotoCardEl.querySelector<HTMLButtonElement>('[data-face-photo-replace]')!;

let faceRemaining = 0;
let faceUploaded = 0;
let faceMin = 0;
let faceNotified = false;
let faceNotifying = false;
let facePhotoUrl: string | null = null;
let facePhotoPath: string | null = null;
let currentFaceRow: FileRow | null = null;
let faceMaskUrl: string | null = null;
let faceMaskReviewed = false;

function updateFaceMaskLinkState() {
  faceMaskOpenBtn.hidden = !facePhotoUrl;
  faceMaskOpenLabelEl.textContent = faceMaskReviewed ? 'Edit mask' : 'Review mask';
}

function updateFaceSub() {
  faceSubEl.textContent = faceRemaining <= 0 ? "You've sent your photo — thank you!" : 'Send one clear, well-lit photo of your face, facing the camera.';
}

function updateFaceDropzoneState() {
  faceDropzone.classList.toggle('is-disabled', faceRemaining <= 0);
}

// Paints the saved face mask as a translucent red overlay on top of the
// photo preview, same red/alpha convention as the live mask editor's own
// display canvas -- a quick visual gut-check of what's currently saved
// without opening the edit modal.
const FACE_PHOTO_PREVIEW_MASK_ALPHA_MAX = 128;

async function renderFacePhotoMaskOverlay(canvas: HTMLCanvasElement, maskUrl: string | null) {
  const ctx = canvas.getContext('2d')!;
  if (!maskUrl) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }
  const maskImg = new Image();
  maskImg.crossOrigin = 'anonymous'; // drawn into a canvas that's then read back via getImageData
  await new Promise<void>((resolve, reject) => {
    maskImg.onload = () => resolve();
    maskImg.onerror = reject;
    maskImg.src = maskUrl;
  });

  canvas.width = maskImg.naturalWidth;
  canvas.height = maskImg.naturalHeight;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = maskImg.naturalWidth;
  maskCanvas.height = maskImg.naturalHeight;
  const maskCtx = maskCanvas.getContext('2d')!;
  maskCtx.drawImage(maskImg, 0, 0);
  const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);

  const overlay = ctx.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < maskData.data.length; i += 4) {
    const strength = maskData.data[i]!; // grayscale value = mask strength, see shared's mask convention
    overlay.data[i] = 255;
    overlay.data[i + 1] = 0;
    overlay.data[i + 2] = 0;
    overlay.data[i + 3] = Math.round((strength / 255) * FACE_PHOTO_PREVIEW_MASK_ALPHA_MAX);
  }
  ctx.putImageData(overlay, 0, 0);
}

async function renderFacePhotoCard() {
  if (!facePhotoUrl) {
    facePhotoCardEl.hidden = true;
    faceDropzone.hidden = false;
    faceFileList.hidden = false;
    return;
  }
  faceDropzone.hidden = true;
  faceFileList.hidden = true;
  facePhotoCardEl.hidden = false;
  facePhotoCardImg.src = facePhotoUrl;
  try {
    await renderFacePhotoMaskOverlay(facePhotoCardMaskCanvas, faceMaskUrl);
  } catch (err) {
    console.error('face photo mask preview render failed', err);
  }
}

function onFaceRemoved(path: string) {
  faceRemaining += 1;
  faceUploaded -= 1;
  faceRowsByPath.delete(path);
  facePhotoUrl = null;
  facePhotoPath = null;
  currentFaceRow = null;
  faceMaskUrl = null;
  faceMaskReviewed = false;
  updateFaceDropzoneState();
  updateFaceSub();
  updateFaceMaskLinkState();
  renderFacePhotoCard();
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
    (body.badPaths || []).forEach((path: string) => {
      const row = faceRowsByPath.get(path);
      if (row) faceHelpers.markRowError(row as unknown as FileRow, 'Multiple people');
    });
    return;
  }

  faceNotified = true;
  fetchAndRenderResults();
}

async function handleFaceFiles(fileListInput: FileList) {
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
      onDone: (path, confirmBody, objectUrl, row) => {
        faceRowsByPath.set(path, true);
        facePhotoUrl = objectUrl;
        facePhotoPath = path;
        currentFaceRow = row;
        faceMaskUrl = (confirmBody && (confirmBody.maskUrl as string | null)) || null;
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
    renderFacePhotoCard();
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
  if (e.dataTransfer?.files) handleFaceFiles(e.dataTransfer.files);
});
faceFileInput.addEventListener('change', () => {
  if (faceFileInput.files) handleFaceFiles(faceFileInput.files);
  faceFileInput.value = '';
});

facePhotoReplaceBtn.addEventListener('click', async () => {
  // Explicit remove-then-pick instead of just opening the file input --
  // otherwise a user "replacing" their photo without first removing it would
  // silently hit the 1-photo limit server-side and keep swapping with the
  // old photo, with no clear signal why.
  if (currentFaceRow && facePhotoPath) {
    facePhotoReplaceBtn.disabled = true;
    const removed = await removeRow(currentFaceRow, facePhotoPath, 'face', faceErrorEl, onFaceRemoved);
    facePhotoReplaceBtn.disabled = false;
    if (!removed) return;
  }
  faceFileInput.click();
});

// ---------------------------------------------------------------------------
// Target section -- library picker + own uploads (no paywall for now, so
// both are unlocked for everyone). Picking/uploading a photo notifies admin
// once (not per-photo) and never requires an explicit "done" button.
// ---------------------------------------------------------------------------

const targetDropzone = targetSection.querySelector<HTMLElement>('[data-dropzone]')!;
const targetFileInput = targetSection.querySelector<HTMLInputElement>('#target-file-input')!;
const targetErrorEl = targetSection.querySelector<HTMLElement>('.upload-error')!;
const targetFileList = targetSection.querySelector<HTMLElement>('.file-list')!;
const targetSubEl = targetSection.querySelector<HTMLElement>('[data-sub]')!;
const targetHelpers = createFileList(targetFileList);
const libraryGrid = targetSection.querySelector<HTMLElement>('[data-library-grid]')!;
const libraryShowMoreBtn = targetSection.querySelector<HTMLButtonElement>('[data-library-show-more]')!;
const libraryErrorEl = targetSection.querySelector<HTMLElement>('.library-error')!;
const targetLockedEl = targetSection.querySelector<HTMLElement>('[data-target-locked]')!;
const targetLockedMsgEl = targetSection.querySelector<HTMLElement>('[data-target-locked-msg]')!;
const targetLockedReviewBtn = targetSection.querySelector<HTMLButtonElement>('[data-target-locked-review]')!;
const targetContentEl = targetSection.querySelector<HTMLElement>('[data-target-content]')!;

interface LibraryPhoto {
  id: number;
  storagePath: string;
  url: string;
}

const LIBRARY_BATCH_SIZE = 24;
let libraryPhotos: LibraryPhoto[] = [];
let libraryShownCount = 0;
let selectedLibraryPaths = new Set<string>();

let targetRemaining = 0;
let targetUploaded = 0;
let targetMax = 0;
let targetNotified = false;

// Target photos stay locked until the end user has reviewed (saved) their
// auto-generated face mask at least once -- enforced server-side too (see
// hasReviewedFaceMask in api/_lib/identity.ts), this is just the UI half.
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

function showLibraryError(message: string) {
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

function buildLibraryCard(photo: LibraryPhoto) {
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

function applyLibrarySelectionState(photo: LibraryPhoto, cardEl: HTMLButtonElement, selected: boolean) {
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

async function toggleLibrarySelection(photo: LibraryPhoto, cardEl: HTMLButtonElement) {
  libraryErrorEl.hidden = true;
  const wasSelected = selectedLibraryPaths.has(photo.storagePath);

  if (!wasSelected && targetRemaining <= 0) {
    showLibraryError(`You've reached the ${targetMax}-photo limit.`);
    return;
  }

  cardEl.disabled = true;
  cardEl.classList.add('is-pending');
  applyLibrarySelectionState(photo, cardEl, !wasSelected);

  // Resolves to {response, body} (never throws, response null on network
  // failure) rather than a bare Response, since both the main flow below and
  // a fast cancel (see onCancel) may need to read the body independently --
  // a Response's body can only be read once.
  const requestPromise = fetch(wasSelected ? '/api/upload-remove' : '/api/library', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(apiBody('target', wasSelected ? { path: photo.storagePath } : { libraryPhotoId: photo.id })),
  })
    .then(async (response) => ({ response, body: await response.json().catch(() => ({})) }))
    .catch(() => ({ response: null as Response | null, body: {} as Record<string, unknown> }));

  if (!wasSelected) {
    notifyTargetDoneOnce();
    // Opens instantly against the library photo's already-known public URL
    // instead of waiting on the request above to resolve first -- there's no
    // reason the picture and its mask can't start loading/computing right
    // away. The request runs concurrently; its jobId gets attached once it
    // resolves (see attachJobToOpenTargetMaskModal), and approving stays
    // disabled until then.
    openTargetMaskModal({ status: 'mask_review', targetUrl: photo.url, maskUrl: null }, async () => {
      applyLibrarySelectionState(photo, cardEl, false);
      // Wait for the pick to actually land (or fail) before trying to undo
      // it -- a fast cancel-click could otherwise race ahead of the insert
      // and leave an orphaned, un-removable pick behind.
      const { response, body } = await requestPromise;
      if (response?.ok && body && (body as { job?: unknown }).job) {
        await fetch('/api/upload-remove', {
          method: 'POST',
          headers: apiHeaders(),
          body: JSON.stringify(apiBody('target', { path: photo.storagePath })),
        }).catch((err) => console.error('upload-remove (mask review cancel) failed', err));
      }
      await fetchAndRenderResults();
    });
  }
  const openToken = targetMaskOpenToken;

  const { response, body } = await requestPromise;
  cardEl.disabled = false;
  cardEl.classList.remove('is-pending');

  if (!response || !response.ok) {
    applyLibrarySelectionState(photo, cardEl, wasSelected);
    showLibraryError((body && (body as { error?: string }).error) || `Couldn't ${wasSelected ? 'remove' : 'select'} that photo — try again.`);
    if (!wasSelected) failOpenTargetMaskJob(openToken, (body && (body as { error?: string }).error) || "Couldn't add this photo. Please try again.");
    return;
  }

  if (typeof posthog !== 'undefined') posthog.capture(wasSelected ? 'library_photo_deselected' : 'library_photo_selected');
  if (!wasSelected && (body as { job?: MaskReviewJob }).job) {
    attachJobToOpenTargetMaskModal(openToken, (body as { job: MaskReviewJob }).job);
  }
  await fetchAndRenderResults();
}

libraryShowMoreBtn.addEventListener('click', renderNextLibraryBatch);

async function handleTargetFiles(fileListInput: FileList) {
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
  if (!accepted.length) return;

  notifyTargetDoneOnce();
  // Opens instantly against a local preview of the (last) picked file,
  // before any of it has actually uploaded -- there's no reason the photo
  // can't start loading/computing its mask while the real upload (sign ->
  // PUT -> confirm, which actually moves the file's bytes) runs in the
  // background below. Its jobId gets attached once that finishes (see
  // attachJobToOpenTargetMaskModal); approving stays disabled until then.
  const lastFile = accepted[accepted.length - 1]!;
  const previewUrl = URL.createObjectURL(lastFile);
  let cancelledBeforeUploadDone = false;
  openTargetMaskModal({ status: 'mask_review', targetUrl: previewUrl, maskUrl: null }, () => {
    cancelledBeforeUploadDone = true;
  });
  const openToken = targetMaskOpenToken;

  let addedAny = false;
  let lastAddedJob: MaskReviewJob | null = null;
  let lastAddedRow: FileRow | null = null;
  let lastAddedPath: string | null = null;
  for (const file of accepted) {
    const ok = await uploadFile(file, 'target', targetHelpers, targetErrorEl, {
      onDone: (path, confirmBody, _objectUrl, row) => {
        lastAddedJob = (confirmBody?.job as MaskReviewJob | undefined) || null;
        lastAddedRow = row;
        lastAddedPath = path;
      },
      onRemoved: onTargetRemoved,
    });
    if (ok) {
      targetRemaining -= 1;
      targetUploaded += 1;
      updateTargetSub();
      addedAny = true;
    }
  }

  if (lastAddedJob && lastAddedRow && lastAddedPath) {
    const row = lastAddedRow;
    const path = lastAddedPath;
    if (cancelledBeforeUploadDone) {
      // Already closed/undone before the upload finished -- honor that by
      // removing what just landed instead of resurrecting it.
      removeRow(row, path, 'target', targetErrorEl, onTargetRemoved).then(() => fetchAndRenderResults());
    } else {
      attachJobToOpenTargetMaskModal(openToken, lastAddedJob);
      // The modal's onCancel above was a placeholder (nothing existed to
      // remove yet) -- now that the real row/path exist, undoing is the same
      // as that row's own remove button.
      targetMaskOnCancel = () => {
        removeRow(row, path, 'target', targetErrorEl, onTargetRemoved).then(() => fetchAndRenderResults());
      };
    }
  } else if (!cancelledBeforeUploadDone) {
    failOpenTargetMaskJob(openToken, "Couldn't upload this photo. Please try again.");
  }

  if (addedAny) await fetchAndRenderResults();
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
  if (e.dataTransfer?.files) handleTargetFiles(e.dataTransfer.files);
});
targetFileInput.addEventListener('change', () => {
  if (targetFileInput.files) handleTargetFiles(targetFileInput.files);
  targetFileInput.value = '';
});

// ---------------------------------------------------------------------------
// Face mask editor -- a paint/erase canvas over the uploaded face photo,
// pre-filled with the auto-generated mask (see shared/automask.ts's
// computeAutoMaskCanvasForFace, wired in through shared's createMaskCanvasEditor).
// Saving marks the mask reviewed, which is what unlocks the target section
// (see updateTargetLockState above).
// ---------------------------------------------------------------------------

function loadImageEl(imgEl: HTMLImageElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    imgEl.onload = () => resolve();
    imgEl.onerror = reject;
    imgEl.src = src;
  });
}

const faceMaskModal = document.querySelector<HTMLElement>('[data-face-mask-modal]')!;
const faceMaskCloseBtn = faceMaskModal.querySelector<HTMLButtonElement>('[data-face-mask-close]')!;
const faceMaskImg = faceMaskModal.querySelector<HTMLImageElement>('[data-face-mask-img]')!;
const faceMaskCanvas = faceMaskModal.querySelector<HTMLCanvasElement>('[data-face-mask-canvas]')!;
const faceMaskToolBtns = faceMaskModal.querySelectorAll<HTMLButtonElement>('[data-face-mask-tool]');
const faceMaskBrushSize = faceMaskModal.querySelector<HTMLInputElement>('[data-face-mask-brush-size]')!;
const faceMaskErrorEl = faceMaskModal.querySelector<HTMLElement>('[data-face-mask-error]')!;
const faceMaskSaveBtn = faceMaskModal.querySelector<HTMLButtonElement>('[data-face-mask-save]')!;
const faceMaskAutoBtn = faceMaskModal.querySelector<HTMLButtonElement>('[data-face-mask-auto]')!;

let faceMaskTool: MaskTool = 'paint';
let faceMaskLastFocused: HTMLElement | null = null;

faceMaskToolBtns.forEach((btn) =>
  btn.addEventListener('click', () => {
    faceMaskTool = btn.dataset.faceMaskTool as MaskTool;
    faceMaskToolBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
  })
);

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
// Isolates just the selected person's hair+skin blob instead of every person
// in the frame -- both the face photo and target photos can have more than
// one person in them, so both masks need the same face-detection-aware
// isolation rather than marking every face in the shot.
async function computeAndLoadAutoMask(editor: ReturnType<typeof createMaskCanvasEditor>, photoImgEl: HTMLImageElement) {
  const faces = await detectFaces(photoImgEl);
  const faceBox = selectFace(faces, photoImgEl.naturalWidth);
  await editor.loadAutoMaskForFace(photoImgEl, faceBox);
}

async function loadStoredOrAutoMask(editor: ReturnType<typeof createMaskCanvasEditor>, maskUrl: string | null, photoImgEl: HTMLImageElement) {
  if (maskUrl) {
    try {
      await editor.loadMask(maskUrl);
      return;
    } catch (err) {
      console.warn('stored mask failed to load, computing auto-mask instead', err);
    }
  }
  await computeAndLoadAutoMask(editor, photoImgEl);
}

async function openFaceMaskModal() {
  if (!facePhotoUrl) return;
  faceMaskErrorEl.hidden = true;
  faceMaskLastFocused = document.activeElement as HTMLElement | null;
  faceMaskModal.hidden = false;
  faceMaskCloseBtn.focus();
  if (typeof posthog !== 'undefined') posthog.capture('face_mask_modal_opened');

  try {
    await loadImageEl(faceMaskImg, facePhotoUrl);
  } catch (err) {
    console.error('load face photo failed', err);
    faceMaskErrorEl.textContent = "Couldn't load your photo. Please try again.";
    faceMaskErrorEl.hidden = false;
    return;
  }

  faceMaskEditor.resize(faceMaskImg.naturalWidth, faceMaskImg.naturalHeight);
  try {
    await loadStoredOrAutoMask(faceMaskEditor, faceMaskUrl, faceMaskImg);
  } catch (err) {
    // The photo itself loaded fine here -- this is auto-mask computation
    // failing (e.g. no face detected at a steep head angle), not a load
    // failure, so show the real reason instead of a generic "try again" --
    // the canvas is already sized and ready for a manual paint either way.
    console.error('auto-mask failed', err);
    const reason = (err as Error)?.message || "Couldn't auto-mask this photo.";
    faceMaskErrorEl.textContent = `${reason} You can still paint the mask by hand below.`;
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
faceMaskAutoBtn.addEventListener('click', async () => {
  faceMaskErrorEl.hidden = true;
  faceMaskAutoBtn.disabled = true;
  faceMaskAutoBtn.textContent = 'Computing…';
  try {
    await computeAndLoadAutoMask(faceMaskEditor, faceMaskImg);
  } catch (err) {
    console.error('auto mask (face) failed', err);
    faceMaskErrorEl.textContent = (err as Error)?.message || "Couldn't compute an auto mask for this photo.";
    faceMaskErrorEl.hidden = false;
  }
  faceMaskAutoBtn.disabled = false;
  faceMaskAutoBtn.textContent = 'Auto mask';
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
    const maskDataUrl = faceMaskEditor.exportDataUrl();
    const response = await fetch('/api/results-init', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(apiBody(null, { action: 'save-face-mask', maskDataUrl })),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || 'save-face-mask failed');

    faceMaskReviewed = true;
    faceMaskUrl = maskDataUrl; // data: URL -- no signed-URL round trip needed to refresh the preview
    updateFaceMaskLinkState();
    renderFacePhotoCard();
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
// own auto-generated mask, then approves the real swap themselves (see
// api/results-init.ts's approve-swap action) -- this used to be a manual
// admin step. The face mask itself was already reviewed/approved right
// after upload, so it isn't shown again here.
// ---------------------------------------------------------------------------

interface MaskReviewJob {
  status: string;
  jobId?: number;
  targetPhotoId?: number;
  targetUrl?: string | null;
  maskUrl?: string | null;
  url?: string | null;
  downloadUrl?: string | null;
  liked?: boolean | null;
  comment?: string | null;
  regenerateCount?: number;
  processingStartedAt?: string;
}

const targetMaskModal = document.querySelector<HTMLElement>('[data-target-mask-modal]')!;
const targetMaskCloseBtn = targetMaskModal.querySelector<HTMLButtonElement>('[data-target-mask-close]')!;
const targetMaskImg = targetMaskModal.querySelector<HTMLImageElement>('[data-target-mask-img]')!;
const targetMaskCanvas = targetMaskModal.querySelector<HTMLCanvasElement>('[data-target-mask-canvas]')!;
const targetMaskToolBtns = targetMaskModal.querySelectorAll<HTMLButtonElement>('[data-target-mask-tool]');
const targetMaskBrushSize = targetMaskModal.querySelector<HTMLInputElement>('[data-target-mask-brush-size]')!;
const targetMaskErrorEl = targetMaskModal.querySelector<HTMLElement>('[data-target-mask-error]')!;
const targetMaskApproveBtn = targetMaskModal.querySelector<HTMLButtonElement>('[data-target-mask-approve]')!;
const targetMaskAutoBtn = targetMaskModal.querySelector<HTMLButtonElement>('[data-target-mask-auto]')!;
const targetMaskInstructionsEl = targetMaskModal.querySelector<HTMLTextAreaElement>('[data-target-mask-instructions]')!;
const targetMaskLoadingEl = targetMaskModal.querySelector<HTMLElement>('[data-target-mask-loading]')!;

let targetMaskTool: MaskTool = 'paint';
let targetMaskLastFocused: HTMLElement | null = null;
let targetMaskCurrentJob: MaskReviewJob | null = null;
let targetMaskOnCancel: (() => void) | null = null;
// Bumped on every openTargetMaskModal call -- lets a background job request
// (see attachJobToOpenTargetMaskModal/failOpenTargetMaskJob) that resolves
// after the user has already closed this modal, or opened a different one,
// recognize it's stale and do nothing instead of mutating the wrong state.
let targetMaskOpenToken = 0;
// Approving needs a real jobId from the server, separate from whether the
// photo/mask have finished loading -- the modal opens instantly against a
// photo URL the client already knows (see toggleLibrarySelection/
// handleTargetFiles), before the request that actually creates the job has
// necessarily resolved.
let targetMaskJobReady = false;
let targetMaskJobFailed = false;

function refreshTargetMaskApproveState() {
  targetMaskApproveBtn.disabled = !targetMaskJobReady || targetMaskJobFailed;
}

targetMaskToolBtns.forEach((btn) =>
  btn.addEventListener('click', () => {
    targetMaskTool = btn.dataset.targetMaskTool as MaskTool;
    targetMaskToolBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
  })
);

const targetMaskEditor = createMaskCanvasEditor(targetMaskCanvas, {
  getBrushSize: () => Number(targetMaskBrushSize.value),
  getTool: () => targetMaskTool,
});

// onCancel undoes the pick entirely (same as deselecting/removing it would
// have) -- a target photo is never left sitting in a "needs review" limbo
// state (the results grid only ever shows real progress, see renderJobs),
// so closing without approving is the same as never having picked it.
//
// Opens instantly against whatever photo URL the caller already knows
// client-side (a library photo's public URL, or a just-picked file's local
// object URL) -- it does NOT wait for the request that actually creates the
// swap_jobs row first. That request runs concurrently; the caller attaches
// its result afterward via attachJobToOpenTargetMaskModal/
// failOpenTargetMaskJob. Approving is disabled until a real jobId lands.
async function openTargetMaskModal(job: MaskReviewJob, onCancel?: () => void) {
  const token = ++targetMaskOpenToken;
  targetMaskCurrentJob = job;
  targetMaskOnCancel = onCancel ?? null;
  targetMaskJobReady = Boolean(job.jobId);
  targetMaskJobFailed = false;
  targetMaskErrorEl.hidden = true;
  targetMaskInstructionsEl.value = '';
  targetMaskLoadingEl.hidden = false;
  refreshTargetMaskApproveState();
  targetMaskLastFocused = document.activeElement as HTMLElement | null;
  targetMaskModal.hidden = false;
  targetMaskCloseBtn.focus();
  if (typeof posthog !== 'undefined') posthog.capture('target_mask_modal_opened');

  try {
    await loadImageEl(targetMaskImg, job.targetUrl || '');
  } catch (err) {
    if (token !== targetMaskOpenToken) return;
    console.error('load target photo failed', err);
    targetMaskErrorEl.textContent = "Couldn't load this photo. Please try again.";
    targetMaskErrorEl.hidden = false;
    targetMaskLoadingEl.hidden = true;
    return;
  }
  if (token !== targetMaskOpenToken) return;

  targetMaskEditor.resize(targetMaskImg.naturalWidth, targetMaskImg.naturalHeight);
  try {
    await loadStoredOrAutoMask(targetMaskEditor, job.maskUrl ?? null, targetMaskImg);
  } catch (err) {
    // The photo itself loaded fine here -- this is auto-mask computation
    // failing (e.g. no face detected at a steep head angle), not a load
    // failure, so show the real reason instead of a generic "try again" --
    // the canvas is already sized and ready for a manual paint either way.
    if (token !== targetMaskOpenToken) return;
    console.error('auto-mask failed', err);
    const reason = (err as Error)?.message || "Couldn't auto-mask this photo.";
    targetMaskErrorEl.textContent = `${reason} You can still paint the mask by hand below.`;
    targetMaskErrorEl.hidden = false;
  }
  if (token !== targetMaskOpenToken) return;
  targetMaskLoadingEl.hidden = true;
}

// Called once the request that actually creates the swap_jobs row resolves
// successfully -- may land before or after the photo/mask finish loading
// above, in either order.
function attachJobToOpenTargetMaskModal(token: number, job: MaskReviewJob) {
  if (token !== targetMaskOpenToken || !targetMaskCurrentJob) return;
  targetMaskCurrentJob.jobId = job.jobId;
  targetMaskCurrentJob.targetPhotoId = job.targetPhotoId;
  targetMaskJobReady = true;
  refreshTargetMaskApproveState();
}

function failOpenTargetMaskJob(token: number, message: string) {
  if (token !== targetMaskOpenToken || !targetMaskCurrentJob) return;
  targetMaskJobFailed = true;
  targetMaskErrorEl.textContent = message;
  targetMaskErrorEl.hidden = false;
  refreshTargetMaskApproveState();
}

// Hides the modal without running onCancel -- used by the approve handler,
// which has already launched the swap and must not undo the pick.
function hideTargetMaskModal() {
  targetMaskModal.hidden = true;
  targetMaskCurrentJob = null;
  targetMaskOnCancel = null;
  if (targetMaskLastFocused) targetMaskLastFocused.focus();
}

// Used by the X button / backdrop / Escape -- backing out without approving
// undoes the pick (see openTargetMaskModal's onCancel doc comment above).
function closeTargetMaskModal() {
  const onCancel = targetMaskOnCancel;
  hideTargetMaskModal();
  onCancel?.();
}

targetMaskCloseBtn.addEventListener('click', closeTargetMaskModal);
targetMaskModal.addEventListener('click', (e) => {
  if (e.target === targetMaskModal) closeTargetMaskModal();
});
targetMaskAutoBtn.addEventListener('click', async () => {
  targetMaskErrorEl.hidden = true;
  targetMaskAutoBtn.disabled = true;
  targetMaskAutoBtn.textContent = 'Computing…';
  try {
    await computeAndLoadAutoMask(targetMaskEditor, targetMaskImg);
  } catch (err) {
    console.error('auto mask (target) failed', err);
    targetMaskErrorEl.textContent = (err as Error)?.message || "Couldn't compute an auto mask for this photo.";
    targetMaskErrorEl.hidden = false;
  }
  targetMaskAutoBtn.disabled = false;
  targetMaskAutoBtn.textContent = 'Auto mask';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !targetMaskModal.hidden) closeTargetMaskModal();
});

// Approve-swap's own HTTP request still blocks on a real Ideogram call for
// up to ~2 minutes server-side (see results-init.ts's handleApproveSwap),
// but the modal doesn't wait on it -- it closes the instant the request is
// launched, and the results grid shows the job as "processing" (optimistic
// client-side first, then confirmed by handleApproveSwap's own early status
// write) until a background poll picks up the real done/failed outcome.
targetMaskApproveBtn.addEventListener('click', async () => {
  const job = targetMaskCurrentJob;
  if (!job) return;
  const maskDataUrl = targetMaskEditor.exportDataUrl();
  const instructions = targetMaskInstructionsEl.value.trim();

  if (typeof posthog !== 'undefined') posthog.capture('target_mask_approved');
  hideTargetMaskModal();
  markJobProcessing(job.jobId, job.targetPhotoId, job.targetUrl ?? null);

  try {
    const payload: Record<string, unknown> = { action: 'approve-swap', jobId: job.jobId, maskDataUrl, instructions };
    const res = await fetch('/api/results-init', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(apiBody(null, payload)),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || 'approve-swap failed');
  } catch (err) {
    console.error('approve-swap failed', err);
  }

  await fetchAndRenderResults();
  pollForUpdates();
});

// ---------------------------------------------------------------------------
// Results section -- status + lightbox. No paywall for now: downloads are
// unlocked for everyone.
// ---------------------------------------------------------------------------

const gridEl = resultsSection.querySelector<HTMLElement>('[data-results-grid]')!;
const resultsEmptyEl = resultsSection.querySelector<HTMLElement>('[data-results-empty]')!;

const lightbox = document.querySelector<HTMLElement>('[data-lightbox]')!;
const lightboxImg = lightbox.querySelector<HTMLImageElement>('[data-lightbox-img]')!;
const lightboxDownload = lightbox.querySelector<HTMLAnchorElement>('[data-lightbox-download]')!;
const lightboxCloseBtn = lightbox.querySelector<HTMLButtonElement>('[data-lightbox-close]')!;
let lightboxLastFocused: HTMLElement | null = null;

function openLightbox(url: string, downloadUrl: string | null | undefined) {
  lightboxLastFocused = document.activeElement as HTMLElement | null;
  lightboxImg.src = url;
  lightboxDownload.href = downloadUrl || '';
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

async function submitFeedback(targetPhotoId: number | undefined, liked: boolean): Promise<boolean> {
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

async function submitEditRequest(targetPhotoId: number | undefined, comment: string): Promise<boolean> {
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

async function requestRegenerate(targetPhotoId: number | undefined): Promise<MaskReviewJob | null> {
  const response = await fetch('/api/results-init', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(apiBody(null, { action: 'regenerate', targetPhotoId })),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not regenerate');
  if (typeof posthog !== 'undefined') posthog.capture('result_regenerate_requested');
  return (data.job as MaskReviewJob | undefined) || null;
}

function renderJobs(allJobs: MaskReviewJob[], regenerateCap: number) {
  // mask_review never gets its own card -- the moment a target is picked,
  // its review happens right there in the auto-opened modal (see
  // toggleLibrarySelection/handleTargetFiles), and closing without approving
  // undoes the pick entirely (see closeTargetMaskModal). So by the time this
  // renders, nothing should still be sitting in that status -- the results
  // section only ever shows real progress.
  const jobs = allJobs.filter((job) => job.status !== 'mask_review');

  gridEl.innerHTML = '';
  if (!jobs.length) {
    gridEl.hidden = true;
    resultsEmptyEl.hidden = false;
    return;
  }
  gridEl.hidden = false;
  resultsEmptyEl.hidden = true;

  const STATUS_LABELS: Record<string, string> = {
    done: 'Ready',
    failed: 'Failed',
    queued: 'Queued',
    processing: 'Processing',
    needs_review: 'In review',
  };

  jobs.forEach((job) => {
    const statusClass = ['done', 'failed', 'queued', 'needs_review'].includes(job.status) ? job.status.replace('_', '-') : 'pending';

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
      photoBtn.addEventListener('click', () => openLightbox(job.url!, job.downloadUrl));
      li.appendChild(photoBtn);
    }

    // No click handler -- the swap is already running, there's nothing to
    // do with this photo yet. Ideogram's API exposes no progress percentage
    // (just pending/completed/failed, see shared/src/ideogram.ts), so the
    // bar below is a simulation calibrated off historical swap durations
    // (see tickProgressBars), not a real completion fraction.
    if (job.status === 'processing' && job.targetUrl) {
      const photoWrap = document.createElement('div');
      photoWrap.className = 'result-card-photo is-static';
      const img = document.createElement('img');
      img.src = job.targetUrl;
      img.alt = '';
      photoWrap.appendChild(img);
      li.appendChild(photoWrap);

      if (job.processingStartedAt) {
        photoWrap.appendChild(buildProgressRing(job.processingStartedAt));
      }
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
    labelText.textContent = STATUS_LABELS[job.status] || STATUS_LABELS.processing!;
    label.append(dot, labelText);
    row.appendChild(label);

    if (job.status === 'done' && job.url) {
      const link = document.createElement('a');
      link.href = job.downloadUrl || '';
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
      if ((job.regenerateCount ?? 0) >= regenerateCap) {
        regenBtn.disabled = true;
        regenBtn.textContent = 'Regenerate limit reached — email us';
      }

      const setLiked = (liked: boolean) => {
        likeBtn.classList.toggle('is-active', liked === true);
        dislikeBtn.classList.toggle('is-active', liked === false);
        if ((job.regenerateCount ?? 0) < regenerateCap) regenBtn.hidden = liked !== false;
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
          const newJob = await requestRegenerate(job.targetPhotoId);
          await fetchAndRenderResults();
          // Same mandatory mask-review step a brand-new target goes through
          // (see openTargetMaskModal) -- no onCancel here, unlike a fresh
          // pick: clicking Regenerate already consumed a regenerate slot and
          // deleted the old result/feedback server-side, so there's nothing
          // left to "undo" by backing out of the review -- closing without
          // approving just leaves the review pending for next time.
          if (newJob) await openTargetMaskModal(newJob);
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
      sub.textContent = job.status === 'queued' ? 'Waiting in the queue' : "Our team is reviewing this one — we'll get back to you within 24 hours.";
      status.appendChild(sub);
    }

    li.appendChild(status);
    gridEl.appendChild(li);
  });
}

// Historical median/average processing time (approve-click to done) across
// completed swaps, per a one-off query against swap_jobs -- ~41s median,
// ~52s mean, long tail out to Ideogram's 120s poll deadline plus overhead.
// Tuned so the ring reaches ~60% around the mean and crawls toward a 95%
// ceiling it never quite reaches -- the real "done" status (see pollForUpdates)
// always replaces this card before that would matter, so there's no need to
// ever show 100% here.
const FAKE_PROGRESS_TAU_SECONDS = 52;
const FAKE_PROGRESS_CEILING = 95;

function fakeProgressPercent(elapsedMs: number): number {
  const elapsedSeconds = elapsedMs / 1000;
  return FAKE_PROGRESS_CEILING * (1 - Math.exp(-elapsedSeconds / FAKE_PROGRESS_TAU_SECONDS));
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROGRESS_RING_RADIUS = 20;
const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RING_RADIUS;

function buildProgressRing(startedAt: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'result-card-progress-ring';
  wrap.dataset.progressStartedAt = startedAt;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('class', 'track');
  track.setAttribute('cx', '24');
  track.setAttribute('cy', '24');
  track.setAttribute('r', String(PROGRESS_RING_RADIUS));
  const bar = document.createElementNS(SVG_NS, 'circle');
  bar.setAttribute('class', 'bar');
  bar.setAttribute('cx', '24');
  bar.setAttribute('cy', '24');
  bar.setAttribute('r', String(PROGRESS_RING_RADIUS));
  bar.style.strokeDasharray = `${PROGRESS_RING_CIRCUMFERENCE}`;
  bar.style.strokeDashoffset = `${PROGRESS_RING_CIRCUMFERENCE}`;
  svg.append(track, bar);

  const label = document.createElement('span');
  label.className = 'result-card-progress-label';
  label.textContent = '0%';

  wrap.append(svg, label);
  return wrap;
}

// Runs continuously rather than being started/stopped per card -- renderJobs
// tears down and rebuilds every <li> on each poll, which would otherwise
// leak one interval per render. Querying the DOM fresh each tick is cheap
// (a handful of processing cards at most) and naturally self-cleans: a ring
// removed by the next render just stops being found.
function tickProgressBars() {
  document.querySelectorAll<HTMLElement>('[data-progress-started-at]').forEach((wrap) => {
    const startedAt = new Date(wrap.dataset.progressStartedAt!).getTime();
    const pct = fakeProgressPercent(Date.now() - startedAt);
    const bar = wrap.querySelector<SVGCircleElement>('.bar');
    const label = wrap.querySelector<HTMLElement>('.result-card-progress-label');
    if (bar) bar.style.strokeDashoffset = `${PROGRESS_RING_CIRCUMFERENCE * (1 - pct / 100)}`;
    if (label) label.textContent = `${Math.round(pct)}%`;
  });
}
setInterval(tickProgressBars, 300);

// True while there's still work the pipeline could finish -- any job still
// processing/queued (includes freshly-regenerated jobs, which start back at
// "queued" the moment their old swap_jobs row is deleted).
function hasInFlightWork(data: { jobs?: MaskReviewJob[] }): boolean {
  return (data.jobs || []).some((job) => job.status === 'processing' || job.status === 'queued');
}

// Kept around so a just-approved job can be shown as "processing" the
// instant its review modal closes, without waiting on a round trip to the
// server (which won't reflect that status until approve-swap's own first
// write -- see results-init.ts's handleApproveSwap).
let lastResultsData: { jobs: MaskReviewJob[]; regenerateCap: number } | null = null;

// Upserts rather than requiring the job to already be in lastResultsData --
// a swap can be approved before the select/upload response's background
// fetchAndRenderResults() call has landed, so the job may not be there yet.
function markJobProcessing(jobId: number | undefined, targetPhotoId: number | undefined, targetUrl: string | null) {
  if (!lastResultsData) lastResultsData = { jobs: [], regenerateCap: 0 };
  // Stamped here (not left for the next fetchAndRenderResults) so the fake
  // progress bar (see renderJobs/tickProgressBars) starts counting from the
  // moment the customer actually clicked approve, not from whenever this
  // target was first picked -- the real processing_started_at the server
  // writes lands within the same fetch cycle and matches this within a
  // second or two.
  const processingStartedAt = new Date().toISOString();
  const job = lastResultsData.jobs.find((j) => (jobId != null && j.jobId === jobId) || j.targetPhotoId === targetPhotoId);
  if (job) {
    job.status = 'processing';
    job.processingStartedAt = processingStartedAt;
    if (targetUrl) job.targetUrl = targetUrl;
  } else {
    lastResultsData.jobs.push({ status: 'processing', jobId, targetPhotoId, targetUrl, processingStartedAt });
  }
  renderJobs(lastResultsData.jobs, lastResultsData.regenerateCap);
}

// Single source of truth for fetching + rendering the results section --
// used on init, after a notify-done ping, and by both poll loops below.
async function fetchAndRenderResults(): Promise<{ jobs?: MaskReviewJob[]; regenerateCap: number } | null> {
  const response = await fetch('/api/results-init', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(apiBody(null, {})),
  });
  if (!response.ok) return null;
  const data = await response.json();
  lastResultsData = { jobs: data.jobs || [], regenerateCap: data.regenerateCap };
  renderJobs(lastResultsData.jobs, lastResultsData.regenerateCap);
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

const signinState = document.querySelector<HTMLElement>('[data-state="signin"]')!;
const signinPhoneForm = signinState.querySelector<HTMLFormElement>('[data-signin-phone-form]')!;
const signinOtpForm = signinState.querySelector<HTMLFormElement>('[data-signin-otp-form]')!;
const signinPhoneError = signinPhoneForm.querySelector<HTMLElement>('.upload-error')!;
const signinOtpError = signinOtpForm.querySelector<HTMLElement>('.upload-error')!;
const signinOtpPhoneEl = signinOtpForm.querySelector<HTMLElement>('[data-signin-otp-phone]')!;
const signinOtpBackBtn = signinOtpForm.querySelector<HTMLButtonElement>('[data-signin-otp-back]')!;
const signinPhoneSubmitBtn = signinPhoneForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const signinOtpSubmitBtn = signinOtpForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const signinNameField = signinPhoneForm.querySelector<HTMLElement>('[data-signin-name-field]')!;
const signinNameInput = signinNameField.querySelector<HTMLInputElement>('input')!;
const signinEmailField = signinPhoneForm.querySelector<HTMLElement>('[data-signin-email-field]')!;
const signinEmailInput = signinEmailField.querySelector<HTMLInputElement>('input')!;
const signinTitleEl = signinState.querySelector<HTMLElement>('[data-signin-title]')!;
const signinSubEl = signinState.querySelector<HTMLElement>('[data-signin-sub]')!;

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

  const data = Object.fromEntries(new FormData(signinPhoneForm).entries()) as Record<string, string>;
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
  signinOtpForm.querySelector<HTMLInputElement>('input[name="code"]')!.focus();
});

signinOtpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  signinOtpError.hidden = true;

  const code = ((new FormData(signinOtpForm).get('code') as string) || '').trim();
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

  if (error || !session || !user) {
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
      let profileError: unknown = null;
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

const loadingErrorEl = document.querySelector<HTMLElement>('[data-state="loading"] [data-loading-error]')!;
const retryLinkEl = document.querySelector<HTMLAnchorElement>('[data-state="loading"] [data-retry-link]')!;
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

    readyState.querySelector<HTMLElement>('[data-name]')!.textContent = faceData.name;

    // Face section.
    faceRemaining = faceData.remaining;
    faceUploaded = faceData.uploaded;
    faceMin = faceData.min;
    faceNotified = faceUploaded >= faceMin;
    (faceData.photos || []).forEach((photo: { url: string; path: string; maskUrl: string | null; maskReviewed: boolean }, i: number) => {
      const row = faceHelpers.addFileRow(`Photo ${i + 1}`, photo.url);
      faceHelpers.markRowDone(row);
      row.removeBtn.disabled = false;
      row.removeBtn.addEventListener('click', () => removeRow(row, photo.path, 'face', faceErrorEl, onFaceRemoved));
      faceRowsByPath.set(photo.path, true);
      facePhotoUrl = photo.url;
      facePhotoPath = photo.path;
      currentFaceRow = row;
      faceMaskUrl = photo.maskUrl;
      faceMaskReviewed = photo.maskReviewed;
    });
    updateFaceSub();
    updateFaceDropzoneState();
    updateFaceMaskLinkState();
    renderFacePhotoCard();
    updateTargetLockState();

    // Target section.
    targetRemaining = targetData.remaining;
    targetUploaded = targetData.uploaded;
    targetMax = targetData.max;
    targetNotified = targetUploaded > 0;
    const ownTargetPhotos = (targetData.photos || []).filter((photo: { library: boolean }) => !photo.library);
    selectedLibraryPaths = new Set<string>((targetData.photos || []).filter((photo: { library: boolean }) => photo.library).map((photo: { path: string }) => photo.path));
    ownTargetPhotos.forEach((photo: { url: string; path: string }, i: number) => {
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
