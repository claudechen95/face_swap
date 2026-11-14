/**
 * The admin pipeline's async run-job state machine. Every Ideogram/Topaz
 * step the old local tool did by blocking in a sleep-poll loop (see
 * face_swap/server/app.ts's /run/upscale, /run/ideogram) instead advances
 * by exactly one non-blocking step per call here -- startUpscaleJob/
 * startIdeogramJob do the one fast "submit" HTTP call and return
 * immediately; advanceJob does one status check (and, when a step just
 * finished, the next cheap step: downloading a result and submitting the
 * next one) and returns. The browser drives the wait by calling
 * api/admin-pipeline-run.ts's poll-job action every few seconds until the
 * job reaches a terminal status. No function invocation here ever blocks
 * for more than one real network round trip.
 */

import crypto from 'node:crypto';
import sharp from 'sharp';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildPrompt, downloadIdeogramResult, submitIdeogramSwap, checkIdeogramGeneration } from 'shared/server';
import { checkTopazStatus, downloadBuffer, fetchTopazResultUrl, MAX_TOPAZ_SCALE, submitTopazUpscale } from './falClient.js';
import { compositeMaskedRegion } from './compositing.js';
import { applyCleanIphoneMetadata, randomDeliveredFilename } from './exifSpoof.js';
import { CHARACTER_REFERENCE_MASK_PATH, CHARACTER_REFERENCE_PATH } from './pipelineReference.js';
import { ADMIN_PIPELINE_BUCKET, MIN_SWAP_SIDE } from './constants.js';

export interface PipelinePhotoRow {
  id: string;
  project_id: string;
  original_storage_path: string;
  crop_storage_path: string | null;
  upscale_storage_path: string | null;
  mask_storage_path: string | null;
}

export interface PipelineJobRow {
  id: string;
  photo_id: string;
  kind: 'upscale' | 'ideogram';
  status: string;
  external_ref: Record<string, unknown> | null;
  params: Record<string, unknown> | null;
  result_id: string | null;
  error: string | null;
}

