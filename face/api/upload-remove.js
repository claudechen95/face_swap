const { createClient } = require('@supabase/supabase-js');
const { resolveIdentity } = require('./_lib/identity');

const BUCKET = 'user-photos';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { path } = req.body || {};
  if (typeof path !== 'string' || !path.trim()) {
    return res.status(400).json({ error: 'Missing path' });
  }

  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
  const identity = await resolveIdentity(req, supabase);
  if (!identity) {
    return res.status(404).json({ error: 'This upload link is invalid' });
  }

  const { data: photoRow, error: photoError } = await supabase
    .from('uploaded_photos')
    .select('id, bucket, mask_storage_path')
    .eq(identity.column, identity.id)
    .eq('storage_path', path.trim())
    .maybeSingle();

  if (photoError) {
    console.error('uploaded_photos lookup failed', photoError);
    return res.status(500).json({ error: 'Could not verify link' });
  }
  if (!photoRow) {
    return res.status(404).json({ error: 'Photo not found' });
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
      return res.status(403).json({ error: 'Invalid photo path' });
    }

    const pathsToRemove = [path.trim()];
    if (photoRow.mask_storage_path) pathsToRemove.push(photoRow.mask_storage_path);

    const { error: removeError } = await supabase.storage.from(BUCKET).remove(pathsToRemove);
    if (removeError) {
      console.error('storage remove failed', removeError);
      return res.status(502).json({ error: 'Could not remove photo' });
    }
  }

  // A target photo gets its swap_jobs row the moment it's added (see
  // api/_lib/swapJob.js's createSwapJobForTarget), so by the time a user
  // removes it one almost always already exists -- swap_jobs.target_photo_id
  // references uploaded_photos.id with a NO ACTION foreign key, not cascade,
  // so it has to go first or the delete below fails.
  const { data: jobRows, error: jobLookupError } = await supabase
    .from('swap_jobs')
    .select('id, mask_storage_path, reference_mask_storage_path, result_storage_path')
    .eq('target_photo_id', photoRow.id);

  if (jobLookupError) {
    console.error('swap_jobs lookup failed', jobLookupError);
    return res.status(500).json({ error: 'Could not remove photo' });
  }

  if (jobRows.length) {
    const jobPathsToRemove = jobRows.flatMap((j) => [j.mask_storage_path, j.reference_mask_storage_path, j.result_storage_path].filter(Boolean));
    if (jobPathsToRemove.length) {
      const { error: jobStorageRemoveError } = await supabase.storage.from(BUCKET).remove(jobPathsToRemove);
      if (jobStorageRemoveError) console.error('swap job storage remove failed', jobStorageRemoveError);
    }

    const { error: deleteJobsError } = await supabase.from('swap_jobs').delete().eq('target_photo_id', photoRow.id);
    if (deleteJobsError) {
      console.error('swap_jobs delete failed', deleteJobsError);
      return res.status(502).json({ error: 'Could not remove photo' });
    }
  }

  const { error: deleteError } = await supabase.from('uploaded_photos').delete().eq('id', photoRow.id);

  if (deleteError) {
    console.error('uploaded_photos delete failed', deleteError);
    return res.status(502).json({ error: 'Could not remove photo' });
  }

  return res.status(200).json({ ok: true });
};
