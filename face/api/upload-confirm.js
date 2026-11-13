const { createClient } = require('@supabase/supabase-js');
const { resolveIdentity, resolveKind, hasReviewedFaceMask } = require('./_lib/identity');
const { triggerPipeline } = require('./_lib/triggerPipeline');
const { checkImageSafety } = require('./_lib/contentModeration');
const { checkSinglePersonPhoto } = require('./_lib/facePhotoJudge');
const { createSwapJobForTarget } = require('./_lib/swapJob');

const BUCKET = 'user-photos';
const MODERATION_URL_TTL = 300;

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

  // Every path we sign is prefixed with the owner's storage prefix, so this also
  // stops one account/link from being used to confirm a photo signed for another.
  if (!path.trim().startsWith(`${identity.storagePrefix}/`)) {
    return res.status(403).json({ error: 'Invalid photo path' });
  }

  const { NTFY_TOPIC } = process.env;
  const table = identity.column === 'user_id' ? 'profiles' : 'submissions';
  const { data: owner } = await supabase.from(table).select('name').eq('id', identity.id).maybeSingle();
  const who = owner ? owner.name : 'A lead';

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

  async function notifyAdmin(title, body, tags) {
    if (!NTFY_TOPIC) return;
    try {
      await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: 'POST',
        headers: { Title: title, Tags: tags, Click: 'https://faceswap.fit/admin' },
        body,
      });
    } catch (err) {
      console.error('ntfy notify failed', err);
    }
  }

  const { data: signedUrlData, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path.trim(), MODERATION_URL_TTL);

  if (signError) {
    console.error('createSignedUrl (moderation) failed', signError);
    return res.status(500).json({ error: 'Could not verify photo' });
  }

  try {
    const review = await checkImageSafety(signedUrlData.signedUrl);
    if (!review.safe) {
      // The file already landed in storage (the client uploads directly to
      // the signed URL before calling this endpoint) -- remove it now
      // rather than leaving an orphaned, never-referenced file behind.
      await supabase.storage.from(BUCKET).remove([path.trim()]);
      await notifyAdmin(
        'Photo rejected by moderation',
        `${who} tried to upload a ${kindConfig.kind} photo that got rejected: ${review.reason || 'no reason given'}`,
        'no_entry'
      );
      return res.status(422).json({ error: "This photo doesn't meet our content guidelines. Please upload a different photo." });
    }
  } catch (err) {
    // Don't block a legitimate upload because our own moderation tooling is
    // down -- log it and let the upload proceed.
    console.error('checkImageSafety failed', err);
  }

  if (kindConfig.kind === 'face') {
    try {
      const multiplePeople = await checkSinglePersonPhoto(signedUrlData.signedUrl);
      if (multiplePeople) {
        await supabase.storage.from(BUCKET).remove([path.trim()]);
        return res.status(422).json({ error: 'This photo has more than one person in it — upload a photo with just you.' });
      }
    } catch (err) {
      // Same philosophy as checkImageSafety above -- a classifier outage
      // shouldn't block a legitimate upload. validateFacePhotoSet (run at
      // "Done") is the backstop if a bad photo slips through here.
      console.error('checkSinglePersonPhoto failed', err);
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

  const { data: insertedRow, error: insertError } = await supabase
    .from('uploaded_photos')
    .insert({ [identity.column]: identity.id, storage_path: path.trim(), kind: kindConfig.kind })
    .select('id')
    .single();

  if (insertError) {
    console.error('uploaded_photos insert failed', insertError);
    return res.status(502).json({ error: 'Could not confirm upload' });
  }

  // No server-side mask pre-fill anymore -- the face-mask review modal
  // computes its own starting mask client-side (MediaPipe selfie segmentation
  // in the browser, see upload.js's computeAutoMaskCanvas) the first time
  // it's opened, and uploads it to mask_storage_path itself on save.
  const maskUrl = null;

  if (kindConfig.kind === 'target') {
    const { data: faceRow } = await supabase
      .from('uploaded_photos')
      .select('mask_storage_path')
      .eq(identity.column, identity.id)
      .eq('kind', 'face')
      .maybeSingle();

    await createSwapJobForTarget(supabase, {
      photoColumn: identity.column,
      ownerId: identity.id,
      target: { id: insertedRow.id, storage_path: path.trim(), bucket: BUCKET },
      faceMaskStoragePath: faceRow ? faceRow.mask_storage_path : null,
    });

    await triggerPipeline();
  }

  return res.status(200).json({ ok: true, maskUrl });
};
