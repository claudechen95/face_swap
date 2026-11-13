const { createClient } = require('@supabase/supabase-js');
const { requireAdminAuth } = require('./_lib/adminAuth');
const viewAsToken = require('./_lib/viewAsToken');

const BUCKET = 'user-photos';

async function handleDelete(req, res) {
  const { type, id } = req.body || {};
  if ((type !== 'submission' && type !== 'profile') || (typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) {
    return res.status(400).json({ error: 'Missing type or id' });
  }

  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
  const photoColumn = type === 'submission' ? 'submission_id' : 'user_id';
  const table = type === 'submission' ? 'submissions' : 'profiles';

  const { data: photos, error: photosError } = await supabase
    .from('uploaded_photos')
    .select('storage_path')
    .eq(photoColumn, id);

  if (photosError) {
    console.error('admin-delete photos lookup failed', photosError);
    return res.status(500).json({ error: 'Could not load photos' });
  }

  // swap_jobs references the owner (and also references uploaded_photos.id
  // via target_photo_id) with a NO ACTION foreign key, not cascade --
  // deleting the owner or their photos first would fail with a foreign-key
  // violation for any lead who has actually gone through swapping. Clear it first.
  const { error: deleteSwapJobsError } = await supabase.from('swap_jobs').delete().eq(photoColumn, id);
  if (deleteSwapJobsError) {
    console.error('admin-delete swap_jobs delete failed', deleteSwapJobsError);
    return res.status(502).json({ error: 'Could not remove swap jobs' });
  }

  if (photos.length) {
    const { error: removeError } = await supabase.storage.from(BUCKET).remove(photos.map((p) => p.storage_path));
    if (removeError) {
      console.error('admin-delete storage remove failed', removeError);
      return res.status(502).json({ error: 'Could not remove photos' });
    }

    const { error: deletePhotosError } = await supabase.from('uploaded_photos').delete().eq(photoColumn, id);
    if (deletePhotosError) {
      console.error('admin-delete uploaded_photos delete failed', deletePhotosError);
      return res.status(502).json({ error: 'Could not remove photos' });
    }
  }

  const { error: deleteError } = await supabase.from(table).delete().eq('id', id);
  if (deleteError) {
    console.error('admin-delete lead delete failed', deleteError);
    return res.status(502).json({ error: 'Could not delete lead' });
  }

  return res.status(200).json({ ok: true });
}

async function handleViewAs(req, res) {
  const { userId } = req.body || {};
  if (typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  const token = viewAsToken.sign(userId.trim());

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${host}/upload?viewAs=${encodeURIComponent(token)}`;

  return res.status(200).json({ url });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminAuth(req, res)) return;

  const { action } = req.body || {};
  if (action === 'delete') return handleDelete(req, res);
  if (action === 'view-as') return handleViewAs(req, res);
  return res.status(400).json({ error: 'Unknown action' });
};
