/**
 * Admin pipeline control panel frontend. Ported from face_swap/src/pipeline.ts,
 * repointed at the cloud admin-pipeline-* endpoints instead of a local
 * Express server: imgUrl() is gone (every image is already a signed Supabase
 * Storage URL straight off the state response), uploads go through a
 * sign -> direct PUT -> confirm flow instead of a raw POST body, and
 * runUpscale/runIdeogram start a job then poll it instead of one blocking
 * fetch. shared's createMaskCanvasEditor/detectFaces/selectFace/
 * suggestSquareCropBox/computeAutoMaskCanvasForFace are unchanged.
 */

import { createClient } from '@supabase/supabase-js';
import { computeAutoMaskCanvasForFace, createMaskCanvasEditor, detectFaces, selectFace, suggestSquareCropBox, type FaceSelector, type MaskTool } from 'shared';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabaseConfig.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

interface PipelineResult {
  id: string;
  url: string;
  deliveredFilename: string;
  prompt: string;
  expression: string | null;
}

interface PipelineRow {
  id: string;
  originalFilename: string;
  originalUrl: string;
  cropUrl: string | null;
  upscaleUrl: string | null;
  upscaleTarget: number | null;
  maskUrl: string | null;
  maskPreviewUrl: string | null;
  hasMask: boolean;
  hasCrop: boolean;
  results: PipelineResult[];
}

interface Project {
  id: string;
  label: string;
}

let projects: Project[] = [];
let currentProjectId: string | null = null;
let state: PipelineRow[] = [];

async function actionPost(action: string, body: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch('/api/admin-pipeline-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${action} failed`);
  return j;
}

async function runPost(action: string, body: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch('/api/admin-pipeline-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${action} failed`);
  return j;
}

async function dataGet(resource: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams({ resource, ...params });
  const r = await fetch(`/api/admin-pipeline-data?${qs}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${resource} failed`);
  return j;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> | null,
  ...children: (Node | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  });
  children.forEach((c) => c && e.appendChild(c));
  return e;
}

// Every image is a remote Supabase Storage signed URL -- shared/faceDetector.ts's
// detectFaces() needs crossOrigin='anonymous' set *before* load to read pixels
// off a cross-origin <img> (shared/automask.ts handles this internally with
// its own throwaway reload, faceDetector.ts does not).
function loadImageEl(imgEl: HTMLImageElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    imgEl.onload = () => resolve();
    imgEl.onerror = () => reject(new Error(`failed to load ${src}`));
    imgEl.crossOrigin = 'anonymous';
    imgEl.src = src;
  });
}

