/**
 * fal.ai queue API client for the Topaz Wonder 3.5 upscale endpoint --
 * direct fetch calls, matching this codebase's no-SDK style (see
 * shared/src/ideogram.ts). Ported from face_swap/server/falClient.ts, but
 * split into non-blocking submit/check/fetch primitives instead of a
 * function that sleeps in a loop until done -- a Vercel function can't
 * block for the minutes a real upscale can take, so the wait is driven by
 * the browser polling api/admin-pipeline-run.ts's poll-job endpoint
 * instead, one quick status check per call. See api/_lib/pipelineJobs.ts
 * for the resumable multi-step chaining logic built on these primitives.
 */

const FAL_QUEUE_BASE = 'https://queue.fal.run/topaz/upscale/image/generative';

// fal's schema caps upscale_factor at 4 on this endpoint -- callers chain
// multiple submissions instead of raising when the needed multiplier
// exceeds this.
export const MAX_TOPAZ_SCALE = 4.0;

function falKey(): string {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error('Set the FAL_KEY environment variable before running this script.');
  return key;
}

function dataUriFor(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

export interface TopazSubmission {
  statusUrl: string;
  responseUrl: string;
}

export async function submitTopazUpscale(imageBytes: Buffer, mimeType: string, scale: number, face = true): Promise<TopazSubmission> {
  const key = falKey();
  const submitResponse = await fetch(FAL_QUEUE_BASE, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: dataUriFor(imageBytes, mimeType),
      model: 'Wonder 3.5',
      upscale_factor: scale,
      output_format: 'png',
      face_enhancement: face,
    }),
  });
  if (!submitResponse.ok) {
    throw new Error(`fal upscale submit failed: ${submitResponse.status} ${await submitResponse.text()}`);
  }
  const body = (await submitResponse.json()) as { status_url: string; response_url: string };
  return { statusUrl: body.status_url, responseUrl: body.response_url };
}

export type TopazStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';

// One non-blocking status check -- no sleep, no loop. Returns the raw
// status string; the caller decides what a non-COMPLETED status means.
export async function checkTopazStatus(statusUrl: string): Promise<TopazStatus> {
  const key = falKey();
  const response = await fetch(statusUrl, { headers: { Authorization: `Key ${key}` } });
  if (!response.ok) throw new Error(`fal upscale status failed: ${response.status} ${await response.text()}`);
  const { status } = (await response.json()) as { status: TopazStatus };
  return status;
}

interface FalUpscaleResult {
  image?: { url: string };
  images?: { url: string }[];
}

export async function fetchTopazResultUrl(responseUrl: string): Promise<string> {
  const key = falKey();
  const response = await fetch(responseUrl, { headers: { Authorization: `Key ${key}` } });
  if (!response.ok) throw new Error(`fal upscale result failed: ${response.status} ${await response.text()}`);
  const result = (await response.json()) as FalUpscaleResult;
  const url = result.image?.url ?? result.images?.[0]?.url;
  if (!url) throw new Error(`fal upscale result had no image url: ${JSON.stringify(result)}`);
  return url;
}

export async function downloadBuffer(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Could not download ${url}: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get('content-type') || 'image/png';
  return { buffer, mimeType };
}
