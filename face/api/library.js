const { createClient } = require('@supabase/supabase-js');
const { resolveIdentity, resolveKind, hasReviewedFaceMask } = require('./_lib/identity');
const { triggerPipeline } = require('./_lib/triggerPipeline');
const { createSwapJobForTarget } = require('./_lib/swapJob');

const BUCKET = 'swap-library';

async function handleList(req, res, supabase) {
  const { data: rows, error } = await supabase
    .from('library_photos')
    .select('id, storage_path')
    .order('id', { ascending: true });

  if (error) {
    console.error('library_photos query failed', error);
    return res.status(500).json({ error: 'Could not load library' });
  }

  const photos = rows.map((row) => ({
    id: row.id,
    storagePath: row.storage_path,
    url: supabase.storage.from(BUCKET).getPublicUrl(row.storage_path).data.publicUrl,
  }));

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({ photos });
}

async function handleSelect(req, res, supabase) {
  const { libraryPhotoId } = req.body || {};
  if (!libraryPhotoId) {
    return res.status(400).json({ error: 'Missing libraryPhotoId' });
  }

  const identity = await resolveIdentity(req, supabase);
  if (!identity) {
    return res.status(404).json({ error: 'This upload link is invalid' });
  }

  try {
    if (!(await hasReviewedFaceMask(supabase, identity))) {
      return res.status(403).json({ error: 'Please review your face mask before adding target photos' });
    }
  } catch (err) {
    console.error('hasReviewedFaceMask failed', err);
    return res.status(500).json({ error: 'Could not verify link' });
  }

  // The library lookup, the lead's current target photos, and their face
  // mask are all independent -- fetch them in parallel instead of several
  // sequential round trips.
  const [libraryResult, targetsResult, faceResult] = await Promise.all([
    supabase.from('library_photos').select('storage_path').eq('id', libraryPhotoId).maybeSingle(),
    supabase.from('uploaded_photos').select('storage_path').eq(identity.column, identity.id).eq('kind', 'target'),
    supabase.from('uploaded_photos').select('mask_storage_path').eq(identity.column, identity.id).eq('kind', 'face').maybeSingle(),
  ]);

  const kindConfig = resolveKind({ kind: 'target' });

  if (libraryResult.error || !libraryResult.data) {
    return res.status(404).json({ error: 'Library photo not found' });
  }
  if (targetsResult.error) {
    console.error('target photos lookup failed', targetsResult.error);
    return res.status(500).json({ error: 'Could not verify link' });
  }

  const storagePath = libraryResult.data.storage_path;
  const existingTargets = targetsResult.data;

  if (existingTargets.some((row) => row.storage_path === storagePath)) {
    return res.status(200).json({ ok: true, alreadySelected: true });
  }
  if (existingTargets.length >= kindConfig.max) {
    return res.status(403).json({ error: `You've reached the ${kindConfig.max}-photo limit` });
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
    return res.status(502).json({ error: 'Could not select photo' });
  }

  await createSwapJobForTarget(supabase, {
    photoColumn: identity.column,
    ownerId: identity.id,
    target: { id: insertedRow.id, storage_path: storagePath, bucket: BUCKET },
    faceMaskStoragePath: faceResult.data ? faceResult.data.mask_storage_path : null,
  });

  await triggerPipeline();

  return res.status(200).json({ ok: true });
}

module.exports = async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  if (req.method === 'GET') return handleList(req, res, supabase);
  if (req.method === 'POST') return handleSelect(req, res, supabase);

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