function parseSelect(value: string): FaceSelector {
  if (value === 'largest' || value === 'center') return value;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 'largest';
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

const lightboxEl = document.getElementById('lightbox')!;
const lightboxImg = document.getElementById('lightboxImg') as HTMLImageElement;
const lightboxDownload = document.getElementById('lightboxDownload') as HTMLAnchorElement;
const lightboxParams = document.getElementById('lightboxParams')!;

function openLightbox(url: string, downloadName: string, prompt?: string | null): void {
  lightboxImg.src = url;
  lightboxDownload.href = url;
  lightboxDownload.download = downloadName;
  lightboxEl.style.display = 'flex';

  if (prompt) {
    lightboxParams.innerHTML = `<b>Prompt:</b> ${prompt}`;
    lightboxParams.style.display = 'block';
  } else {
    lightboxParams.style.display = 'none';
    lightboxParams.innerHTML = '';
  }
}
lightboxDownload.addEventListener('click', (e) => e.stopPropagation());
lightboxParams.addEventListener('click', (e) => e.stopPropagation());
lightboxEl.addEventListener('click', () => {
  lightboxEl.style.display = 'none';
});

// ---------------------------------------------------------------------------
// Projects + Ideogram character reference
// ---------------------------------------------------------------------------

const projectSelect = document.getElementById('project') as HTMLSelectElement;
const refThumb = document.getElementById('refThumb') as HTMLImageElement;
const refStatus = document.getElementById('refStatus')!;
const refMaskStatus = document.getElementById('refMaskStatus')!;
let refHasMask = false;
let refMaskUrl: string | null = null;

async function refreshProjects(): Promise<void> {
  projects = await dataGet('projects');
  projectSelect.innerHTML = projects.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  currentProjectId = projects[0]?.id || null;
  if (currentProjectId) projectSelect.value = currentProjectId;
  await refreshState();
  await refreshReference();
}
projectSelect.addEventListener('change', () => {
  currentProjectId = projectSelect.value || null;
  refreshState();
});

document.getElementById('newProjectBtn')!.addEventListener('click', async () => {
  const label = prompt('Project name:');
  if (!label) return;
  try {
    const project = await actionPost('create-project', { label });
    await refreshProjects();
    projectSelect.value = project.id;
    currentProjectId = project.id;
    await refreshState();
  } catch (e) {
    alert((e as Error).message || String(e));
  }
});

document.getElementById('deleteProjectBtn')!.addEventListener('click', async () => {
  if (!currentProjectId) return;
  const label = projects.find((p) => p.id === currentProjectId)?.label || '';
  if (!confirm(`Delete project "${label}" and everything in it? This can't be undone.`)) return;
  try {
    await actionPost('delete-project', { projectId: currentProjectId });
    await refreshProjects();
  } catch (e) {
    alert((e as Error).message || String(e));
  }
});

async function refreshReference(): Promise<void> {
  const j = await dataGet('reference');
  refHasMask = j.hasReferenceMask;
  refMaskUrl = j.referenceMaskUrl;
  if (j.hasReference) {
    refThumb.src = j.referenceUrl;
    refThumb.style.display = '';
    refStatus.textContent = '';
  } else {
    refThumb.style.display = 'none';
    refStatus.textContent = 'No reference photo set';
    refStatus.style.color = '#e57373';
  }
  refMaskStatus.textContent = refHasMask ? 'Mask set' : 'No mask (using whole photo)';
}

const refFileInput = document.getElementById('refFileInput') as HTMLInputElement;
refFileInput.addEventListener('change', async () => {
  const file = refFileInput.files?.[0];
  refFileInput.value = '';
  if (!file) return;
  try {
    const signed = await actionPost('sign-upload', { target: 'reference', contentType: file.type });
    const { error } = await supabase.storage.from(signed.bucket).uploadToSignedUrl(signed.path, signed.signToken, file);
    if (error) throw error;
    await actionPost('confirm-reference-upload');
    await refreshReference();
  } catch (e) {
    alert((e as Error).message || String(e));
  }
});
document.getElementById('setReferenceBtn')!.addEventListener('click', () => refFileInput.click());
refThumb.addEventListener('click', () => refFileInput.click());
document.getElementById('paintReferenceMaskBtn')!.addEventListener('click', () => {
  if (!refThumb.src || refThumb.style.display === 'none') {
    alert('Upload a reference photo first.');
    return;
  }
  openReferencePaint();
});

async function refreshState(): Promise<void> {
  if (!currentProjectId) {
    state = [];
    render();
    return;
  }
  state = await dataGet('state', { projectId: currentProjectId });
  render();
}

// ---------------------------------------------------------------------------
// Row rendering
// ---------------------------------------------------------------------------

function resultList(results: PipelineResult[]): HTMLElement {
  const wrap = el('div', { class: 'swaplist' });
  results.forEach((result) => {
    const img = el('img', {});
    img.src = result.url;
    img.addEventListener('click', () => openLightbox(result.url, result.deliveredFilename, result.prompt));
    const info = el('div', { class: 'swapinfo', text: 'i' });
    const tooltip = el('div', { class: 'tooltip' });
    tooltip.innerHTML = `<b>Prompt:</b> ${result.prompt}`;
    info.appendChild(tooltip);
    const del = el('div', { class: 'swapdel', text: '×' });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this result? This can't be undone.")) return;
      try {
        await actionPost('remove-result', { resultId: result.id });
        refreshState();
      } catch (e2) {
        alert((e2 as Error).message || String(e2));
      }
    });
    const thumb = el('div', { class: 'swapthumb has-info' }, img, info, del);
    wrap.appendChild(thumb);
  });
  return wrap;
}

