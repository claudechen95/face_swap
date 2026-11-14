import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resolveIdentity, resolveKind, hasReviewedFaceMask } from './_lib/identity.js';
import { triggerPipeline } from './_lib/triggerPipeline.js';
import { checkImageSafety } from './_lib/contentModeration.js';
import { checkSinglePersonPhoto } from './_lib/facePhotoJudge.js';
import { createSwapJobForTarget } from './_lib/swapJob.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { USER_PHOTOS_BUCKET, ownerTableFor } from './_lib/constants.js';

const MODERATION_URL_TTL = 300;

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Method not allowed');
  }

  const { path } = req.body || {};
  if (typeof path !== 'string' || !path.trim()) {
    return sendError(res, 400, 'Missing path');
  }

  const supabase = getSupabaseClient(res);
  if (!supabase) return;
  const identity = await resolveIdentity(req, supabase);
  if (!identity) {
    return sendError(res, 404, 'This upload link is invalid');
  }

  // Every path we sign is prefixed with the owner's storage prefix, so this also
  // stops one account/link from being used to confirm a photo signed for another.
  if (!path.trim().startsWith(`${identity.storagePrefix}/`)) {
    return sendError(res, 403, 'Invalid photo path');
  }

  const { NTFY_TOPIC } = process.env;
  const table = ownerTableFor(identity);
  const { data: owner } = await supabase.from(table).select('name').eq('id', identity.id).maybeSingle();
  const who = owner ? owner.name : 'A lead';

  const kindConfig = resolveKind(req.body);
  if (!kindConfig) {
    return sendError(res, 400, 'Unsupported photo kind');
  }

  if (kindConfig.kind === 'target') {
    try {
      if (!(await hasReviewedFaceMask(supabase, identity))) {
        return sendError(res, 403, 'Please review your face mask before adding target photos');
      }
    } catch (err) {
      console.error('hasReviewedFaceMask failed', err);
      return sendError(res, 500, 'Could not verify link');
    }
  }

  async function notifyAdmin(title: string, body: string, tags: string) {
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

  const { data: signedUrlData, error: signError } = await supabase.storage.from(USER_PHOTOS_BUCKET).createSignedUrl(path.trim(), MODERATION_URL_TTL);

  if (signError) {
    console.error('createSignedUrl (moderation) failed', signError);
    return sendError(res, 500, 'Could not verify photo');
  }

  try {
    const review = await checkImageSafety(signedUrlData.signedUrl);
    if (!review.safe) {
      // The file already landed in storage (the client uploads directly to
      // the signed URL before calling this endpoint) -- remove it now
      // rather than leaving an orphaned, never-referenced file behind.
      await supabase.storage.from(USER_PHOTOS_BUCKET).remove([path.trim()]);
      await notifyAdmin(
        'Photo rejected by moderation',
        `${who} tried to upload a ${kindConfig.kind} photo that got rejected: ${review.reason || 'no reason given'}`,
        'no_entry'
      );
      return sendError(res, 422, "This photo doesn't meet our content guidelines. Please upload a different photo.");
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
        await supabase.storage.from(USER_PHOTOS_BUCKET).remove([path.trim()]);
        return sendError(res, 422, 'This photo has more than one person in it — upload a photo with just you.');
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
    return sendError(res, 500, 'Could not verify link');
  }
  if ((count || 0) >= kindConfig.max) {
    return sendError(res, 403, `You've reached the ${kindConfig.max}-photo limit`);
  }

  const { data: insertedRow, error: insertError } = await supabase
    .from('uploaded_photos')
    .insert({ [identity.column]: identity.id, storage_path: path.trim(), kind: kindConfig.kind })
    .select('id')
    .single();

  if (insertError) {
    console.error('uploaded_photos insert failed', insertError);
    return sendError(res, 502, 'Could not confirm upload');
  }

  // No server-side mask pre-fill anymore -- the face-mask review modal
  // computes its own starting mask client-side (MediaPipe selfie segmentation
  // in the browser, see shared/automask.ts's computeAutoMaskCanvas, wired up
  // in upload.ts) the first time it's opened, and uploads it to
  // mask_storage_path itself on save.
  const maskUrl = null;

  let job: { status: string; jobId: number; targetPhotoId: number; targetUrl: string | null; maskUrl: null } | null = null;

  if (kindConfig.kind === 'target') {
    const createdJob = await createSwapJobForTarget(supabase, {
      photoColumn: identity.column,
      ownerId: identity.id,
      target: { id: insertedRow.id, storage_path: path.trim(), bucket: USER_PHOTOS_BUCKET },
    });

    // Fire-and-forget (see triggerPipeline's own doc comment) -- not awaited
    // so it can't add its own round-trip to this response's latency, which
    // the client is relying on to open the mask review modal immediately.
    triggerPipeline();

    if (createdJob) {
      // Reuses the moderation signed URL rather than minting a fresh one --
      // it's only needed for the mask review modal's initial image load,
      // which happens well within its 5-minute TTL.
      job = { status: 'mask_review', jobId: createdJob.jobId, targetPhotoId: insertedRow.id, targetUrl: signedUrlData.signedUrl, maskUrl: null };
    }
  }

  return res.status(200).json({ ok: true, maskUrl, targetPhotoId: insertedRow.id, job });
};
