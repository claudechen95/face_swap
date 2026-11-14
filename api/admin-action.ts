import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdminAuth } from './_lib/adminAuth.js';
import * as viewAsToken from './_lib/viewAsToken.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { USER_PHOTOS_BUCKET } from './_lib/constants.js';

async function handleDelete(req: VercelRequest, res: VercelResponse) {
  const { type, id } = req.body || {};
  if ((type !== 'submission' && type !== 'profile') || (typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) {
    return sendError(res, 400, 'Missing type or id');
  }

  const supabase = getSupabaseClient(res);
  if (!supabase) return;
  const photoColumn = type === 'submission' ? 'submission_id' : 'user_id';
  const table = type === 'submission' ? 'submissions' : 'profiles';

  const { data: photos, error: photosError } = await supabase
    .from('uploaded_photos')
    .select('storage_path')
    .eq(photoColumn, id);

  if (photosError) {
    console.error('admin-delete photos lookup failed', photosError);
    return sendError(res, 500, 'Could not load photos');
  }

  // swap_jobs references the owner (and also references uploaded_photos.id
  // via target_photo_id) with a NO ACTION foreign key, not cascade --
  // deleting the owner or their photos first would fail with a foreign-key
  // violation for any lead who has actually gone through swapping. Clear it first.
  const { error: deleteSwapJobsError } = await supabase.from('swap_jobs').delete().eq(photoColumn, id);
  if (deleteSwapJobsError) {
    console.error('admin-delete swap_jobs delete failed', deleteSwapJobsError);
    return sendError(res, 502, 'Could not remove swap jobs');
  }

  if (photos.length) {
    const { error: removeError } = await supabase.storage.from(USER_PHOTOS_BUCKET).remove(photos.map((p) => p.storage_path));
    if (removeError) {
      console.error('admin-delete storage remove failed', removeError);
      return sendError(res, 502, 'Could not remove photos');
    }

    const { error: deletePhotosError } = await supabase.from('uploaded_photos').delete().eq(photoColumn, id);
    if (deletePhotosError) {
      console.error('admin-delete uploaded_photos delete failed', deletePhotosError);
      return sendError(res, 502, 'Could not remove photos');
    }
  }

  const { error: deleteError } = await supabase.from(table).delete().eq('id', id);
  if (deleteError) {
    console.error('admin-delete lead delete failed', deleteError);
    return sendError(res, 502, 'Could not delete lead');
  }

  return res.status(200).json({ ok: true });
}

async function handleViewAs(req: VercelRequest, res: VercelResponse) {
  const { userId } = req.body || {};
  if (typeof userId !== 'string' || !userId.trim()) {
    return sendError(res, 400, 'Missing userId');
  }

  const token = viewAsToken.sign(userId.trim());

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${host}/upload?viewAs=${encodeURIComponent(token)}`;

  return res.status(200).json({ url });
}

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Method not allowed');
  }

  if (!requireAdminAuth(req, res)) return;

  const { action } = req.body || {};
  if (action === 'delete') return handleDelete(req, res);
  if (action === 'view-as') return handleViewAs(req, res);
  return sendError(res, 400, 'Unknown action');
};
