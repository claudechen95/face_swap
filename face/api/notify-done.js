const { createClient } = require('@supabase/supabase-js');
const { resolveIdentity, resolveKind } = require('./_lib/identity');
const { triggerPipeline } = require('./_lib/triggerPipeline');
const { validateFacePhotoSet } = require('./_lib/facePhotoJudge');

const BUCKET = 'user-photos';
const SIGNED_URL_TTL = 600;

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
  const { data: owner } = await supabase.from(table).select('name, paid_at').eq('id', identity.id).maybeSingle();

  const kindConfig = resolveKind(req.body);
  if (!kindConfig) {
    return res.status(400).json({ error: 'Unsupported photo kind' });
  }

  const { data: photoRows, count } = await supabase
    .from('uploaded_photos')
    .select('storage_path', { count: 'exact' })
    .eq(identity.column, identity.id)
    .eq('kind', kindConfig.kind);

  if (kindConfig.kind === 'face') {
    const { data: signedUrls, error: signError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrls(
        photoRows.map((row) => row.storage_path),
        SIGNED_URL_TTL
      );

    if (signError) {
      console.error('createSignedUrls failed', signError);
      return res.status(500).json({ error: 'Could not verify link' });
    }

    try {
      // photoRows and signedUrls come from the same createSignedUrls(paths)
      // call, in the same order it was given -- safe to zip by index
      // regardless of what order the earlier DB query happened to return.
      const photos = photoRows.map((row, i) => ({ storagePath: row.storage_path, url: signedUrls[i].signedUrl }));
      const review = await validateFacePhotoSet(photos);
      if (!review.ok) {
        return res.status(422).json({ error: review.error, badPaths: review.badPaths || [] });
      }
    } catch (err) {
      // Don't block someone from finishing their upload because our own
      // review tooling is down -- log it and let the upload go through.
      console.error('validateFacePhotoSet failed', err);
    }
  }

  const { NTFY_TOPIC } = process.env;
  if (NTFY_TOPIC) {
    const who = owner ? owner.name : 'A lead';
    const body =
      kindConfig.kind === 'target'
        ? `${who} chose their photos to swap — ${count || 0}/${kindConfig.max} photos.`
        : `${who} says they're done uploading — ${count || 0}/${kindConfig.max} photos.`;
    try {
      await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: 'POST',
        headers: {
          Title: kindConfig.kind === 'target' ? 'Swap photos chosen' : 'Upload complete',
          Tags: 'white_check_mark',
          Click: 'https://faceswap.fit/admin',
        },
        body,
      });
    } catch (err) {
      console.error('ntfy notify failed', err);
    }
  }

  await triggerPipeline();

  return res.status(200).json({ ok: true });
};
