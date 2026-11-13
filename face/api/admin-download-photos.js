const { createClient } = require('@supabase/supabase-js');
const JSZip = require('jszip');
const { requireAdminAuth } = require('./_lib/adminAuth');

const BUCKET = 'user-photos';

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'lead';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminAuth(req, res)) return;

  const { type, id, kind } = req.query || {};
  if ((type !== 'submission' && type !== 'profile') || !id) {
    return res.status(400).json({ error: 'Missing type or id' });
  }
  const photoKind = kind === 'target' ? 'target' : kind === 'results' ? 'results' : 'face';

  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
  const photoColumn = type === 'submission' ? 'submission_id' : 'user_id';
  const table = type === 'submission' ? 'submissions' : 'profiles';

  const { data: lead, error: leadError } = await supabase
    .from(table)
    .select('name')
    .eq('id', id)
    .maybeSingle();

  if (leadError || !lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  let photos;
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
      return res.status(500).json({ error: 'Could not load photos' });
    }
    photos = jobs.filter((j) => j.result_storage_path).map((j) => ({ storage_path: j.result_storage_path, bucket: BUCKET }));
  } else {
    const { data, error: photosError } = await supabase
      .from('uploaded_photos')
      .select('storage_path, bucket')
      .eq(photoColumn, id)
      .eq('kind', photoKind);

    if (photosError) {
      console.error('admin-download-photos lookup failed', photosError);
      return res.status(500).json({ error: 'Could not load photos' });
    }
    photos = data;
  }

  if (!photos.length) {
    return res.status(404).json({ error: 'No photos for this lead' });
  }

  const zip = new JSZip();
  for (const { storage_path: path, bucket } of photos) {
    const { data, error } = await supabase.storage.from(bucket || BUCKET).download(path);
    if (error) {
      console.error('admin-download-photos download failed', path, error);
      continue;
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    zip.file(path.split('/').pop(), buffer);
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const filename = `${slugify(lead.name)}-${photoKind}-photos.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(zipBuffer);
};
