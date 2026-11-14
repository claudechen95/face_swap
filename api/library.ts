import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveIdentity, resolveKind, hasReviewedFaceMask } from './_lib/identity.js';
import { triggerPipeline } from './_lib/triggerPipeline.js';
import { createSwapJobForTarget } from './_lib/swapJob.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { SWAP_LIBRARY_BUCKET } from './_lib/constants.js';

async function handleList(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { data: rows, error } = await supabase
    .from('library_photos')
    .select('id, storage_path')
    .order('id', { ascending: true });

  if (error) {
    console.error('library_photos query failed', error);
    return sendError(res, 500, 'Could not load library');
  }

  const photos = rows.map((row) => ({
    id: row.id,
    storagePath: row.storage_path,
    url: supabase.storage.from(SWAP_LIBRARY_BUCKET).getPublicUrl(row.storage_path).data.publicUrl,
  }));

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({ photos });
}

async function handleSelect(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { libraryPhotoId } = req.body || {};
  if (!libraryPhotoId) {
    return sendError(res, 400, 'Missing libraryPhotoId');
  }

  const identity = await resolveIdentity(req, supabase);
  if (!identity) {
    return sendError(res, 404, 'This upload link is invalid');
  }

  try {
    if (!(await hasReviewedFaceMask(supabase, identity))) {
      return sendError(res, 403, 'Please review your face mask before adding target photos');
    }
  } catch (err) {
    console.error('hasReviewedFaceMask failed', err);
    return sendError(res, 500, 'Could not verify link');
  }

  // The library lookup and the lead's current target photos are independent
  // -- fetch them in parallel instead of two sequential round trips.
  const [libraryResult, targetsResult] = await Promise.all([
    supabase.from('library_photos').select('storage_path').eq('id', libraryPhotoId).maybeSingle(),
    supabase.from('uploaded_photos').select('storage_path').eq(identity.column, identity.id).eq('kind', 'target'),
  ]);

  const kindConfig = resolveKind({ kind: 'target' })!;

  if (libraryResult.error || !libraryResult.data) {
    return sendError(res, 404, 'Library photo not found');
  }
  if (targetsResult.error) {
    console.error('target photos lookup failed', targetsResult.error);
    return sendError(res, 500, 'Could not verify link');
  }

  const storagePath = libraryResult.data.storage_path;
  const existingTargets = targetsResult.data;

  if (existingTargets.some((row) => row.storage_path === storagePath)) {
    return res.status(200).json({ ok: true, alreadySelected: true });
  }
  if (existingTargets.length >= kindConfig.max) {
    return sendError(res, 403, `You've reached the ${kindConfig.max}-photo limit`);
  }

  const { data: insertedRow, error: insertError } = await supabase
    .from('uploaded_photos')
    .insert({
      [identity.column]: identity.id,
      storage_path: storagePath,
      kind: 'target',
      bucket: 'swap-library',
    })
    .select('id')
    .single();

  if (insertError) {
    console.error('uploaded_photos insert failed', insertError);
    return sendError(res, 502, 'Could not select photo');
  }

  const job = await createSwapJobForTarget(supabase, {
    photoColumn: identity.column,
    ownerId: identity.id,
    target: { id: insertedRow.id, storage_path: storagePath, bucket: SWAP_LIBRARY_BUCKET },
  });

  // Fire-and-forget (see triggerPipeline's own doc comment) -- not awaited so
  // it can't add its own round-trip to this response's latency, which the
  // client is relying on to open the mask review modal immediately.
  triggerPipeline();

  // swap-library is a public bucket (see handleList's getPublicUrl above), so
  // the target photo's URL needs no signing -- the mask doesn't exist yet
  // (see createSwapJobForTarget's doc comment), hence maskUrl: null.
  const targetUrl = supabase.storage.from(SWAP_LIBRARY_BUCKET).getPublicUrl(storagePath).data.publicUrl;

  return res.status(200).json({
    ok: true,
    targetPhotoId: insertedRow.id,
    job: job ? { status: 'mask_review', jobId: job.jobId, targetPhotoId: insertedRow.id, targetUrl, maskUrl: null } : null,
  });
}

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseClient(res);
  if (!supabase) return;

  if (req.method === 'GET') return handleList(req, res, supabase);
  if (req.method === 'POST') return handleSelect(req, res, supabase);

  res.setHeader('Allow', 'GET, POST');
  return sendError(res, 405, 'Method not allowed');
};