function stageThumb(url: string | null, onClick: () => void): HTMLElement {
  if (!url) return el('div', { class: 'placeholder', text: 'none yet' });
  const img = el('img', {});
  img.src = url;
  img.addEventListener('click', onClick);
  return img;
}

interface RowSettings {
  sel: string;
  bias: string;
  target: string;
}
const rowSettings: Record<string, RowSettings> = {};

function captureRowSettings(): void {
  state.forEach((row) => {
    const prev = rowSettings[row.id];
    const get = (id: string, fallback: string) => {
      const node = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      return node ? node.value : fallback;
    };
    rowSettings[row.id] = {
      sel: get('sel_' + row.id, prev?.sel ?? 'largest'),
      bias: get('bias_' + row.id, prev?.bias ?? '0.15'),
      target: get('target_' + row.id, prev?.target ?? '4200'),
    };
  });
}

function labeled(text: string, node: HTMLElement): HTMLElement {
  return el(
    'label',
    { style: 'font-size:10px;color:#999;display:flex;flex-direction:column;gap:2px;' },
    document.createTextNode(text),
    node
  );
}
function selectEl(id: string, options: string[], selected?: string): HTMLSelectElement {
  const s = el('select', { id });
  options.forEach((o) => s.appendChild(el('option', { value: o, text: o })));
  if (selected !== undefined && options.includes(selected)) s.value = selected;
  return s;
}
function inputEl(id: string, value: string, width: number): HTMLInputElement {
  return el('input', { id, value, style: `width:${width}px` });
}
function controlsBlock(inputs: HTMLElement[], actions: HTMLElement[]): HTMLElement {
  return el('div', { class: 'controls' }, el('div', { class: 'controls-inputs' }, ...inputs), el('div', { class: 'controls-actions' }, ...actions));
}
function runBtn(fn: () => Promise<void>, label: string, disabled = false): HTMLButtonElement {
  const b = el('button', { text: label });
  if (disabled) b.disabled = true;
  b.addEventListener('click', async () => {
    b.disabled = true;
    const original = b.textContent;
    b.textContent = '...';
    try {
      await fn();
    } catch (e) {
      alert((e as Error).message || String(e));
    }
    b.textContent = original;
    b.disabled = false;
  });
  return b;
}
function adjustBtn(onClick: () => void): HTMLButtonElement {
  const b = el('button', { text: 'Adjust...' });
  b.addEventListener('click', onClick);
  return b;
}
function removeBtn(row: PipelineRow): HTMLButtonElement {
  const b = el('button', { text: 'Remove photo', style: 'color:#f88;border-color:#633;' });
  b.addEventListener('click', async () => {
    if (!confirm(`Remove "${row.originalFilename}" and everything generated from it? This can't be undone.`)) return;
    b.disabled = true;
    try {
      await actionPost('remove-photo', { photoId: row.id });
      refreshState();
    } catch (e) {
      alert((e as Error).message || String(e));
      b.disabled = false;
    }
  });
  return b;
}

