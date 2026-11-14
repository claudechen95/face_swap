/**
 * Client-side auto-mask -- runs MediaPipe's selfie_multiclass segmenter
 * entirely in the browser (WASM) to give a mask editor a pixel-accurate
 * hair+face starting point instead of a blank canvas. Same model and
 * category convention as face_swap/mediapipe_segment.py's retired Python
 * script (hair=1, face-skin=3) -- this is the TypeScript module that
 * replaced it, shared between face/'s upload flow and face_swap/'s local
 * tool so both call the exact same segmentation code. Browser-only (uses
 * document/Image/canvas).
 */

import { segmentHairFaceViaWorker } from './mediapipeClient.js';

function loadImageEl(imgEl: HTMLImageElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    imgEl.onload = () => resolve();
    imgEl.onerror = reject;
    imgEl.src = src;
  });
}

interface RawSegmentation {
  width: number;
  height: number;
  /** 1 where the pixel is hair/face-skin, 0 elsewhere. */
  binary: Uint8Array;
}

async function segmentHairFaceBinary(imgEl: HTMLImageElement): Promise<RawSegmentation> {
  // MediaPipe's segmenter reads the image via WebGL (texImage2D), which
  // throws a SecurityError on a cross-origin image unless it was loaded in
  // CORS mode -- the caller's display <img> elements usually aren't (plain
  // .src assignment), so reload the same URL through a throwaway
  // crossOrigin='anonymous' image first. The browser cache makes this a
  // no-op network-wise. createImageBitmap needs that same non-tainted source
  // to produce a bitmap the worker (see mediapipeClient.ts) can actually run
  // WebGL inference against.
  const corsImg = new Image();
  corsImg.crossOrigin = 'anonymous';
  await loadImageEl(corsImg, imgEl.src);
  const bitmap = await createImageBitmap(corsImg);

  return segmentHairFaceViaWorker(bitmap);
}

function binaryToCanvas(binary: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(width, height);
  for (let i = 0; i < binary.length; i++) {
    const v = binary[i] ? 255 : 0;
    imageData.data[i * 4] = v;
    imageData.data[i * 4 + 1] = v;
    imageData.data[i * 4 + 2] = v;
    imageData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function blurCanvas(source: HTMLCanvasElement, blurPx: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d')!;
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(source, 0, 0);
  return out;
}

// out[i] = max(arr[i-radius .. i+radius], clipped to the array bounds) in
// O(n) via a monotonic deque, independent of radius -- the standard sliding-
// window-maximum algorithm. Used below as the two passes of a separable 2D
// max filter, which is exact (not an approximation) for a square
// structuring element.
function slidingMax(arr: Uint8Array, radius: number): Uint8Array {
  const n = arr.length;
  const out = new Uint8Array(n);
  const deque: number[] = [];
  let front = 0;
  for (let right = 0; right < n + radius; right++) {
    if (right < n) {
      while (deque.length > front && arr[deque[deque.length - 1]!]! <= arr[right]!) deque.pop();
      deque.push(right);
    }
    const center = right - radius;
    while (deque.length > front && deque[front]! < center - radius) front++;
    if (center >= 0 && center < n) out[center] = deque.length > front ? arr[deque[front]!]! : 0;
  }
  return out;
}

// Dilates a binary (black/white) canvas outward by radiusPx via a true
// square-kernel morphological dilate (separable max filter, horizontal pass
// then vertical) -- exact and O(width*height) regardless of radius, unlike a
// blur-then-rethreshold approximation (which overshoots unpredictably past
// radiusPx and rounds the shape into a blob). OpenCV's reference
// implementation (the retired face_swap/face_fal.py this was ported from)
// uses a true elliptical-kernel dilate; a square kernel is the closest
// equivalent achievable without per-pixel circular distance checks, and the
// difference is minor once the feather pass below softens the corners.
function dilateCanvas(source: HTMLCanvasElement, radiusPx: number): HTMLCanvasElement {
  const { width, height } = source;
  const srcCtx = source.getContext('2d')!;
  const srcData = srcCtx.getImageData(0, 0, width, height).data;
  const radius = Math.round(radiusPx);

  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = srcData[i * 4]!;

  const afterRows = new Uint8Array(width * height);
  const row = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    row.set(gray.subarray(y * width, y * width + width));
    afterRows.set(slidingMax(row, radius), y * width);
  }

  const afterCols = new Uint8Array(width * height);
  const col = new Uint8Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) col[y] = afterRows[y * width + x]!;
    const filtered = slidingMax(col, radius);
    for (let y = 0; y < height; y++) afterCols[y * width + x] = filtered[y]!;
  }

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const outCtx = out.getContext('2d')!;
  const outData = outCtx.createImageData(width, height);
  for (let i = 0; i < afterCols.length; i++) {
    const v = afterCols[i]!;
    outData.data[i * 4] = v;
    outData.data[i * 4 + 1] = v;
    outData.data[i * 4 + 2] = v;
    outData.data[i * 4 + 3] = 255;
  }
  outCtx.putImageData(outData, 0, 0);
  return out;
}

