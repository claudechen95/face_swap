const { createClient } = require('@supabase/supabase-js');
const { resolveIdentity, resolveKind } = require('./_lib/identity');

const BUCKET = 'user-photos';
const LIBRARY_BUCKET = 'swap-library';
const SIGNED_URL_TTL = 3600;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
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

  const table = identity.column === 'user_id' ? 'profiles' : 'submissions';
  const { data: owner, error: ownerError } = await supabase
    .from(table)
    .select('name, paid_at')
    .eq('id', identity.id)
    .maybeSingle();

  if (ownerError || !owner) {
    console.error('Owner lookup failed', ownerError);
    return res.status(500).json({ error: 'Could not verify link' });
  }

  const kindConfig = resolveKind(req.body);
  if (!kindConfig) {
    return res.status(400).json({ error: 'Unsupported photo kind' });
  }

  const { data: photoRows, error: photosError } = await supabase
    .from('uploaded_photos')
    .select('storage_path, bucket, mask_storage_path, mask_reviewed_at')
    .eq(identity.column, identity.id)
    .eq('kind', kindConfig.kind)
    .order('created_at', { ascending: true });

  if (photosError) {
    console.error('Photo lookup failed', photosError);
    return res.status(500).json({ error: 'Could not verify link' });
  }

  const ownPaths = photoRows.filter((row) => row.bucket !== LIBRARY_BUCKET).map((row) => row.storage_path);
  const libraryPaths = photoRows.filter((row) => row.bucket === LIBRARY_BUCKET).map((row) => row.storage_path);
  const maskPaths = photoRows.filter((row) => row.mask_storage_path).map((row) => row.mask_storage_path);

  const urlByPath = {};
  const ownAndMaskPaths = [...ownPaths, ...maskPaths];
  if (ownAndMaskPaths.length) {
    const { data: signedUrls, error: signError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrls(ownAndMaskPaths, SIGNED_URL_TTL);

    if (signError) {
      console.error('createSignedUrls failed', signError);
      return res.status(500).json({ error: 'Could not verify link' });
    }

    ownAndMaskPaths.forEach((path, i) => {
      urlByPath[path] = signedUrls[i].signedUrl;
    });
  }
  libraryPaths.forEach((path) => {
    urlByPath[path] = supabase.storage.from(LIBRARY_BUCKET).getPublicUrl(path).data.publicUrl;
  });

  const photos = photoRows.map((row) => ({
    path: row.storage_path,
    url: urlByPath[row.storage_path],
    library: row.bucket === LIBRARY_BUCKET,
    maskUrl: row.mask_storage_path ? urlByPath[row.mask_storage_path] || null : null,
    maskReviewed: Boolean(row.mask_reviewed_at),
  }));

  const count = photos.length;

  return res.status(200).json({
    name: owner.name,
    paid: Boolean(owner.paid_at),
    uploaded: count,
    remaining: Math.max(0, kindConfig.max - count),
    min: kindConfig.min,
    max: kindConfig.max,
    photos,
  });
};
