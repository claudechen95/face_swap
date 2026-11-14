/**
 * Shared mask-canvas editor -- one instance per <canvas>, used for every
 * paint/erase mask surface in both apps (face/'s face mask, target mask,
 * and reference-mask canvases; face_swap/'s per-photo mask and reference
 * mask canvases). Mask strength (0-255, stored in the alpha channel) lives
 * in an off-screen "coverage" layer, completely separate from what's drawn
 * on the visible canvas -- painting and the auto-mask import both write
 * into that layer at full opacity; the visible canvas is just a translucent
 * read-only *view* of it, re-rendered after every edit. Painting translucent
 * dabs straight onto the visible canvas would otherwise compound via alpha
 * blending along a stroke until that area looked solid opaque, unlike the
 * cleanly imported auto-mask. Browser-only (uses document/Image/canvas).
 */

import { computeAutoMaskCanvasForFace, type FaceBoxPx } from './automask.js';

// Drawn overlay uses translucent red at up to this alpha for display only --
// the coverage layer itself is always full-opacity.
const MASK_OVERLAY_ALPHA_MAX = 128;

export type MaskTool = 'paint' | 'erase';

export interface MaskCanvasEditorOptions {
  getBrushSize: () => number;
  getTool: () => MaskTool;
}

export interface MaskCanvasEditor {
  resize(width: number, height: number): void;
  loadMask(maskUrl: string): Promise<void>;
  loadAutoMaskForFace(photoImgEl: HTMLImageElement, faceBox: FaceBoxPx): Promise<void>;
  exportDataUrl(): string;
  setEnabled(enabled: boolean): void;
}

function loadImageEl(imgEl: HTMLImageElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    imgEl.onload = () => resolve();
    imgEl.onerror = reject;
    imgEl.src = src;
  });
}

export function createMaskCanvasEditor(
  canvas: HTMLCanvasElement,
  { getBrushSize, getTool }: MaskCanvasEditorOptions
): MaskCanvasEditor {
  const ctx = canvas.getContext('2d')!;
  const coverage = document.createElement('canvas');
  const coverageCtx = coverage.getContext('2d', { willReadFrequently: true })!;
  let isDrawing = false;

  // Shows the actual brush footprint while painting -- a static CSS cursor
  // alone gives no sense of how big a dab the current brush size will
  // leave. mix-blend-mode:difference keeps the dashed ring visible against
  // the painted red overlay and the photo underneath it, light or dark.
  const wrap = canvas.parentElement!;
  const cursorEl = document.createElement('div');
  cursorEl.className = 'mask-brush-cursor';
  wrap.appendChild(cursorEl);

  function updateCursor(e: PointerEvent) {
    const wrapRect = wrap.getBoundingClientRect();
    const size = getBrushSize() * 2;
    cursorEl.style.left = `${e.clientX - wrapRect.left}px`;
    cursorEl.style.top = `${e.clientY - wrapRect.top}px`;
    cursorEl.style.width = `${size}px`;
    cursorEl.style.height = `${size}px`;
  }

  function pointFromEvent(e: PointerEvent) {
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

  // Reads back and re-renders only the given rect when provided -- a full
  // getImageData/putImageData pass over the whole coverage canvas on every
  // single pointermove was the actual cause of paint/erase lag on a
  // real-resolution photo (often 3000px+ per side, so millions of pixels
  // touched per frame for a change that only ever affects one small brush
  // dab). Bounding the work to the dab's own area makes each frame's cost
  // proportional to brush size instead of image size.
  function renderCoverageToDisplay(rect?: { x: number; y: number; w: number; h: number }): void {
    const x = rect ? Math.max(0, Math.floor(rect.x)) : 0;
    const y = rect ? Math.max(0, Math.floor(rect.y)) : 0;
    const w = rect ? Math.min(coverage.width - x, Math.ceil(rect.w)) : coverage.width;
    const h = rect ? Math.min(coverage.height - y, Math.ceil(rect.h)) : coverage.height;
    if (w <= 0 || h <= 0) return;
    const source = coverageCtx.getImageData(x, y, w, h);
    const overlay = ctx.createImageData(w, h);
    for (let i = 0; i < source.data.length; i += 4) {
      overlay.data[i] = 255;
      overlay.data[i + 1] = 0;
      overlay.data[i + 2] = 0;
      overlay.data[i + 3] = Math.round((source.data[i + 3]! / 255) * MASK_OVERLAY_ALPHA_MAX);
    }
    ctx.putImageData(overlay, x, y);
  }

  function paintAndRender(e: PointerEvent) {
    coverageCtx.globalCompositeOperation = getTool() === 'erase' ? 'destination-out' : 'source-over';
    coverageCtx.fillStyle = 'rgba(255,0,0,1)';
    coverageCtx.beginPath();
    const p = pointFromEvent(e);
    const r = getBrushSize() * scale();
    coverageCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
    coverageCtx.fill();
    const pad = 2; // anti-aliased dab edge extends slightly past the nominal radius
    renderCoverageToDisplay({ x: p.x - r - pad, y: p.y - r - pad, w: 2 * (r + pad), h: 2 * (r + pad) });
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

  // Shared by loadMask (a fetched PNG) and loadAutoMaskForFace (a freshly
  // computed MediaPipe segmentation canvas) -- both produce a white(=regenerate)-
  // on-black source image, decoded here into the coverage layer's alpha channel
  // at full strength (0-255 data, not display alpha), then rendered as the
  // translucent red overlay.
  function applyMaskSource(source: CanvasImageSource) {
    const off = document.createElement('canvas');
    off.width = coverage.width;
    off.height = coverage.height;
    const offCtx = off.getContext('2d')!;
    offCtx.drawImage(source, 0, 0, off.width, off.height);
    const sourceData = offCtx.getImageData(0, 0, off.width, off.height);
    const data = coverageCtx.createImageData(off.width, off.height);
    for (let i = 0; i < sourceData.data.length; i += 4) {
      data.data[i] = 255;
      data.data[i + 1] = 0;
      data.data[i + 2] = 0;
      data.data[i + 3] = sourceData.data[i]!;
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
    // in this editor, isolated to the selected face's connected component,
    // and loads it the same way loadMask would.
    async loadAutoMaskForFace(photoImgEl, faceBox) {
      const maskCanvas = await computeAutoMaskCanvasForFace(photoImgEl, faceBox);
      applyMaskSource(maskCanvas);
    },
    // Reads from the coverage layer (the real 0-255 mask data), not the
    // visible display canvas, so export is unaffected by display-only alpha.
    exportDataUrl() {
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = coverage.width;
      exportCanvas.height = coverage.height;
      const exportCtx = exportCanvas.getContext('2d')!;
      const data = coverageCtx.getImageData(0, 0, coverage.width, coverage.height);
      const exported = exportCtx.createImageData(coverage.width, coverage.height);
      for (let i = 0; i < data.data.length; i += 4) {
        const v = data.data[i + 3]!;
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
