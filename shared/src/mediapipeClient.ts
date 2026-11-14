/**
 * Main-thread client for the MediaPipe worker (see mediapipeWorker.ts's doc
 * comment for why inference runs there instead of here). One worker per
 * page session, lazily created on first use; requests are correlated by an
 * incrementing id so concurrent in-flight calls (not expected given the UI
 * only ever reviews one mask at a time, but not assumed away) resolve to
 * the right caller.
 */
import type { FaceBox } from './types.js';
import type { MediapipeWorkerRequest, MediapipeWorkerResponse } from './mediapipeProtocol.js';

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (response: MediapipeWorkerResponse) => void; reject: (err: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    // Classic (not module) worker -- @mediapipe/tasks-vision's WASM loader
    // relies on importScripts() semantics internally and fails with
    // "ModuleFactory not set" under a module worker (importScripts doesn't
    // exist there). Vite still bundles this file's ESM imports fine for a
    // classic worker target -- it defaults to IIFE worker output.
    worker = new Worker(new URL('./mediapipeWorker.js', import.meta.url));
    worker.onmessage = (event: MessageEvent<MediapipeWorkerResponse>) => {
      const response = event.data;
      const entry = pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id);
      entry.resolve(response);
    };
    worker.onerror = (event) => {
      // A worker-level error (e.g. the script itself failing to load) has no
      // request id to key off of -- reject everything still outstanding
      // rather than leaving those callers hanging forever.
      const err = new Error(event.message || 'MediaPipe worker error');
      pending.forEach(({ reject }) => reject(err));
      pending.clear();
    };
  }
  return worker;
}

function call(request: Omit<MediapipeWorkerRequest, 'id'>): Promise<MediapipeWorkerResponse> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    const full = { ...request, id } as MediapipeWorkerRequest;
    getWorker().postMessage(full, [full.bitmap]);
  });
}

export async function detectFacesViaWorker(bitmap: ImageBitmap): Promise<FaceBox[]> {
  const response = await call({ kind: 'detectFaces', bitmap });
  if (!response.ok) throw new Error(response.error);
  if (response.kind !== 'detectFaces') throw new Error('Unexpected MediaPipe worker response');
  return response.faces;
}

export async function segmentHairFaceViaWorker(bitmap: ImageBitmap): Promise<{ width: number; height: number; binary: Uint8Array }> {
  const response = await call({ kind: 'segmentHairFace', bitmap });
  if (!response.ok) throw new Error(response.error);
  if (response.kind !== 'segmentHairFace') throw new Error('Unexpected MediaPipe worker response');
  return { width: response.width, height: response.height, binary: response.binary };
}
