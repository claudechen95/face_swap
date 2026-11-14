/**
 * Message protocol between the main thread (mediapipeClient.ts) and the
 * MediaPipe worker (mediapipeWorker.ts) -- kept in its own file so both
 * sides can import just the types without pulling in the other's runtime
 * code (the worker shouldn't bundle the client, and vice versa).
 */
import type { FaceBox } from './types.js';

export interface DetectFacesRequest {
  id: number;
  kind: 'detectFaces';
  bitmap: ImageBitmap;
}

export interface SegmentHairFaceRequest {
  id: number;
  kind: 'segmentHairFace';
  bitmap: ImageBitmap;
}

export type MediapipeWorkerRequest = DetectFacesRequest | SegmentHairFaceRequest;

export interface DetectFacesResponse {
  id: number;
  kind: 'detectFaces';
  ok: true;
  faces: FaceBox[];
}

export interface SegmentHairFaceResponse {
  id: number;
  kind: 'segmentHairFace';
  ok: true;
  width: number;
  height: number;
  binary: Uint8Array;
}

export interface MediapipeWorkerErrorResponse {
  id: number;
  ok: false;
  error: string;
}

export type MediapipeWorkerResponse = DetectFacesResponse | SegmentHairFaceResponse | MediapipeWorkerErrorResponse;
