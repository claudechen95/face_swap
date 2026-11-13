const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { resolveIdentity, resolveKind, hasReviewedFaceMask } = require('./_lib/identity');

const BUCKET = 'user-photos';
const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { contentType } = req.body || {};
  const ext = EXT_BY_MIME[contentType];
  if (!ext) {
    return res.status(400).json({ error: 'Unsupported file type' });
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

  const kindConfig = resolveKind(req.body);
  if (!kindConfig) {
    return res.status(400).json({ error: 'Unsupported photo kind' });
  }

  if (kindConfig.kind === 'target') {
    try {
      if (!(await hasReviewedFaceMask(supabase, identity))) {
        return res.status(403).json({ error: 'Please review your face mask before adding target photos' });
      }
    } catch (err) {
      console.error('hasReviewedFaceMask failed', err);
      return res.status(500).json({ error: 'Could not verify link' });
    }
  }

  const { count, error: countError } = await supabase
    .from('uploaded_photos')
    .select('id', { count: 'exact', head: true })
    .eq(identity.column, identity.id)
    .eq('kind', kindConfig.kind);

  if (countError) {
    console.error('Photo count lookup failed', countError);
    return res.status(500).json({ error: 'Could not verify link' });
  }
  if ((count || 0) >= kindConfig.max) {
    return res.status(403).json({ error: `You've reached the ${kindConfig.max}-photo limit` });
  }

  const prefix = kindConfig.kind === 'target' ? `${identity.storagePrefix}/targets` : identity.storagePrefix;
  const storagePath = `${prefix}/${crypto.randomUUID()}.${ext}`;

  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath);

  if (signError) {
    console.error('createSignedUploadUrl failed', signError);
    return res.status(502).json({ error: 'Could not prepare upload' });
  }

  return res.status(200).json({
    bucket: BUCKET,
    path: signed.path,
    signToken: signed.token,
  });
};