async function downloadStoragePath(supabase: SupabaseClient, path: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(ADMIN_PIPELINE_BUCKET).download(path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

async function updateJob(supabase: SupabaseClient, id: string, patch: Partial<PipelineJobRow>): Promise<PipelineJobRow> {
  const { data, error } = await supabase
    .from('pipeline_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as PipelineJobRow;
}

async function failJob(supabase: SupabaseClient, id: string, message: string): Promise<PipelineJobRow> {
  return updateJob(supabase, id, { status: 'failed', error: message });
}

// ---------------------------------------------------------------------------
// Upscale
// ---------------------------------------------------------------------------

export async function startUpscaleJob(supabase: SupabaseClient, photo: PipelinePhotoRow, target: number): Promise<PipelineJobRow> {
  if (!photo.crop_storage_path) throw new Error('run crop first');
  const cropBytes = await downloadStoragePath(supabase, photo.crop_storage_path);
  const { width } = await sharp(cropBytes).metadata();
  if (!width) throw new Error('could not read crop dimensions');

  const remaining = target / width;
  if (remaining <= 1 + 1e-6) throw new Error(`crop is already ${width}px, at or above the ${target}px target`);

  const step = Math.min(remaining, MAX_TOPAZ_SCALE);
  const { statusUrl, responseUrl } = await submitTopazUpscale(cropBytes, 'image/jpeg', step, true);

  const { data, error } = await supabase
    .from('pipeline_jobs')
    .insert({
      photo_id: photo.id,
      kind: 'upscale',
      status: 'submitted',
      params: { target },
      external_ref: { statusUrl, responseUrl, remainingAfterThisStep: remaining / step },
    })
    .select()
    .single();
  if (error) throw error;
  return data as PipelineJobRow;
}

async function advanceUpscaleJob(supabase: SupabaseClient, job: PipelineJobRow, photo: PipelinePhotoRow): Promise<PipelineJobRow> {
  const { statusUrl, responseUrl, remainingAfterThisStep } = job.external_ref as {
    statusUrl: string;
    responseUrl: string;
    remainingAfterThisStep: number;
  };
  const status = await checkTopazStatus(statusUrl);
  if (status !== 'COMPLETED') return job;

  const resultUrl = await fetchTopazResultUrl(responseUrl);
  const { buffer, mimeType } = await downloadBuffer(resultUrl);

  if (remainingAfterThisStep > 1 + 1e-6) {
    const nextStep = Math.min(remainingAfterThisStep, MAX_TOPAZ_SCALE);
    const next = await submitTopazUpscale(buffer, mimeType, nextStep, true);
    return updateJob(supabase, job.id, {
      external_ref: { statusUrl: next.statusUrl, responseUrl: next.responseUrl, remainingAfterThisStep: remainingAfterThisStep / nextStep },
    });
  }

  // Final step -- resize to the exact target (Topaz's own rounding can
  // leave it a handful of pixels off) and save.
  const target = (job.params as { target: number }).target;
  const finalBytes = await sharp(buffer).resize(target, target, { kernel: 'lanczos3' }).jpeg({ quality: 95 }).toBuffer();
  const upscalePath = `${photo.project_id}/${photo.id}/upscale.jpg`;
  const { error: uploadError } = await supabase.storage.from(ADMIN_PIPELINE_BUCKET).upload(upscalePath, finalBytes, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (uploadError) throw uploadError;

  // Crop and upscale share the same square framing -- if a mask was
  // already painted at a different resolution than this target, rescale it
  // in place instead of discarding the user's work.
  if (photo.mask_storage_path) {
    const maskBytes = await downloadStoragePath(supabase, photo.mask_storage_path);
    const maskMeta = await sharp(maskBytes).metadata();
    if (maskMeta.width !== target || maskMeta.height !== target) {
      const resizedMask = await sharp(maskBytes).resize(target, target, { kernel: 'nearest' }).png().toBuffer();
      await supabase.storage.from(ADMIN_PIPELINE_BUCKET).upload(photo.mask_storage_path, resizedMask, { contentType: 'image/png', upsert: true });
    }
  }

  await supabase.from('pipeline_photos').update({ upscale_storage_path: upscalePath, upscale_target: target, updated_at: new Date().toISOString() }).eq('id', photo.id);

  return updateJob(supabase, job.id, { status: 'completed' });
}

// ---------------------------------------------------------------------------
// Ideogram
// ---------------------------------------------------------------------------

// Picks the best available base image for the swap -- prefer upscale > crop
// > original, same priority as the paint view's own fallback. Whichever is
// picked must be at least MIN_SWAP_SIDE on each side, or this throws (same
// as the local tool's resolveBaseImage: it checks the *first* candidate
// that exists, not the first one big enough).
async function resolveBaseImage(supabase: SupabaseClient, photo: PipelinePhotoRow): Promise<{ path: string; buffer: Buffer }> {
  const candidates: [string | null, string][] = [
    [photo.upscale_storage_path, 'upscale'],
    [photo.crop_storage_path, 'crop'],
    [photo.original_storage_path, 'original'],
  ];
  for (const [path, kind] of candidates) {
    if (!path) continue;
    const buffer = await downloadStoragePath(supabase, path);
    const { width, height } = await sharp(buffer).metadata();
    if (!width || !height || width < MIN_SWAP_SIDE || height < MIN_SWAP_SIDE) {
      throw new Error(`the ${kind} image is only ${width}x${height} -- need at least ${MIN_SWAP_SIDE}x${MIN_SWAP_SIDE}`);
    }
    return { path, buffer };
  }
  throw new Error('no image found for this photo');
}

export async function startIdeogramJob(supabase: SupabaseClient, photo: PipelinePhotoRow, expression: string | null): Promise<PipelineJobRow> {
  if (!photo.mask_storage_path) throw new Error('need a saved mask first');
  const base = await resolveBaseImage(supabase, photo);
  const maskBuffer = await downloadStoragePath(supabase, photo.mask_storage_path);

  const { data: refList } = await supabase.storage.from(ADMIN_PIPELINE_BUCKET).list('_reference');
  if (!refList?.some((f) => f.name === 'character_reference.jpg')) {
    throw new Error("no reference photo set -- use 'Upload reference' first");
  }
  const referenceBuffer = await downloadStoragePath(supabase, CHARACTER_REFERENCE_PATH);
  const hasReferenceMask = refList.some((f) => f.name === 'character_reference_mask.png');
  const referenceMaskBuffer = hasReferenceMask ? await downloadStoragePath(supabase, CHARACTER_REFERENCE_MASK_PATH) : null;

  const prompt = buildPrompt(expression || undefined);
  const { generationId } = await submitIdeogramSwap({
    targetBuffer: base.buffer,
    maskBuffer,
    referenceBuffer,
    referenceMaskBuffer,
    prompt,
    numImages: 1,
  });

  const { data, error } = await supabase
    .from('pipeline_jobs')
    .insert({
      photo_id: photo.id,
      kind: 'ideogram',
      status: 'ideogram_submitted',
      params: { expression, prompt },
      external_ref: { generationId, basePath: base.path, maskPath: photo.mask_storage_path },
    })
    .select()
    .single();
  if (error) throw error;
  return data as PipelineJobRow;
}

async function advanceIdeogramSubmitted(supabase: SupabaseClient, job: PipelineJobRow): Promise<PipelineJobRow> {
  const { generationId, basePath, maskPath } = job.external_ref as { generationId: string; basePath: string; maskPath: string };
  const status = await checkIdeogramGeneration(generationId);
  if (status.status === 'pending') return job;
  if (status.status === 'failed') return failJob(supabase, job.id, `Ideogram generation failed: ${status.error}`);

  const generatedBytes = await downloadIdeogramResult(status.urls![0]!);
  const { statusUrl, responseUrl } = await submitTopazUpscale(generatedBytes, 'image/png', 4.0, true);
  return updateJob(supabase, job.id, {
    status: 'topaz_submitted',
    external_ref: { statusUrl, responseUrl, basePath, maskPath },
  });
}

async function advanceTopazSubmitted(supabase: SupabaseClient, job: PipelineJobRow, photo: PipelinePhotoRow): Promise<PipelineJobRow> {
  const { statusUrl, responseUrl, basePath, maskPath } = job.external_ref as {
    statusUrl: string;
    responseUrl: string;
    basePath: string;
    maskPath: string;
  };
  const status = await checkTopazStatus(statusUrl);
  if (status !== 'COMPLETED') return job;

  const resultUrl = await fetchTopazResultUrl(responseUrl);
  const { buffer: upscaledBytes } = await downloadBuffer(resultUrl);
  const [baseBuffer, maskBuffer] = await Promise.all([downloadStoragePath(supabase, basePath), downloadStoragePath(supabase, maskPath)]);

  const composited = await compositeMaskedRegion(baseBuffer, upscaledBytes, maskBuffer);
  const { width, height } = await sharp(composited).metadata();
  const spoofed = await applyCleanIphoneMetadata(composited, width ?? 0, height ?? 0);

  const resultId = crypto.randomUUID();
  const deliveredFilename = randomDeliveredFilename();
  const resultPath = `${photo.project_id}/${photo.id}/results/${resultId}.jpg`;
  const { error: uploadError } = await supabase.storage.from(ADMIN_PIPELINE_BUCKET).upload(resultPath, spoofed, { contentType: 'image/jpeg', upsert: true });
  if (uploadError) throw uploadError;

  const params = job.params as { expression: string | null; prompt: string };
  const { error: insertError } = await supabase.from('pipeline_results').insert({
    id: resultId,
    photo_id: photo.id,
    storage_path: resultPath,
    delivered_filename: deliveredFilename,
    prompt: params.prompt,
    expression: params.expression,
  });
  if (insertError) throw insertError;

  return updateJob(supabase, job.id, { status: 'completed', result_id: resultId });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

// Reads the job, does at most one non-blocking advance step if it's not
// already terminal, and returns the (possibly updated) row.
export async function advanceJob(supabase: SupabaseClient, job: PipelineJobRow, photo: PipelinePhotoRow): Promise<PipelineJobRow> {
  if (TERMINAL_STATUSES.has(job.status)) return job;

  try {
    if (job.kind === 'upscale') return await advanceUpscaleJob(supabase, job, photo);
    if (job.status === 'ideogram_submitted') return await advanceIdeogramSubmitted(supabase, job);
    if (job.status === 'topaz_submitted') return await advanceTopazSubmitted(supabase, job, photo);
    return job;
  } catch (err) {
    return failJob(supabase, job.id, (err as Error).message);
  }
}
