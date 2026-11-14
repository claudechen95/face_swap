import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { requireAdminAuth } from './_lib/adminAuth.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { signGrouped } from './_lib/signStorage.js';
import { ADMIN_PIPELINE_BUCKET, ADMIN_PIPELINE_SIGN_TTL } from './_lib/constants.js';
import { CHARACTER_REFERENCE_MASK_PATH, CHARACTER_REFERENCE_PATH, characterReferenceStatus, clearReferenceMask } from './_lib/pipelineReference.js';
import { startUpscaleJob, startIdeogramJob, advanceJob, type PipelinePhotoRow, type PipelineJobRow } from './_lib/pipelineJobs.js';

/**
 * All admin-pipeline endpoints in one function, to stay under Vercel
 * Hobby's 12-serverless-function cap -- GET is read-only resources
 * (dispatched by `?resource=`, was admin-pipeline-data.ts), POST is every
 * mutation and async job step (dispatched by body `{action, ...}`, was
 * admin-pipeline-action.ts + admin-pipeline-run.ts). Replaces
 * face_swap/server/app.ts's /projects, /character-reference-status,
 * /character-reference, /character-reference-mask, /state, /upload,
 * /remove, /remove-result, /run/crop, /run/upscale, /run/ideogram,
 * /save-mask, /upload-character-reference, /save-reference-mask, plus the
 * project CRUD the CLI's --project flag used to handle. Every image
 * reference is a pre-signed Supabase Storage URL embedded directly in the
 * JSON response, so there's no equivalent of the old byte-proxy
 * /images/:name route. The slow, API-bound actions (upscale, Ideogram)
 * never block inside a single call -- they start a job and advance one
 * non-blocking step per poll-job call instead (see pipelineJobs.ts).
 */

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

type UploadTarget = 'photo' | 'mask' | 'reference' | 'reference-mask';