function render(): void {
  captureRowSettings();
  const rows = document.getElementById('rows')!;
  rows.innerHTML = '';
  if (!currentProjectId) {
    rows.appendChild(el('p', { style: 'color:#777;', text: 'Create a project to get started.' }));
    return;
  }
  state.forEach((row) => {
    const settings = rowSettings[row.id]!;
    const cropCell = el(
      'div',
      { class: 'stage' },
      el('h3', { text: '1. Crop' }),
      stageThumb(row.cropUrl, () => openLightbox(row.cropUrl!, `${row.originalFilename}_crop.jpg`)),
      controlsBlock(
        [
          labeled('Face', selectEl('sel_' + row.id, ['largest', 'center', '0', '-1'], settings.sel)),
          labeled('Head room', inputEl('bias_' + row.id, settings.bias, 46)),
        ],
        [runBtn(() => runCrop(row), row.hasCrop ? 'Re-crop' : 'Crop'), adjustBtn(() => openCrop(row))]
      )
    );

    const upscaleCell = el(
      'div',
      { class: 'stage' },
      el('h3', { text: '2. Upscale' }),
      stageThumb(row.upscaleUrl, () => openLightbox(row.upscaleUrl!, `${row.originalFilename}_upscale.jpg`)),
      controlsBlock(
        [labeled('Target', inputEl('target_' + row.id, settings.target, 56))],
        [runBtn(() => runUpscale(row), row.upscaleUrl ? 'Re-upscale' : 'Upscale', !row.hasCrop)]
      )
    );

    const maskCell = el(
      'div',
      { class: 'stage' },
      el('h3', { text: '3. Mask' }),
      stageThumb(row.maskPreviewUrl, () => openLightbox(row.maskPreviewUrl!, `${row.originalFilename}_mask.jpg`)),
      controlsBlock([], [runBtn(() => openPaint(row), row.hasMask ? 'Edit mask' : 'Paint mask'), runBtn(() => openAutoMask(row), 'Auto mask')])
    );

    const ideogramWrap = resultList(row.results);
    const ideogramCell = el(
      'div',
      { class: 'stage' },
      el('h3', { text: '4. Ideogram (character ref)' }),
      row.results.length ? ideogramWrap : el('div', { class: 'placeholder', text: 'none yet' }),
      controlsBlock(
        [labeled('Expression (optional)', inputEl('expression_' + row.id, '', 160))],
        [runBtn(() => runIdeogram(row), 'Run Ideogram', !row.hasMask)]
      )
    );

    const thumb = el('img', {});
    thumb.src = row.originalUrl;
    thumb.addEventListener('click', () => openLightbox(row.originalUrl, row.originalFilename));
    const thumbWrap = el('div', { class: 'rowthumb' }, thumb);
    rows.appendChild(
      el(
        'div',
        { class: 'row' },
        el('div', { class: 'rowlabel' }, thumbWrap, document.createTextNode(row.originalFilename), removeBtn(row)),
        cropCell,
        upscaleCell,
        maskCell,
        ideogramCell
      )
    );
  });
}

// ---------------------------------------------------------------------------
// Crop -- client-side face-centered square-box suggestion (shared/faceDetector.ts)
// ---------------------------------------------------------------------------

async function suggestCropBoxFor(imgEl: HTMLImageElement, select: FaceSelector, headBias: number) {
  const w = imgEl.naturalWidth;
  const h = imgEl.naturalHeight;
  try {
    const faces = await detectFaces(imgEl);
    return suggestSquareCropBox(w, h, faces, select, headBias);
  } catch {
    const side = Math.min(w, h);
    return { left: Math.floor((w - side) / 2), top: Math.floor((h - side) / 2), side, width: w, height: h };
  }
}

async function runCrop(row: PipelineRow): Promise<void> {
  const select = parseSelect((document.getElementById('sel_' + row.id) as HTMLSelectElement).value);
  const headBias = parseFloat((document.getElementById('bias_' + row.id) as HTMLInputElement).value);
  const img = new Image();
  await loadImageEl(img, row.originalUrl);
  const box = await suggestCropBoxFor(img, select, headBias);
  await actionPost('run-crop', { photoId: row.id, left: box.left, top: box.top, side: box.side });
  refreshState();
}

const JOB_POLL_INTERVAL_MS = 3000;

async function pollJobToCompletion(jobId: string): Promise<any> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
    const job = await runPost('poll-job', { jobId });
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(job.error || 'job failed');
  }
}

async function runUpscale(row: PipelineRow): Promise<void> {
  const target = Number((document.getElementById('target_' + row.id) as HTMLInputElement).value);
  const job = await runPost('start-upscale', { photoId: row.id, target });
  await pollJobToCompletion(job.id);
  refreshState();
}

async function runIdeogram(row: PipelineRow): Promise<void> {
  const expression = (document.getElementById('expression_' + row.id) as HTMLInputElement).value.trim();
  const job = await runPost('start-ideogram', { photoId: row.id, expression: expression || null });
  await pollJobToCompletion(job.id);
  refreshState();
}

// ---------------------------------------------------------------------------
// Mask paint view -- shared/maskCanvasEditor.ts's createMaskCanvasEditor
// drives the actual paint/erase canvas.
// ---------------------------------------------------------------------------

