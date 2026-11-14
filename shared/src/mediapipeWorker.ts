/**
 * Runs MediaPipe's FaceDetector/ImageSegmenter inference off the main
 * thread. Both of tasks-vision's detect()/segment() calls are synchronous
 * and otherwise freeze the whole tab -- clicks, scrolling, repaints,
 * everything, not just the triggering button -- for however long a single
 * call takes, which is far worse on the first call per model (the WASM
 * runtime + model weights are fetched and compiled lazily, able to take
 * multiple seconds on a cold cache). Moving those two calls here means only
 * this worker thread blocks; the page stays fully interactive throughout.
 *
 * No `document`/`window` here (worker global scope) -- an explicit
 * OffscreenCanvas is how VisionTaskOptions.canvas asks tasks-vision to
 * render via WebGL instead of creating its own <canvas>, which would throw.
 */
import { FaceDetector, ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision';
import type { FaceBox } from './types.js';
import type { MediapipeWorkerRequest, MediapipeWorkerResponse } from './mediapipeProtocol.js';

const MEDIAPIPE_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm';
const FACE_DETECTOR_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite';
const SELFIE_MULTICLASS_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
// 1 = hair, 3 = face-skin in this model's category set.
const HAIR_FACE_CATEGORY_INDICES = new Set([1, 3]);

let detectorPromise: Promise<FaceDetector> | null = null;
function getFaceDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
      return FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: FACE_DETECTOR_MODEL_URL },
        canvas: new OffscreenCanvas(1, 1),
        runningMode: 'IMAGE',
      });
    })();
  }
  return detectorPromise;
}

let segmenterPromise: Promise<ImageSegmenter> | null = null;
function getImageSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: SELFIE_MULTICLASS_MODEL_URL },
        canvas: new OffscreenCanvas(1, 1),
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })();
  }
  return segmenterPromise;
}

async function handleDetectFaces(bitmap: ImageBitmap): Promise<FaceBox[]> {
  const detector = await getFaceDetector();
  const result = detector.detect(bitmap);
  return result.detections.map((d) => {
    const box = d.boundingBox!;
    return { x1: box.originX, y1: box.originY, x2: box.originX + box.width, y2: box.originY + box.height };
  });
}

async function handleSegmentHairFace(bitmap: ImageBitmap): Promise<{ width: number; height: number; binary: Uint8Array }> {
  const segmenter = await getImageSegmenter();
  const result = segmenter.segment(bitmap);
  const categoryMask = result.categoryMask;
  if (!categoryMask) throw new Error('MediaPipe segmentation returned no category mask');
  const { width, height } = categoryMask;
  const categories = categoryMask.getAsUint8Array();
  const binary = new Uint8Array(width * height);
  for (let i = 0; i < categories.length; i++) {
    binary[i] = HAIR_FACE_CATEGORY_INDICES.has(categories[i]!) ? 1 : 0;
  }
  categoryMask.close();
  result.close();
  return { width, height, binary };
}

// Typed locally rather than via the `webworker` lib -- that lib's globals
// (self/postMessage/etc.) conflict with the `dom` lib already in use for
// every other file in this program (both can't be in the same tsconfig's
// `lib` array), and this file is only ever reached transitively, not
// through its own tsconfig.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<MediapipeWorkerRequest>) => void) | null;
  postMessage(message: MediapipeWorkerResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = async (event) => {
  const request = event.data;
  try {
    if (request.kind === 'detectFaces') {
      const faces = await handleDetectFaces(request.bitmap);
      ctx.postMessage({ id: request.id, kind: 'detectFaces', ok: true, faces });
    } else {
      const { width, height, binary } = await handleSegmentHairFace(request.bitmap);
      ctx.postMessage({ id: request.id, kind: 'segmentHairFace', ok: true, width, height, binary }, [binary.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ id: request.id, ok: false, error: (err as Error)?.message || String(err) });
  } finally {
    request.bitmap.close();
  }
};
