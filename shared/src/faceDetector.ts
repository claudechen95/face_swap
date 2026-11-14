/**
 * Face bounding-box detection + selection, used for crop-centering and for
 * picking which person's blob to isolate when masking a multi-person photo.
 * Replaces face_swap/face_fal.py's RetinaFace-based _detect_faces/select_face
 * with MediaPipe's FaceDetector task -- same @mediapipe/tasks-vision package
 * already needed for segmentation (automask.ts), no cloud dependency.
 * Browser-only (uses document/Image/canvas).
 */

import type { FaceBox } from './types.js';
import { detectFacesViaWorker } from './mediapipeClient.js';

function loadImageEl(imgEl: HTMLImageElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    imgEl.onload = () => resolve();
    imgEl.onerror = reject;
    imgEl.src = src;
  });
}

/** Detects every face in an already-loaded <img>. Pixel coordinates, not normalized. */
export async function detectFaces(imgEl: HTMLImageElement): Promise<FaceBox[]> {
  // MediaPipe's detector reads the image via WebGL (texImage2D), which throws
  // a SecurityError on a cross-origin image unless it was loaded in CORS mode
  // -- the caller's display <img> elements usually aren't (plain .src
  // assignment), so reload the same URL through a throwaway
  // crossOrigin='anonymous' image first, same trick automask.ts's segmenter
  // uses. The browser cache makes this a no-op network-wise. createImageBitmap
  // needs that same non-tainted source to produce a bitmap the worker (see
  // mediapipeClient.ts) can actually run WebGL inference against.
  const corsImg = new Image();
  corsImg.crossOrigin = 'anonymous';
  await loadImageEl(corsImg, imgEl.src);
  const bitmap = await createImageBitmap(corsImg);

  const faces = await detectFacesViaWorker(bitmap);
  if (!faces.length) {
    throw new Error('No face detected in this photo');
  }
  return faces;
}

// Faces smaller than this fraction of the largest face's area are treated as
// background bystanders (a stranger walking past behind the subject), not as
// people in the photo. Without this, "the person in the middle" can resolve
// to someone who happens to stand near the frame's centre line but is far
// further from the camera than the actual subjects.
const BYSTANDER_AREA_RATIO = 0.25;

function faceArea(f: FaceBox): number {
  return (f.x2 - f.x1) * (f.y2 - f.y1);
}

export type FaceSelector = 'largest' | 'center' | number;

/**
 * Pick which detected face to use.
 *
 * select="largest" -- biggest face box (the default).
 * select="center"  -- the person in the middle: the face whose box centre is
 *                      horizontally nearest the frame's centre line.
 * select=<number>  -- index into the faces ordered left-to-right, so 0 is
 *                      the leftmost person and -1 the rightmost (supports
 *                      negative indices like Python's).
 *
 * Background bystanders are dropped first, so indexes and "center" both
 * range over the actual subjects of the photo.
 */
export function selectFace(faces: FaceBox[], imageWidth: number, select: FaceSelector = 'largest'): FaceBox {
  const largestArea = Math.max(...faces.map(faceArea));
  const subjects = faces.filter((f) => faceArea(f) >= BYSTANDER_AREA_RATIO * largestArea);

  if (select === 'largest') {
    return subjects.reduce((best, f) => (faceArea(f) > faceArea(best) ? f : best));
  }

  const ordered = [...subjects].sort((a, b) => a.x1 + a.x2 - (b.x1 + b.x2));
  if (select === 'center') {
    const frameCx = imageWidth / 2;
    return ordered.reduce((best, f) =>
      Math.abs((f.x1 + f.x2) / 2 - frameCx) < Math.abs((best.x1 + best.x2) / 2 - frameCx) ? f : best
    );
  }
  if (typeof select === 'number') {
    const index = select < 0 ? ordered.length + select : select;
    const face = ordered[index];
    if (!face) throw new Error(`Face selector index ${select} out of range (${ordered.length} subjects)`);
    return face;
  }
  throw new Error(`Unknown face selector: ${String(select)}`);
}

export interface SquareCropBox {
  left: number;
  top: number;
  side: number;
  width: number;
  height: number;
}

/**
 * Computes (without cropping) the largest square that fits inside the
 * image, centred on the chosen face rather than the frame's geometric
 * centre -- so a portrait/landscape photo can go square without cutting the
 * subject's face off to one side.
 *
 * headBias shifts the box up from dead-centre-on-face by this fraction of
 * its side, as a fixed square centred exactly on the face tends to crowd
 * out hair and leave extra empty space below the chin (portrait convention
 * puts the face in the upper-middle third, not the centre). 0 = centred on
 * the face, positive = more headroom.
 *
 * The side is min(width, height) -- the most that can be taken without
 * needing to pad -- so a crop using this box only ever removes content,
 * never adds any.
 */
export function suggestSquareCropBox(
  imageWidth: number,
  imageHeight: number,
  faces: FaceBox[],
  select: FaceSelector = 'largest',
  headBias = 0.15
): SquareCropBox {
  const best = selectFace(faces, imageWidth, select);
  const faceCx = (best.x1 + best.x2) / 2;
  const faceCy = (best.y1 + best.y2) / 2;

  const side = Math.min(imageWidth, imageHeight);
  let left = faceCx - side / 2;
  let top = faceCy - side / 2 - headBias * side;
  left = Math.max(0, Math.min(left, imageWidth - side));
  top = Math.max(0, Math.min(top, imageHeight - side));
  return { left: Math.round(left), top: Math.round(top), side: Math.round(side), width: imageWidth, height: imageHeight };
}
