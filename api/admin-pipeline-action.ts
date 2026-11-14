import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { requireAdminAuth } from './_lib/adminAuth.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { ADMIN_PIPELINE_BUCKET } from './_lib/constants.js';
import { CHARACTER_REFERENCE_MASK_PATH, CHARACTER_REFERENCE_PATH, clearReferenceMask } from './_lib/pipelineReference.js';

/**
 * Fast admin-pipeline mutations, dispatched by POST body `{action, ...}`
 * (mirrors admin-action.ts's style). Replaces face_swap/server/app.ts's
 * /upload, /remove, /remove-result, /run/crop, /save-mask,
 * /upload-character-reference, /save-reference-mask, plus the project
 * CRUD the CLI's --project flag used to handle. The slow, API-bound
 * actions (upscale, Ideogram) live in admin-pipeline-run.ts instead, as an
 * async job so no single call here ever blocks for more than a few
 * seconds.
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

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Method not allowed');
  }
  if (!requireAdminAuth(req, res)) return;

  const supabase = getSupabaseClient(res);
  if (!supabase) return;

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
    default:
      return sendError(res, 400, 'Unknown action');
  }
};