// 8-connected (matches OpenCV's cv2.connectedComponents default) flood-fill
// labeling, iterative/stack-based to avoid recursion depth limits on large
// photos.
function labelConnectedComponents(binary: Uint8Array, width: number, height: number): Int32Array {
  const labels = new Int32Array(width * height);
  let nextLabel = 1;
  const stack: number[] = [];
  for (let start = 0; start < binary.length; start++) {
    if (binary[start] === 0 || labels[start] !== 0) continue;
    const label = nextLabel++;
    labels[start] = label;
    stack.push(start);
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % width;
      const y = (idx / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (binary[nIdx] === 1 && labels[nIdx] === 0) {
            labels[nIdx] = label;
            stack.push(nIdx);
          }
        }
      }
    }
  }
  return labels;
}

export interface FaceBoxPx {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Multi-person-aware auto-mask: segments the whole frame, then isolates just
 * the connected component belonging to the selected face (by
 * shared/faceDetector.ts's selectFace) via 8-connected labeling -- RetinaFace
 * picks the face in the retired Python version, this is the same algorithm
 * with MediaPipe's FaceDetector supplying faceBox instead. If the face
 * box's own centre lands on a gap in the segmentation (stray hair, glasses
 * glare), falls back to whichever label has the most overlap with the face
 * box, same as the Python version.
 *
 * pad_ratio dilates the isolated silhouette outward by that fraction of the
 * face box's height (via dilateCanvas's square-kernel morphological dilate,
 * the closest equivalent to the reference's elliptical-kernel cv2.dilate
 * achievable without per-pixel circular distance checks) so a reference
 * character with a different hairline/hair volume has room to render into.
 * feather_ratio then softens the edge the same way. Defaults match the
 * reference's own (face_swap/face_fal.py's build_head_hair_mask) exactly.
 */
export async function computeAutoMaskCanvasForFace(
  imgEl: HTMLImageElement,
  faceBox: FaceBoxPx,
  { padRatio = 0.12, featherRatio = 0.04 }: { padRatio?: number; featherRatio?: number } = {}
): Promise<HTMLCanvasElement> {
  const { width, height, binary } = await segmentHairFaceBinary(imgEl);
  const labels = labelConnectedComponents(binary, width, height);

  const fx = Math.min(width - 1, Math.max(0, Math.round((faceBox.x1 + faceBox.x2) / 2)));
  const fy = Math.min(height - 1, Math.max(0, Math.round((faceBox.y1 + faceBox.y2) / 2)));
  let targetLabel = labels[fy * width + fx]!;

  if (targetLabel === 0) {
    const counts = new Map<number, number>();
    const x1 = Math.max(0, Math.floor(faceBox.x1));
    const x2 = Math.min(width, Math.ceil(faceBox.x2));
    const y1 = Math.max(0, Math.floor(faceBox.y1));
    const y2 = Math.min(height, Math.ceil(faceBox.y2));
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const label = labels[y * width + x]!;
        if (label !== 0) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    let bestCount = 0;
    for (const [label, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        targetLabel = label;
      }
    }
  }
  if (targetLabel === 0) {
    throw new Error('No hair/face segmentation found near the selected face');
  }

  const isolated = new Uint8Array(width * height);
  for (let i = 0; i < labels.length; i++) {
    isolated[i] = labels[i] === targetLabel ? 1 : 0;
  }

  const faceHeight = faceBox.y2 - faceBox.y1;
  const padPx = Math.round(padRatio * faceHeight);
  const featherPx = featherRatio * faceHeight;

  let canvas = binaryToCanvas(isolated, width, height);
  if (padPx > 0) canvas = dilateCanvas(canvas, padPx);
  return featherPx > 0 ? blurCanvas(canvas, featherPx) : canvas;
}
