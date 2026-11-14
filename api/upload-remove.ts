import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resolveIdentity } from './_lib/identity.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { USER_PHOTOS_BUCKET } from './_lib/constants.js';

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Method not allowed');
  }

  const { path } = req.body || {};
  if (typeof path !== 'string' || !path.trim()) {
    return sendError(res, 400, 'Missing path');
  }

  const supabase = getSupabaseClient(res);
  if (!supabase) return;
  const identity = await resolveIdentity(req, supabase);
  if (!identity) {
    return sendError(res, 404, 'This upload link is invalid');
  }

  const { data: photoRow, error: photoError } = await supabase
    .from('uploaded_photos')
    .select('id, bucket, mask_storage_path')
    .eq(identity.column, identity.id)
    .eq('storage_path', path.trim())
    .maybeSingle();

  if (photoError) {
    console.error('uploaded_photos lookup failed', photoError);
    return sendError(res, 500, 'Could not verify link');
  }
  if (!photoRow) {
    return sendError(res, 404, 'Photo not found');
  }

  // Library photos are shared across every lead -- only ever delete the
  // lead's own uploaded_photos row for it, never the underlying storage
  // object. Personal uploads (bucket = 'user-photos') own their storage
  // object outright and get it deleted too.
  if (photoRow.bucket === 'user-photos') {
    // Every path we sign is prefixed with the owner's storage prefix, so this
    // also stops one account/link from being used to remove a photo
    // belonging to another (defense in depth on top of the row lookup above).
    if (!path.trim().startsWith(`${identity.storagePrefix}/`)) {
      return sendError(res, 403, 'Invalid photo path');
    }

    const pathsToRemove = [path.trim()];
    if (photoRow.mask_storage_path) pathsToRemove.push(photoRow.mask_storage_path);

    const { error: removeError } = await supabase.storage.from(USER_PHOTOS_BUCKET).remove(pathsToRemove);
    if (removeError) {
      console.error('storage remove failed', removeError);
      return sendError(res, 502, 'Could not remove photo');
    }
  }

  // A target photo gets its swap_jobs row the moment it's added (see
  // api/_lib/swapJob.ts's createSwapJobForTarget), so by the time a user
  // removes it one almost always already exists -- swap_jobs.target_photo_id
  // references uploaded_photos.id with a NO ACTION foreign key, not cascade,
  // so it has to go first or the delete below fails.
  const { data: jobRows, error: jobLookupError } = await supabase
    .from('swap_jobs')
    .select('id, mask_storage_path, reference_mask_storage_path, result_storage_path')
    .eq('target_photo_id', photoRow.id);

  if (jobLookupError) {
    console.error('swap_jobs lookup failed', jobLookupError);
    return sendError(res, 500, 'Could not remove photo');
  }

  if (jobRows.length) {
    const jobPathsToRemove = jobRows.flatMap((j) => [j.mask_storage_path, j.reference_mask_storage_path, j.result_storage_path].filter(Boolean));
    if (jobPathsToRemove.length) {
      const { error: jobStorageRemoveError } = await supabase.storage.from(USER_PHOTOS_BUCKET).remove(jobPathsToRemove);
      if (jobStorageRemoveError) console.error('swap job storage remove failed', jobStorageRemoveError);
    }

    const { error: deleteJobsError } = await supabase.from('swap_jobs').delete().eq('target_photo_id', photoRow.id);
    if (deleteJobsError) {
      console.error('swap_jobs delete failed', deleteJobsError);
      return sendError(res, 502, 'Could not remove photo');
    }
  }

  const { error: deleteError } = await supabase.from('uploaded_photos').delete().eq('id', photoRow.id);

  if (deleteError) {
    console.error('uploaded_photos delete failed', deleteError);
    return sendError(res, 502, 'Could not remove photo');
  }

  return res.status(200).json({ ok: true });
};
