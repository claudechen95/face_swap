import type { VercelRequest, VercelResponse } from '@vercel/node';
import JSZip from 'jszip';
import { requireAdminAuth } from './_lib/adminAuth.js';
import * as viewAsToken from './_lib/viewAsToken.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { USER_PHOTOS_BUCKET } from './_lib/constants.js';

function slugify(value: unknown): string {
  return (
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'lead'
  );
}

// GET ?type=&id=&kind= -- zips and streams a lead's photos, was
// admin-download-photos.ts (merged in to stay under Vercel's function cap).
async function handleDownloadPhotos(req: VercelRequest, res: VercelResponse) {
  const { type, id, kind } = req.query || {};
  if ((type !== 'submission' && type !== 'profile') || !id) {
    return sendError(res, 400, 'Missing type or id');
  }
  const photoKind = kind === 'target' ? 'target' : kind === 'results' ? 'results' : 'face';

  const supabase = getSupabaseClient(res);
  if (!supabase) return;
  const photoColumn = type === 'submission' ? 'submission_id' : 'user_id';
  const table = type === 'submission' ? 'submissions' : 'profiles';

  const { data: lead, error: leadError } = await supabase
    .from(table)
    .select('name')
    .eq('id', id)
    .maybeSingle();

  if (leadError || !lead) {
    return sendError(res, 404, 'Lead not found');
  }

  let photos: { storage_path: string; bucket: string | null }[];
  if (photoKind === 'results') {
    // Results live on swap_jobs, not uploaded_photos -- these are the
    // generated outputs, not anything the lead uploaded. Only 'done' jobs
    // have a result_storage_path that's actually meant to be seen (a
    // needs_review job's last attempt is deliberately never exposed, same
    // as on the customer-facing results page).
    const { data: jobs, error: jobsError } = await supabase
      .from('swap_jobs')
      .select('result_storage_path')
      .eq(photoColumn, id)
      .eq('status', 'done');

    if (jobsError) {
      console.error('admin-download-photos swap_jobs lookup failed', jobsError);
      return sendError(res, 500, 'Could not load photos');
    }
    photos = jobs
      .filter((j) => j.result_storage_path)
      .map((j) => ({ storage_path: j.result_storage_path as string, bucket: USER_PHOTOS_BUCKET }));
  } else {
    const { data, error: photosError } = await supabase
      .from('uploaded_photos')
      .select('storage_path, bucket')
      .eq(photoColumn, id)
      .eq('kind', photoKind);

    if (photosError) {
      console.error('admin-download-photos lookup failed', photosError);
      return sendError(res, 500, 'Could not load photos');
    }
    photos = data;
  }

  if (!photos.length) {
    return sendError(res, 404, 'No photos for this lead');
  }

  const zip = new JSZip();
  for (const { storage_path: path, bucket } of photos) {
    const { data, error } = await supabase.storage.from(bucket || USER_PHOTOS_BUCKET).download(path);
    if (error) {
      console.error('admin-download-photos download failed', path, error);
      continue;
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    zip.file(path.split('/').pop()!, buffer);
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const filename = `${slugify(lead.name)}-${photoKind}-photos.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(zipBuffer);
}

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
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return sendError(res, 405, 'Method not allowed');
  }

  if (!requireAdminAuth(req, res)) return;

  if (req.method === 'GET') return handleDownloadPhotos(req, res);

  const { action } = req.body || {};
  if (action === 'delete') return handleDelete(req, res);
  if (action === 'view-as') return handleViewAs(req, res);
  return sendError(res, 400, 'Unknown action');
};