const paintView = document.getElementById('paintView')!;
const paintImg = document.getElementById('paintImg') as HTMLImageElement;
const paintCanvas = document.getElementById('paintCanvas') as HTMLCanvasElement;
const paintStage = document.getElementById('paintStage') as HTMLDivElement;
const toolPaintBtn = document.getElementById('toolPaint') as HTMLButtonElement;
const toolEraseBtn = document.getElementById('toolErase') as HTMLButtonElement;
const sizeSlider = document.getElementById('size') as HTMLInputElement;
const sizeLabel = document.getElementById('sizeLabel')!;
const zoomSlider = document.getElementById('zoom') as HTMLInputElement;
const zoomLabel = document.getElementById('zoomLabel')!;

let paintTool: MaskTool = 'paint';
let paintRow: PipelineRow | null = null;
let paintMode: 'target' | 'reference' = 'target';

function setPaintTool(t: MaskTool): void {
  paintTool = t;
  toolPaintBtn.classList.toggle('is-active', t === 'paint');
  toolEraseBtn.classList.toggle('is-active', t === 'erase');
}
toolPaintBtn.addEventListener('click', () => setPaintTool('paint'));
toolEraseBtn.addEventListener('click', () => setPaintTool('erase'));
sizeSlider.addEventListener('input', () => {
  sizeLabel.textContent = sizeSlider.value;
});

const paintEditor = createMaskCanvasEditor(paintCanvas, {
  getBrushSize: () => Number(sizeSlider.value),
  getTool: () => paintTool,
});

function applyPaintZoom(): void {
  const pct = Number(zoomSlider.value);
  zoomLabel.textContent = String(pct);
  paintStage.style.width = `${(paintImg.naturalWidth * pct) / 100}px`;
}
zoomSlider.addEventListener('input', applyPaintZoom);

function fitPaintZoom(): void {
  const wrap = document.getElementById('paintCanvasWrap')!;
  const availW = wrap.clientWidth - 60;
  const availH = wrap.clientHeight - 60;
  const scale = Math.min(availW / paintImg.naturalWidth, availH / paintImg.naturalHeight, 1);
  const pct = Math.max(5, Math.min(300, Math.round(scale * 100)));
  zoomSlider.value = String(pct);
  applyPaintZoom();
}

async function loadPaintCanvas(imageUrl: string, maskUrl: string | null): Promise<void> {
  await loadImageEl(paintImg, imageUrl);
  paintEditor.resize(paintImg.naturalWidth, paintImg.naturalHeight);
  if (maskUrl) {
    try {
      await paintEditor.loadMask(maskUrl);
    } catch (e) {
      alert((e as Error).message || String(e));
    }
  }
  fitPaintZoom();
}

function openPaint(row: PipelineRow): Promise<void> {
  paintMode = 'target';
  paintRow = row;
  document.getElementById('paintTitle')!.textContent = row.originalFilename;
  document.getElementById('paintStatus')!.textContent = '';
  document.getElementById('paintHint')!.innerHTML = 'Red = will be regenerated. Drag to paint/erase. <kbd>X</kbd> toggles eraser.';
  paintView.style.display = 'flex';
  return loadPaintCanvas(row.upscaleUrl || row.cropUrl || row.originalUrl, row.maskUrl);
}

async function openAutoMask(row: PipelineRow): Promise<void> {
  paintMode = 'target';
  paintRow = row;
  const baseImageUrl = row.upscaleUrl || row.cropUrl || row.originalUrl;
  document.getElementById('paintTitle')!.textContent = row.originalFilename;
  document.getElementById('paintStatus')!.textContent = '';
  document.getElementById('paintHint')!.innerHTML = 'Red = will be regenerated. Drag to paint/erase. <kbd>X</kbd> toggles eraser.';
  paintView.style.display = 'flex';

  await loadImageEl(paintImg, baseImageUrl);
  paintEditor.resize(paintImg.naturalWidth, paintImg.naturalHeight);
  try {
    const select = parseSelect((document.getElementById('sel_' + row.id) as HTMLSelectElement).value);
    const faces = await detectFaces(paintImg);
    const faceBox = selectFace(faces, paintImg.naturalWidth, select);
    const maskCanvas = await computeAutoMaskCanvasForFace(paintImg, faceBox);
    await paintEditor.loadMask(maskCanvas.toDataURL('image/png'));
  } catch (e) {
    alert((e as Error).message || String(e));
  }
  fitPaintZoom();
}

