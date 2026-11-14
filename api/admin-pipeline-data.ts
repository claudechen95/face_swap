import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdminAuth } from './_lib/adminAuth.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { signGrouped } from './_lib/signStorage.js';
import { characterReferenceStatus, CHARACTER_REFERENCE_MASK_PATH, CHARACTER_REFERENCE_PATH } from './_lib/pipelineReference.js';
import { ADMIN_PIPELINE_BUCKET, ADMIN_PIPELINE_SIGN_TTL } from './_lib/constants.js';

/**
 * Read-only admin-pipeline resources, dispatched by `?resource=`. Replaces
 * face_swap/server/app.ts's GET routes (/projects, /character-reference-status,
 * /character-reference, /character-reference-mask, /state, /images/:name,
 * /swap-params) all at once -- every image reference here is a pre-signed
 * Supabase Storage URL embedded directly in the JSON response, so there's
 * no equivalent of the old byte-proxy /images/:name route.
 */

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

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAdminAuth(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendError(res, 405, 'Method not allowed');
  }

  const supabase = getSupabaseClient(res);
  if (!supabase) return;

  const resource = String(req.query.resource || '');
  if (resource === 'projects') return handleProjects(res, supabase);
  if (resource === 'reference') return handleReference(res, supabase);
  if (resource === 'state') return handleState(req, res, supabase);
  return sendError(res, 400, 'Unknown resource');
};