async function getPhoto(supabase: SupabaseClient, photoId: string) {
  const { data, error } = await supabase.from('pipeline_photos').select('*').eq('id', photoId).single();
  if (error || !data) throw new Error('photo not found');
  return data;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async function handleCreateProject(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const label = String(req.body?.label || '').trim();
  if (!label) return sendError(res, 400, 'Missing label');

  const { data, error } = await supabase.from('pipeline_projects').insert({ label }).select('id, label').single();
  if (error) {
    if (error.code === '23505') return sendError(res, 409, `A project named "${label}" already exists`);
    console.error('create-project failed', error);
    return sendError(res, 500, 'Could not create project');
  }
  return res.status(200).json(data);
}

async function handleDeleteProject(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const projectId = String(req.body?.projectId || '');
  if (!projectId) return sendError(res, 400, 'Missing projectId');

  // The DB rows (pipeline_photos/pipeline_jobs/pipeline_results) cascade on
  // delete, but Storage objects don't -- collect every path explicitly
  // from our own relational rows (simpler and more reliable than trying to
  // recursively walk the bucket's prefix with Storage's non-recursive
  // .list()) and remove them first.
  const { data: photos, error } = await supabase
    .from('pipeline_photos')
    .select('original_storage_path, crop_storage_path, upscale_storage_path, mask_storage_path, mask_preview_storage_path, pipeline_results(storage_path)')
    .eq('project_id', projectId);
  if (error) {
    console.error('delete-project photo lookup failed', error);
    return sendError(res, 500, 'Could not load project for deletion');
  }

  const paths: string[] = [];
  for (const photo of photos) {
    for (const p of [photo.original_storage_path, photo.crop_storage_path, photo.upscale_storage_path, photo.mask_storage_path, photo.mask_preview_storage_path]) {
      if (p) paths.push(p);
    }
    for (const result of photo.pipeline_results as { storage_path: string }[]) paths.push(result.storage_path);
  }
  if (paths.length) {
    const { error: removeError } = await supabase.storage.from(ADMIN_PIPELINE_BUCKET).remove(paths);
    if (removeError) {
      console.error('delete-project storage remove failed', removeError);
      return sendError(res, 502, 'Could not remove project files');
    }
  }

  const { error: deleteError } = await supabase.from('pipeline_projects').delete().eq('id', projectId);
  if (deleteError) {
    console.error('delete-project row delete failed', deleteError);
    return sendError(res, 502, 'Could not delete project');
  }
  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Upload (sign -> direct PUT -> confirm, same pattern as face/src/upload.ts)
// ---------------------------------------------------------------------------

async function handleSignUpload(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { target, projectId, photoId: existingPhotoId, contentType } = req.body || {};
  const ext = EXT_BY_MIME[contentType];
  if (!ext) return sendError(res, 400, 'Unsupported file type');

  let path: string;
  let photoId: string | undefined;
  if (target === ('photo' satisfies UploadTarget)) {
    if (!projectId) return sendError(res, 400, 'Missing projectId');
    photoId = crypto.randomUUID();
    path = `${projectId}/${photoId}/original.${ext}`;
  } else if (target === ('mask' satisfies UploadTarget)) {
    if (!existingPhotoId) return sendError(res, 400, 'Missing photoId');
    const photo = await getPhoto(supabase, existingPhotoId).catch(() => null);
    if (!photo) return sendError(res, 404, 'Photo not found');
    path = `${photo.project_id}/${photo.id}/mask.png`;
  } else if (target === ('reference' satisfies UploadTarget)) {
    path = CHARACTER_REFERENCE_PATH;
  } else if (target === ('reference-mask' satisfies UploadTarget)) {
    path = CHARACTER_REFERENCE_MASK_PATH;
  } else {
    return sendError(res, 400, 'Unknown upload target');
  }

  const { data: signed, error } = await supabase.storage.from(ADMIN_PIPELINE_BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error) {
    console.error('createSignedUploadUrl failed', error);
    return sendError(res, 502, 'Could not prepare upload');
  }
  return res.status(200).json({ bucket: ADMIN_PIPELINE_BUCKET, path: signed.path, signToken: signed.token, photoId });
}

async function handleConfirmUpload(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { projectId, photoId, filename, path } = req.body || {};
  if (!projectId || !photoId || !path) return sendError(res, 400, 'Missing projectId, photoId, or path');

  const { data: existing } = await supabase.from('pipeline_photos').select('original_filename').eq('project_id', projectId);
  const taken = new Set((existing ?? []).map((r) => r.original_filename));
  let displayName = String(filename || 'upload.png');
  if (taken.has(displayName)) {
    const dot = displayName.lastIndexOf('.');
    const stem = dot === -1 ? displayName : displayName.slice(0, dot);
    const ext = dot === -1 ? '' : displayName.slice(dot);
    let i = 1;
    while (taken.has(`${stem}_${i}${ext}`)) i++;
    displayName = `${stem}_${i}${ext}`;
  }

  const { error } = await supabase.from('pipeline_photos').insert({
    id: photoId,
    project_id: projectId,
    original_filename: displayName,
    original_storage_path: path,
  });
  if (error) {
    console.error('confirm-upload insert failed', error);
    return sendError(res, 500, 'Could not save photo');
  }
  return res.status(200).json({ ok: true, filename: displayName });
}

async function handleConfirmReferenceUpload(_req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  // Simplified vs. the local tool's byte-compare-to-preserve-mask check --
  // every reference replace clears the mask (flagged in the plan).
  await clearReferenceMask(supabase);
  return res.status(200).json({ ok: true });
}

async function handleSaveReferenceMask(_req: VercelRequest, res: VercelResponse) {
  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Per-photo mutations
// ---------------------------------------------------------------------------

async function writeMaskPreview(supabase: SupabaseClient, photo: { project_id: string; id: string; crop_storage_path: string | null; upscale_storage_path: string | null; original_storage_path: string }, maskPath: string) {
  const baseImagePath = photo.upscale_storage_path || photo.crop_storage_path || photo.original_storage_path;
  const [{ data: imageData, error: imageError }, { data: maskData, error: maskError }] = await Promise.all([
    supabase.storage.from(ADMIN_PIPELINE_BUCKET).download(baseImagePath),
    supabase.storage.from(ADMIN_PIPELINE_BUCKET).download(maskPath),
  ]);
  if (imageError || maskError) throw imageError || maskError;

  const imageBuffer = Buffer.from(await imageData.arrayBuffer());
  const maskBuffer = Buffer.from(await maskData.arrayBuffer());
  const { width, height } = await sharp(imageBuffer).metadata();
  if (!width || !height) throw new Error('could not read image dimensions');

  const base = await sharp(imageBuffer).ensureAlpha().raw().toBuffer();
  const mask = await sharp(maskBuffer).resize(width, height, { kernel: 'nearest' }).grayscale().raw().toBuffer();

  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const alpha = (mask[i]! / 255) * 0.6;
    const bi = i * 4;
    out[i * 3] = Math.round(255 * alpha + base[bi]! * (1 - alpha));
    out[i * 3 + 1] = Math.round(base[bi + 1]! * (1 - alpha));
    out[i * 3 + 2] = Math.round(base[bi + 2]! * (1 - alpha));
  }

  const previewPath = `${photo.project_id}/${photo.id}/mask_preview.jpg`;
  const previewBuffer = await sharp(out, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  const { error: uploadError } = await supabase.storage.from(ADMIN_PIPELINE_BUCKET).upload(previewPath, previewBuffer, { contentType: 'image/jpeg', upsert: true });
  if (uploadError) throw uploadError;
  return previewPath;
}

async function handleSaveMask(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { photoId, path } = req.body || {};
  if (!photoId || !path) return sendError(res, 400, 'Missing photoId or path');

  try {
    const photo = await getPhoto(supabase, photoId);
    const previewPath = await writeMaskPreview(supabase, photo, path);
    const { error } = await supabase
      .from('pipeline_photos')
      .update({ mask_storage_path: path, mask_preview_storage_path: previewPath, updated_at: new Date().toISOString() })
      .eq('id', photoId);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('save-mask failed', err);
    return sendError(res, 500, (err as Error).message);
  }
}

async function handleRunCrop(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { photoId, left, top, side } = req.body || {};
  if (!photoId || !Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(side)) {
    return sendError(res, 400, 'Missing photoId, left, top, or side');
  }

  try {
    const photo = await getPhoto(supabase, photoId);
    const { data: originalData, error: downloadError } = await supabase.storage.from(ADMIN_PIPELINE_BUCKET).download(photo.original_storage_path);
    if (downloadError) throw downloadError;
    const originalBuffer = Buffer.from(await originalData.arrayBuffer());

    const cropBuffer = await sharp(originalBuffer).extract({ left, top, width: side, height: side }).jpeg({ quality: 95 }).toBuffer();
    const cropPath = `${photo.project_id}/${photo.id}/crop.jpg`;
    const { error: uploadError } = await supabase.storage.from(ADMIN_PIPELINE_BUCKET).upload(cropPath, cropBuffer, { contentType: 'image/jpeg', upsert: true });
    if (uploadError) throw uploadError;

    // Cropping changes framing -- a mask or upscale against the old crop no
    // longer lines up with anything downstream.
    const stalePaths = [photo.upscale_storage_path, photo.mask_storage_path, photo.mask_preview_storage_path].filter(Boolean) as string[];
    if (stalePaths.length) await supabase.storage.from(ADMIN_PIPELINE_BUCKET).remove(stalePaths);

    const { error: updateError } = await supabase
      .from('pipeline_photos')
      .update({
        crop_storage_path: cropPath,
        upscale_storage_path: null,
        upscale_target: null,
        mask_storage_path: null,
        mask_preview_storage_path: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', photoId);
    if (updateError) throw updateError;

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('run-crop failed', err);
    return sendError(res, 500, (err as Error).message);
  }
}

async function handleRemovePhoto(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const photoId = String(req.body?.photoId || '');
  if (!photoId) return sendError(res, 400, 'Missing photoId');

  const { data: photo, error } = await supabase
    .from('pipeline_photos')
    .select('original_storage_path, crop_storage_path, upscale_storage_path, mask_storage_path, mask_preview_storage_path, pipeline_results(storage_path)')
    .eq('id', photoId)
    .single();
  if (error || !photo) return sendError(res, 404, 'Photo not found');

  const paths = [photo.original_storage_path, photo.crop_storage_path, photo.upscale_storage_path, photo.mask_storage_path, photo.mask_preview_storage_path].filter(Boolean) as string[];
  for (const result of photo.pipeline_results as { storage_path: string }[]) paths.push(result.storage_path);
  if (paths.length) await supabase.storage.from(ADMIN_PIPELINE_BUCKET).remove(paths);

  const { error: deleteError } = await supabase.from('pipeline_photos').delete().eq('id', photoId);
  if (deleteError) {
    console.error('remove-photo delete failed', deleteError);
    return sendError(res, 502, 'Could not remove photo');
  }
  return res.status(200).json({ ok: true });
}

async function handleRemoveResult(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const resultId = String(req.body?.resultId || '');
  if (!resultId) return sendError(res, 400, 'Missing resultId');

  const { data: result, error } = await supabase.from('pipeline_results').select('storage_path').eq('id', resultId).single();
  if (error || !result) return sendError(res, 404, 'Result not found');

  await supabase.storage.from(ADMIN_PIPELINE_BUCKET).remove([result.storage_path]);
  const { error: deleteError } = await supabase.from('pipeline_results').delete().eq('id', resultId);
  if (deleteError) {
    console.error('remove-result delete failed', deleteError);
    return sendError(res, 502, 'Could not remove result');
  }
  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Async job steps (start-upscale/start-ideogram/poll-job) -- the thin HTTP
// wrapper around pipelineJobs.ts's state machine, was admin-pipeline-run.ts.
// ---------------------------------------------------------------------------

async function getPhotoForJob(supabase: SupabaseClient, photoId: string): Promise<PipelinePhotoRow> {
  const { data, error } = await supabase.from('pipeline_photos').select('*').eq('id', photoId).single();
  if (error || !data) throw new Error('photo not found');
  return data as PipelinePhotoRow;
}

async function getJob(supabase: SupabaseClient, jobId: string): Promise<PipelineJobRow> {
  const { data, error } = await supabase.from('pipeline_jobs').select('*').eq('id', jobId).single();
  if (error || !data) throw new Error('job not found');
  return data as PipelineJobRow;
}

async function handleStartUpscale(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { photoId, target } = req.body || {};
  if (!photoId || !Number.isFinite(target)) return sendError(res, 400, 'Missing photoId or target');

  try {
    const photo = await getPhotoForJob(supabase, photoId);
    const job = await startUpscaleJob(supabase, photo, target);
    return res.status(200).json(job);
  } catch (err) {
    console.error('start-upscale failed', err);
    return sendError(res, 500, (err as Error).message);
  }
}

async function handleStartIdeogram(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { photoId, expression } = req.body || {};
  if (!photoId) return sendError(res, 400, 'Missing photoId');

  try {
    const photo = await getPhotoForJob(supabase, photoId);
    const job = await startIdeogramJob(supabase, photo, expression || null);
    return res.status(200).json(job);
  } catch (err) {
    console.error('start-ideogram failed', err);
    return sendError(res, 500, (err as Error).message);
  }
}

async function handlePollJob(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { jobId } = req.body || {};
  if (!jobId) return sendError(res, 400, 'Missing jobId');

  try {
    const job = await getJob(supabase, jobId);
    const photo = await getPhotoForJob(supabase, job.photo_id);
    const advanced = await advanceJob(supabase, job, photo);
    return res.status(200).json(advanced);
  } catch (err) {
    console.error('poll-job failed', err);
    return sendError(res, 500, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Read-only resources (?resource=), was admin-pipeline-data.ts.
// ---------------------------------------------------------------------------

async function handleProjects(res: VercelResponse, supabase: SupabaseClient) {
  const { data, error } = await supabase.from('pipeline_projects').select('id, label').order('created_at', { ascending: true });
  if (error) {
    console.error('pipeline_projects query failed', error);
    return sendError(res, 500, 'Could not load projects');
  }
  return res.status(200).json(data);
}

async function handleReference(res: VercelResponse, supabase: SupabaseClient) {
  const status = await characterReferenceStatus(supabase);
  const entries = [];
  if (status.hasReference) entries.push({ bucket: ADMIN_PIPELINE_BUCKET, path: CHARACTER_REFERENCE_PATH });
  if (status.hasReferenceMask) entries.push({ bucket: ADMIN_PIPELINE_BUCKET, path: CHARACTER_REFERENCE_MASK_PATH });

  const urls = entries.length ? await signGrouped(supabase, entries, ADMIN_PIPELINE_SIGN_TTL) : {};
  return res.status(200).json({
    hasReference: status.hasReference,
    hasReferenceMask: status.hasReferenceMask,
    referenceUrl: status.hasReference ? urls[`${ADMIN_PIPELINE_BUCKET}::${CHARACTER_REFERENCE_PATH}`] : null,
    referenceMaskUrl: status.hasReferenceMask ? urls[`${ADMIN_PIPELINE_BUCKET}::${CHARACTER_REFERENCE_MASK_PATH}`] : null,
  });
}

async function handleState(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const projectId = String(req.query.projectId || '');
  if (!projectId) return sendError(res, 400, 'Missing projectId');

  const { data: photos, error } = await supabase
    .from('pipeline_photos')
    .select('*, pipeline_results(id, storage_path, delivered_filename, prompt, expression, created_at)')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('pipeline_photos query failed', error);
    return sendError(res, 500, 'Could not load project state');
  }

  const entries: { bucket: string; path: string }[] = [];
  for (const photo of photos) {
    for (const path of [photo.original_storage_path, photo.crop_storage_path, photo.upscale_storage_path, photo.mask_storage_path, photo.mask_preview_storage_path]) {
      if (path) entries.push({ bucket: ADMIN_PIPELINE_BUCKET, path });
    }
    for (const result of photo.pipeline_results) {
      entries.push({ bucket: ADMIN_PIPELINE_BUCKET, path: result.storage_path });
    }
  }
  const urls = entries.length ? await signGrouped(supabase, entries, ADMIN_PIPELINE_SIGN_TTL) : {};
  const urlFor = (path: string | null) => (path ? urls[`${ADMIN_PIPELINE_BUCKET}::${path}`] ?? null : null);

  const rows = photos.map((photo) => ({
    id: photo.id,
    originalFilename: photo.original_filename,
    originalUrl: urlFor(photo.original_storage_path),
    cropUrl: urlFor(photo.crop_storage_path),
    upscaleUrl: urlFor(photo.upscale_storage_path),
    upscaleTarget: photo.upscale_target,
    maskUrl: urlFor(photo.mask_storage_path),
    maskPreviewUrl: urlFor(photo.mask_preview_storage_path),
    hasMask: Boolean(photo.mask_storage_path),
    hasCrop: Boolean(photo.crop_storage_path),
    results: photo.pipeline_results.map((result: { id: string; storage_path: string; delivered_filename: string; prompt: string; expression: string | null }) => ({
      id: result.id,
      url: urlFor(result.storage_path),
      deliveredFilename: result.delivered_filename,
      prompt: result.prompt,
      expression: result.expression,
    })),
  }));

  return res.status(200).json(rows);
}

async function handleGet(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const resource = String(req.query.resource || '');
  if (resource === 'projects') return handleProjects(res, supabase);
  if (resource === 'reference') return handleReference(res, supabase);
  if (resource === 'state') return handleState(req, res, supabase);
  return sendError(res, 400, 'Unknown resource');
}

async function handlePost(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { action } = req.body || {};
  switch (action) {
    case 'create-project':
      return handleCreateProject(req, res, supabase);
    case 'delete-project':
      return handleDeleteProject(req, res, supabase);
    case 'sign-upload':
      return handleSignUpload(req, res, supabase);
    case 'confirm-upload':
      return handleConfirmUpload(req, res, supabase);
    case 'confirm-reference-upload':
      return handleConfirmReferenceUpload(req, res, supabase);
    case 'save-reference-mask':
      return handleSaveReferenceMask(req, res);
    case 'save-mask':
      return handleSaveMask(req, res, supabase);
    case 'run-crop':
      return handleRunCrop(req, res, supabase);
    case 'remove-photo':
      return handleRemovePhoto(req, res, supabase);
    case 'remove-result':
      return handleRemoveResult(req, res, supabase);
    case 'start-upscale':
      return handleStartUpscale(req, res, supabase);
    case 'start-ideogram':
      return handleStartIdeogram(req, res, supabase);
    case 'poll-job':
      return handlePollJob(req, res, supabase);
    default:
      return sendError(res, 400, 'Unknown action');
  }
}

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendError(res, 405, 'Method not allowed');
  }
  if (!requireAdminAuth(req, res)) return;

  const supabase = getSupabaseClient(res);
  if (!supabase) return;

  return req.method === 'GET' ? handleGet(req, res, supabase) : handlePost(req, res, supabase);
};