function openReferencePaint(): void {
  paintMode = 'reference';
  document.getElementById('paintTitle')!.textContent = 'Character reference mask';
  document.getElementById('paintStatus')!.textContent = '';
  document.getElementById('paintHint')!.innerHTML =
    'Red = the character to extract (leave unpainted to use the whole photo). Drag to paint/erase. <kbd>X</kbd> toggles eraser.';
  paintView.style.display = 'flex';
  loadPaintCanvas(refThumb.src, refHasMask ? refMaskUrl : null);
}

document.getElementById('paintBack')!.addEventListener('click', () => {
  paintView.style.display = 'none';
});
document.getElementById('clear')!.addEventListener('click', () => {
  paintEditor.resize(paintImg.naturalWidth, paintImg.naturalHeight);
});
window.addEventListener('keydown', (e) => {
  if (paintView.style.display !== 'flex') return;
  if (e.repeat) return;
  if (e.key === 'x' || e.key === 'X') setPaintTool(paintTool === 'erase' ? 'paint' : 'erase');
});

document.getElementById('paintSave')!.addEventListener('click', async () => {
  const dataUrl = paintEditor.exportDataUrl();
  const blob = await (await fetch(dataUrl)).blob();
  const statusEl = document.getElementById('paintStatus')!;
  statusEl.textContent = 'Saving...';

  try {
    if (paintMode === 'reference') {
      const signed = await actionPost('sign-upload', { target: 'reference-mask', contentType: 'image/png' });
      const { error } = await supabase.storage.from(signed.bucket).uploadToSignedUrl(signed.path, signed.signToken, blob);
      if (error) throw error;
      await actionPost('save-reference-mask');
      statusEl.textContent = 'Saved.';
      await refreshReference();
    } else {
      const signed = await actionPost('sign-upload', { target: 'mask', photoId: paintRow!.id, contentType: 'image/png' });
      const { error } = await supabase.storage.from(signed.bucket).uploadToSignedUrl(signed.path, signed.signToken, blob);
      if (error) throw error;
      await actionPost('save-mask', { photoId: paintRow!.id, path: signed.path });
      statusEl.textContent = 'Saved.';
      refreshState();
    }
    paintView.style.display = 'none';
  } catch (e) {
    statusEl.textContent = (e as Error).message || 'Save failed.';
  }
});

// ---------------------------------------------------------------------------
// Interactive crop view -- drag/resize a square over the original.
// ---------------------------------------------------------------------------

const cropView = document.getElementById('cropView')!;
const cropImg = document.getElementById('cropImg') as HTMLImageElement;
const cropStage = document.getElementById('cropStage')!;
const cropBox = document.getElementById('cropBox')!;
let cropRow: PipelineRow | null = null;
let cropScale = 1;
let cropNatW = 0;
let cropNatH = 0;

function setCropBox(left: number, top: number, size: number): void {
  cropBox.style.left = `${left}px`;
  cropBox.style.top = `${top}px`;
  cropBox.style.width = `${size}px`;
  cropBox.style.height = `${size}px`;
}
function clampCropBox(left: number, top: number, size: number) {
  const maxSize = Math.min(cropNatW, cropNatH) * cropScale;
  size = Math.max(20, Math.min(size, maxSize));
  left = Math.max(0, Math.min(left, cropNatW * cropScale - size));
  top = Math.max(0, Math.min(top, cropNatH * cropScale - size));
  return { left, top, size };
}

async function openCrop(row: PipelineRow): Promise<void> {
  cropRow = row;
  document.getElementById('cropTitle')!.textContent = row.originalFilename;
  document.getElementById('cropStatus')!.textContent = '';
  cropView.style.display = 'flex';

  const select = parseSelect((document.getElementById('sel_' + row.id) as HTMLSelectElement)?.value || 'largest');
  const headBias = parseFloat((document.getElementById('bias_' + row.id) as HTMLInputElement)?.value || '0.15');

  await loadImageEl(cropImg, row.originalUrl);
  cropNatW = cropImg.naturalWidth;
  cropNatH = cropImg.naturalHeight;
  const wrap = document.getElementById('cropCanvasWrap')!;
  const availW = wrap.clientWidth - 60;
  const availH = wrap.clientHeight - 60;
  cropScale = Math.min(availW / cropNatW, availH / cropNatH, 1);
  const dispW = cropNatW * cropScale;
  const dispH = cropNatH * cropScale;
  cropImg.style.width = `${dispW}px`;
  cropImg.style.height = `${dispH}px`;
  cropStage.style.width = `${dispW}px`;
  cropStage.style.height = `${dispH}px`;

  const box = await suggestCropBoxFor(cropImg, select, headBias);
  setCropBox(box.left * cropScale, box.top * cropScale, box.side * cropScale);
}
document.getElementById('cropBack')!.addEventListener('click', () => {
  cropView.style.display = 'none';
});

