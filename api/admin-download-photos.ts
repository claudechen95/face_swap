import type { VercelRequest, VercelResponse } from '@vercel/node';
import JSZip from 'jszip';
import { requireAdminAuth } from './_lib/adminAuth.js';
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

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendError(res, 405, 'Method not allowed');
  }

  if (!requireAdminAuth(req, res)) return;

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
};
