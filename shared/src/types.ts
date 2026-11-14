/**
 * Mask convention used across this codebase: white (255) = region to
 * regenerate/replace, black (0) = keep as-is. Opposite of Ideogram's own
 * API convention (black = selected region) -- see ideogram.ts's
 * invertForIdeogram for where that gets flipped.
 */
export const MASK_WHITE_MEANS_REGENERATE = true;

export interface FaceBox {
  /** 0-1 normalized, relative to image width/height, matching MediaPipe's own convention. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