let cropDragMode: 'move' | 'resize' | null = null;
let cropDragStartX = 0;
let cropDragStartY = 0;
let cropStartLeft = 0;
let cropStartTop = 0;
let cropStartSize = 0;

cropBox.addEventListener('pointerdown', (e) => {
  cropDragMode = (e.target as HTMLElement).classList.contains('handle') ? 'resize' : 'move';
  cropDragStartX = e.clientX;
  cropDragStartY = e.clientY;
  cropStartLeft = parseFloat(cropBox.style.left);
  cropStartTop = parseFloat(cropBox.style.top);
  cropStartSize = parseFloat(cropBox.style.width);
  e.stopPropagation();
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => {
  if (!cropDragMode) return;
  const dx = e.clientX - cropDragStartX;
  const dy = e.clientY - cropDragStartY;
  if (cropDragMode === 'move') {
    const { left, top, size } = clampCropBox(cropStartLeft + dx, cropStartTop + dy, cropStartSize);
    setCropBox(left, top, size);
  } else {
    const delta = Math.max(dx, dy);
    const { left, top, size } = clampCropBox(cropStartLeft, cropStartTop, cropStartSize + delta);
    setCropBox(left, top, size);
  }
});
window.addEventListener('pointerup', () => {
  cropDragMode = null;
});

document.getElementById('cropConfirm')!.addEventListener('click', async () => {
  const status = document.getElementById('cropStatus')!;
  status.textContent = 'Saving...';
  const left = Math.round(parseFloat(cropBox.style.left) / cropScale);
  const top = Math.round(parseFloat(cropBox.style.top) / cropScale);
  const side = Math.round(parseFloat(cropBox.style.width) / cropScale);
  try {
    await actionPost('run-crop', { photoId: cropRow!.id, left, top, side });
    status.textContent = 'Saved.';
    refreshState();
    cropView.style.display = 'none';
  } catch (e) {
    status.textContent = (e as Error).message || 'Crop failed.';
  }
});

// ---------------------------------------------------------------------------
// Upload (file picker + paste) -- sign -> direct PUT -> confirm
// ---------------------------------------------------------------------------

async function uploadFile(file: File | null): Promise<void> {
  if (!currentProjectId || !file) return;
  const status = document.getElementById('uploadStatus')!;
  status.textContent = `Uploading ${file.name}...`;
  try {
    const signed = await actionPost('sign-upload', { target: 'photo', projectId: currentProjectId, contentType: file.type });
    const { error } = await supabase.storage.from(signed.bucket).uploadToSignedUrl(signed.path, signed.signToken, file);
    if (error) throw error;
    const confirmed = await actionPost('confirm-upload', { projectId: currentProjectId, photoId: signed.photoId, filename: file.name, path: signed.path });
    status.textContent = `Added ${confirmed.filename}.`;
    refreshState();
  } catch (e) {
    status.textContent = (e as Error).message || 'Upload failed.';
  }
}

document.getElementById('uploadBtn')!.addEventListener('click', () => (document.getElementById('fileInput') as HTMLInputElement).click());
(document.getElementById('fileInput') as HTMLInputElement).addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  for (const file of Array.from(input.files || [])) await uploadFile(file);
  input.value = '';
});

window.addEventListener('paste', (e) => {
  if (paintView.style.display === 'flex' || cropView.style.display === 'flex') return;
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find((i) => i.type.startsWith('image/'));
  if (!imageItem) return;
  uploadFile(imageItem.getAsFile());
});

refreshProjects();
