import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { runIdeogramSwap, downloadIdeogramResult, IDEOGRAM_CHARACTER_PROMPT } from 'shared/server';
import { resolveIdentity, resolveKind, MAX_REGENERATES } from './_lib/identity.js';
import { createSwapJobForTarget } from './_lib/swapJob.js';
import { signGrouped } from './_lib/signStorage.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { USER_PHOTOS_BUCKET, SWAP_LIBRARY_BUCKET, type Identity } from './_lib/constants.js';

const SIGNED_URL_TTL = 3600;

// Folded into this file (rather than separate api/feedback.ts and
// api/regenerate.ts) because Vercel's Hobby plan caps a deployment at 12
// Serverless Functions and this project was already at that cap -- same
// action-routing pattern as api/admin-action.ts and api/stripe.ts.
async function handleFeedback(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient, identity: Identity) {
  const { targetPhotoId, liked, comment } = req.body || {};
  if (!Number.isInteger(targetPhotoId)) {
    return sendError(res, 400, 'targetPhotoId (integer) is required');
  }

  // liked and comment are independent -- an edit request can be submitted
  // without touching the thumbs up/down state, and vice versa -- so only one
  // of the two needs to be present, and whichever is omitted is left as-is
  // (not overwritten) on an existing row via the upsert below.
  const hasLiked = typeof liked === 'boolean';
  const trimmedComment = typeof comment === 'string' ? comment.trim().slice(0, 1000) : '';
  const hasComment = trimmedComment.length > 0;
  if (!hasLiked && !hasComment) {
    return sendError(res, 400, 'liked (boolean) or comment (string) is required');
  }

  const { data: photo, error: photoError } = await supabase
    .from('uploaded_photos')
    .select('id')
    .eq('id', targetPhotoId)
    .eq(identity.column, identity.id)
    .eq('kind', 'target')
    .maybeSingle();

  if (photoError) {
    console.error('uploaded_photos lookup failed', photoError);
    return sendError(res, 500, 'Could not save feedback');
  }
  if (!photo) {
    return sendError(res, 404, 'Photo not found');
  }

  const payload: Record<string, unknown> = { target_photo_id: targetPhotoId, [identity.column]: identity.id };
  if (hasLiked) payload.liked = liked;
  if (hasComment) payload.comment = trimmedComment;

  const { error: upsertError } = await supabase.from('swap_feedback').upsert(payload, { onConflict: 'target_photo_id' });

  if (upsertError) {
    console.error('swap_feedback upsert failed', upsertError);
    return sendError(res, 500, 'Could not save feedback');
  }

  if (hasComment) {
    const { NTFY_TOPIC } = process.env;
    if (NTFY_TOPIC) {
      const table = identity.column === 'user_id' ? 'profiles' : 'submissions';
      const { data: owner } = await supabase.from(table).select('name').eq('id', identity.id).maybeSingle();
      const who = (owner && owner.name) || 'A customer';
      try {
        await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
          method: 'POST',
          headers: { Title: 'Edit requested', Tags: 'pencil2', Click: 'https://faceswap.fit/admin' },
          body: `${who} wants a change to photo #${targetPhotoId}:\n${trimmedComment}`.slice(0, 1000),
        });
      } catch (err) {
        console.error('ntfy notify failed', err);
      }
    }
  }

  return res.status(200).json({ ok: true });
}

async function handleRegenerate(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient, identity: Identity) {
  const { targetPhotoId } = req.body || {};
  if (!Number.isInteger(targetPhotoId)) {
    return sendError(res, 400, 'targetPhotoId (integer) is required');
  }

  const { data: photo, error: photoError } = await supabase
    .from('uploaded_photos')
    .select('id, storage_path, bucket')
    .eq('id', targetPhotoId)
    .eq(identity.column, identity.id)
    .eq('kind', 'target')
    .maybeSingle();

  if (photoError) {
    console.error('uploaded_photos lookup failed', photoError);
    return sendError(res, 500, 'Could not start regenerate');
  }
  if (!photo) {
    return sendError(res, 404, 'Photo not found');
  }

  const { data: job, error: jobError } = await supabase
    .from('swap_jobs')
    .select('id, status')
    .eq('target_photo_id', targetPhotoId)
    .maybeSingle();

  if (jobError) {
    console.error('swap_jobs lookup failed', jobError);
    return sendError(res, 500, 'Could not start regenerate');
  }
  if (!job) {
    return sendError(res, 400, "This photo hasn't finished its first swap yet");
  }
  if (job.status === 'processing' || job.status === 'mask_review') {
    return sendError(res, 400, 'Still processing -- try again once it finishes');
  }

  // Atomic cap check + increment -- returns no rows if the cap was already
  // hit, so two near-simultaneous clicks on the same photo can't both slip
  // through the limit on regeneration cost.
  const { data: claimed, error: claimError } = await supabase.rpc('claim_regenerate', {
    p_target_photo_id: targetPhotoId,
    p_max: MAX_REGENERATES,
  });

  if (claimError) {
    console.error('claim_regenerate failed', claimError);
    return sendError(res, 500, 'Could not start regenerate');
  }
  if (!claimed || !claimed.length) {
    return sendError(res, 400, "You've reached the regenerate limit for this photo");
  }

  // Deleting the job and recreating it fresh in mask_review (rather than just
  // resetting its status) clears the stale result/mask/error from the last
  // attempt the same way a brand-new target selection starts clean. Feedback
  // is cleared too since it described the now-deleted result, not whatever
  // comes next.
  const [{ error: deleteJobError }, { error: deleteFeedbackError }] = await Promise.all([
    supabase.from('swap_jobs').delete().eq('id', job.id),
    supabase.from('swap_feedback').delete().eq('target_photo_id', targetPhotoId),
  ]);

  if (deleteJobError) {
    console.error('swap_jobs delete failed', deleteJobError);
    return sendError(res, 500, 'Could not start regenerate');
  }
  if (deleteFeedbackError) console.error('swap_feedback delete failed', deleteFeedbackError);

  const newJob = await createSwapJobForTarget(supabase, {
    photoColumn: identity.column,
    ownerId: identity.id,
    target: { id: photo.id, storage_path: photo.storage_path, bucket: photo.bucket },
  });
  if (!newJob) {
    return sendError(res, 500, 'Could not start regenerate');
  }

  // Same two shapes results-init's other job-returning actions use: a public
  // getPublicUrl for the library bucket, a signed URL for a self-uploaded
  // target -- the client needs this to open the mask review modal immediately
  // (see requestRegenerate/upload.ts), same as a brand-new target selection.
  const targetUrl =
    photo.bucket === SWAP_LIBRARY_BUCKET
      ? supabase.storage.from(SWAP_LIBRARY_BUCKET).getPublicUrl(photo.storage_path).data.publicUrl
      : (await supabase.storage.from(photo.bucket).createSignedUrl(photo.storage_path, SIGNED_URL_TTL)).data?.signedUrl || null;

  return res.status(200).json({
    ok: true,
    regenerateCount: claimed[0].regenerate_count,
    job: { status: 'mask_review', jobId: newJob.jobId, targetPhotoId: photo.id, targetUrl, maskUrl: null },
  });
}

async function handleSaveFaceMask(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient, identity: Identity) {
  const { maskDataUrl } = req.body || {};
  const MASK_PREFIX = 'data:image/png;base64,';
  if (typeof maskDataUrl !== 'string' || !maskDataUrl.startsWith(MASK_PREFIX)) {
    return sendError(res, 400, 'maskDataUrl (PNG data URL) is required');
  }

  const { data: facePhoto, error: faceError } = await supabase
    .from('uploaded_photos')
    .select('id, mask_storage_path')
    .eq(identity.column, identity.id)
    .eq('kind', 'face')
    .maybeSingle();

  if (faceError) {
    console.error('uploaded_photos (face) lookup failed', faceError);
    return sendError(res, 500, 'Could not save mask');
  }
  if (!facePhoto) {
    return sendError(res, 400, 'Upload your face photo first');
  }

  // Falls back to the same canonical path upload-confirm.ts would have used
  // -- only reachable if the auto-mask build failed there, in which case
  // this is the user's first-ever mask for this photo, painted from scratch.
  const maskPath = facePhoto.mask_storage_path || `${identity.storagePrefix}/face_mask.png`;
  const maskBuffer = Buffer.from(maskDataUrl.slice(MASK_PREFIX.length), 'base64');

  const { error: uploadError } = await supabase.storage.from(USER_PHOTOS_BUCKET).upload(maskPath, maskBuffer, { contentType: 'image/png', upsert: true });
  if (uploadError) {
    console.error('face mask upload failed', uploadError);
    return sendError(res, 502, 'Could not save mask');
  }

  const { error: updateError } = await supabase
    .from('uploaded_photos')
    .update({ mask_storage_path: maskPath, mask_reviewed_at: new Date().toISOString() })
    .eq('id', facePhoto.id);
  if (updateError) {
    console.error('uploaded_photos (face) mask update failed', updateError);
    return sendError(res, 502, 'Could not save mask');
  }

  return res.status(200).json({ ok: true });
}

// Runs the actual Ideogram swap synchronously (POST + poll, up to ~120s --
// vercel.json needs a raised maxDuration on this file for that). This used
// to be an admin-only action (admin-action.js's handleApproveSwap); now the
// customer runs it themselves after reviewing their own masks, so every
// lookup below is scoped to the caller's own identity rather than trusting
// the job's owner column directly.
async function handleApproveSwap(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient, identity: Identity) {
  const { jobId, maskDataUrl, instructions } = req.body || {};
  const MASK_PREFIX = 'data:image/png;base64,';
  if (!Number.isInteger(jobId)) {
    return sendError(res, 400, 'jobId (integer) is required');
  }
  if (typeof maskDataUrl !== 'string' || !maskDataUrl.startsWith(MASK_PREFIX)) {
    return sendError(res, 400, 'maskDataUrl (PNG data URL) is required');
  }
  // Optional free-text steer for things the mask alone can't express, e.g.
  // "look toward the camera" or "turn head slightly left" -- appended to the
  // fixed prompt rather than replacing it, so the core identity/background
  // preservation instructions always still apply. Length-capped since this
  // goes straight into a model prompt the customer controls.
  const customInstructions = typeof instructions === 'string' ? instructions.trim().slice(0, 300) : '';

  const { data: job, error: jobError } = await supabase
    .from('swap_jobs')
    .select('id, submission_id, user_id, target_photo_id, mask_storage_path, status')
    .eq('id', jobId)
    .maybeSingle();

  if (jobError) {
    console.error('approve-swap job lookup failed', jobError);
    return sendError(res, 500, 'Could not load job');
  }
  if (!job || (job as Record<string, unknown>)[identity.column] !== identity.id) {
    return sendError(res, 404, 'Job not found');
  }
  if (job.status !== 'mask_review') {
    return sendError(res, 400, 'This job is not awaiting mask review');
  }

  const [targetResult, faceResult] = await Promise.all([
    supabase.from('uploaded_photos').select('storage_path, bucket').eq('id', job.target_photo_id).maybeSingle(),
    // Read live, not a job-created-time snapshot -- a job created before the
    // owner's most recent face photo/mask edit must still swap with whatever
    // they currently have on file, not whatever existed when they added this
    // target.
    supabase.from('uploaded_photos').select('storage_path, bucket, mask_storage_path').eq(identity.column, identity.id).eq('kind', 'face').maybeSingle(),
  ]);
  if (targetResult.error || !targetResult.data) return sendError(res, 500, 'Could not load target photo');
  if (faceResult.error || !faceResult.data) return sendError(res, 500, 'Could not load reference photo');
  // Mandatory, not best-effort -- an un-isolated reference photo (background,
  // body, clothing all still in frame) gives Ideogram's character-reference
  // model no signal for which region is the identity to extract, which is a
  // much more likely explanation for a swap landing on the wrong person than
  // anything downstream. hasReviewedFaceMask already gates target selection
  // on this same condition, so this should only ever trip on the edge case
  // of a face photo replaced between selecting a target and approving it.
  if (!faceResult.data.mask_storage_path) {
    return sendError(res, 400, 'Please review your face mask before approving a swap');
  }

  const maskBuffer = Buffer.from(maskDataUrl.slice(MASK_PREFIX.length), 'base64');
  const { error: maskUploadError } = await supabase.storage.from(USER_PHOTOS_BUCKET).upload(job.mask_storage_path, maskBuffer, { contentType: 'image/png', upsert: true });
  if (maskUploadError) {
    console.error('approve-swap mask upload failed', maskUploadError);
    return sendError(res, 502, 'Could not save the edited mask');
  }

  // Flipped before the slow Ideogram call below (not just at the very end)
  // so the client's results grid -- which the mask review modal closes into
  // immediately rather than blocking on this request -- shows "Processing"
  // for the whole duration instead of a stale "mask_review" state.
  // processing_started_at is its own column (not reused from created_at/
  // updated_at) because both of those mean something else: created_at is
  // whenever the target was first picked (hours earlier, if the customer
  // took their time reviewing the mask), and updated_at gets overwritten
  // again at done/failed -- neither survives as "when did the real swap
  // work begin", which is what the fake progress bar below needs to compute
  // elapsed time against, including correctly across a page reload.
  const { error: processingUpdateError } = await supabase
    .from('swap_jobs')
    .update({ status: 'processing', processing_started_at: new Date().toISOString() })
    .eq('id', jobId);
  if (processingUpdateError) console.error('approve-swap processing status update failed', processingUpdateError);

  // Target photos can live in 'user-photos' (self-uploaded) or 'swap-library'
  // (picked from the free-preview library, see library.ts) -- the face
  // reference is always self-uploaded, so always 'user-photos'.
  const [targetDownload, faceDownload, faceMaskDownload] = await Promise.all([
    supabase.storage.from(targetResult.data.bucket).download(targetResult.data.storage_path),
    supabase.storage.from(faceResult.data.bucket).download(faceResult.data.storage_path),
    supabase.storage.from(USER_PHOTOS_BUCKET).download(faceResult.data.mask_storage_path),
  ]);
  if (targetDownload.error || faceDownload.error || faceMaskDownload.error) {
    console.error('approve-swap photo download failed', targetDownload.error || faceDownload.error || faceMaskDownload.error);
    return sendError(res, 502, 'Could not load photos');
  }

  try {
    // .rotate() with no args bakes in the file's own EXIF orientation and
    // strips the tag -- a phone-uploaded photo's raw bytes are frequently
    // stored sideways/upside-down relative to how it displays (EXIF-aware
    // viewers, and the browser <img>/canvas the mask was painted against,
    // auto-rotate for display; a raw storage download does not). Sending
    // Ideogram the un-rotated buffer while the mask was drawn against the
    // rotated display is a mismatch that alone can explain a wrong-identity
    // result, independent of anything about the reference photo's content.
    const [targetBuffer, referenceBuffer] = await Promise.all([
      sharp(Buffer.from(await targetDownload.data.arrayBuffer())).rotate().toBuffer(),
      sharp(Buffer.from(await faceDownload.data.arrayBuffer())).rotate().toBuffer(),
    ]);
    const prompt = customInstructions ? `${IDEOGRAM_CHARACTER_PROMPT} Additional direction from the customer: ${customInstructions}` : undefined;
    const [resultUrl] = await runIdeogramSwap({
      targetBuffer,
      maskBuffer,
      referenceBuffer,
      referenceMaskBuffer: Buffer.from(await faceMaskDownload.data.arrayBuffer()),
      prompt,
    });
    if (!resultUrl) throw new Error('Ideogram returned no result images');
    const resultBuffer = await downloadIdeogramResult(resultUrl);

    const resultPath = `${identity.storagePrefix}/results/${job.target_photo_id}.jpg`;
    const { error: resultUploadError } = await supabase.storage.from(USER_PHOTOS_BUCKET).upload(resultPath, resultBuffer, { contentType: 'image/jpeg', upsert: true });
    if (resultUploadError) throw resultUploadError;

    const { error: updateError } = await supabase.from('swap_jobs').update({ status: 'done', result_storage_path: resultPath, error: null }).eq('id', jobId);
    if (updateError) throw updateError;

    const { data: signed } = await supabase.storage.from(USER_PHOTOS_BUCKET).createSignedUrl(resultPath, SIGNED_URL_TTL);
    return res.status(200).json({ ok: true, status: 'done', resultUrl: signed ? signed.signedUrl : null });
  } catch (err) {
    console.error('Ideogram swap failed', err);
    await supabase.from('swap_jobs').update({ status: 'failed', error: String((err as Error)?.message || err) }).eq('id', jobId);
    return res.status(200).json({ ok: true, status: 'failed', error: String((err as Error)?.message || err) });
  }
}

async function handleInit(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient, identity: Identity) {
  const table = identity.column === 'user_id' ? 'profiles' : 'submissions';
  const ownerSelect = table === 'profiles' ? 'name, paid_at, referral_code' : 'name, paid_at';

  const [ownerResult, jobsResult, photosResult, feedbackResult] = await Promise.all([
    supabase.from(table).select(ownerSelect).eq('id', identity.id).maybeSingle(),
    supabase
      .from('swap_jobs')
      .select('id, target_photo_id, status, result_storage_path, error, created_at, mask_storage_path, processing_started_at')
      .eq(identity.column, identity.id)
      .order('created_at', { ascending: true }),
    supabase.from('uploaded_photos').select('id, kind, regenerate_count, storage_path, bucket, mask_storage_path').eq(identity.column, identity.id),
    supabase.from('swap_feedback').select('target_photo_id, liked, comment').eq(identity.column, identity.id),
  ]);

  if (ownerResult.error || !ownerResult.data) {
    console.error('Owner lookup failed', ownerResult.error);
    return sendError(res, 500, 'Could not verify link');
  }
  if (jobsResult.error) {
    console.error('swap_jobs lookup failed', jobsResult.error);
    return sendError(res, 500, 'Could not verify link');
  }
  if (photosResult.error) {
    console.error('uploaded_photos lookup failed', photosResult.error);
    return sendError(res, 500, 'Could not verify link');
  }
  if (feedbackResult.error) {
    console.error('swap_feedback lookup failed', feedbackResult.error);
    return sendError(res, 500, 'Could not verify link');
  }

  const owner = ownerResult.data as unknown as { name: string; paid_at: string | null; referral_code?: string };
  const paid = Boolean(owner.paid_at);
  const jobRows = jobsResult.data;
  const faceUploaded = photosResult.data.filter((row) => row.kind === 'face').length;
  const targetPhotos = photosResult.data.filter((row) => row.kind === 'target');
  const targetUploaded = targetPhotos.length;
  const regenerateCountByTarget = Object.fromEntries(targetPhotos.map((p) => [p.id, p.regenerate_count]));
  const likedByTarget = Object.fromEntries(feedbackResult.data.map((f) => [f.target_photo_id, f.liked]));
  const commentByTarget = Object.fromEntries(feedbackResult.data.map((f) => [f.target_photo_id, f.comment]));

  const donePaths = jobRows.filter((j) => j.status === 'done' && j.result_storage_path).map((j) => j.result_storage_path as string);
  let previewByPath: Record<string, string | null> = {};
  let downloadByPath: Record<string, string | null> = {};
  if (donePaths.length) {
    // No paywall for now -- download URLs (which set Content-Disposition:
    // attachment so the browser actually saves the file instead of
    // navigating to it) are issued unconditionally, same as preview URLs.
    // download: true adds that header to Supabase's response -- without it,
    // the <a download> attribute is silently ignored for cross-origin URLs
    // (storage lives on a different origin than the app) and clicking
    // "Download" just navigates to the image instead of saving it.
    const [previewResult, downloadResult] = await Promise.all([
      supabase.storage.from(USER_PHOTOS_BUCKET).createSignedUrls(donePaths, SIGNED_URL_TTL),
      supabase.storage.from(USER_PHOTOS_BUCKET).createSignedUrls(donePaths, SIGNED_URL_TTL, { download: 'better-hello-studio-swap.jpg' }),
    ]);

    if (previewResult.error) {
      console.error('createSignedUrls (preview) failed', previewResult.error);
      return sendError(res, 500, 'Could not verify link');
    }
    if (downloadResult.error) {
      console.error('createSignedUrls (download) failed', downloadResult.error);
      return sendError(res, 500, 'Could not verify link');
    }

    previewByPath = Object.fromEntries(donePaths.map((path, i) => [path, previewResult.data[i]!.signedUrl]));
    downloadByPath = Object.fromEntries(donePaths.map((path, i) => [path, downloadResult.data[i]!.signedUrl]));
  }

  // A target photo has no swap_jobs row at all until the pipeline actually
  // picks it up -- without a placeholder, a freshly-chosen photo would show
  // no card whatsoever.
  const targetIdsWithJobs = new Set(jobRows.map((j) => j.target_photo_id));
  const queuedCount = targetPhotos.filter((photo) => !targetIdsWithJobs.has(photo.id)).length;

  // mask_review jobs need their target photo and target mask signed so the
  // customer's own review/approve modal (see upload.ts's target-mask editor)
  // can load them -- unlike done/needs_review jobs above, this status is now
  // truthfully surfaced as the customer's own action, not relabeled away as
  // an internal admin step. The face photo/mask aren't shown here -- they're
  // reviewed/approved right after upload instead (see openFaceMaskModal).
  const targetPhotoById = Object.fromEntries(targetPhotos.map((p) => [p.id, p]));
  const maskReviewJobs = jobRows.filter((j) => j.status === 'mask_review');

  // processing jobs also need their target photo signed -- the results grid
  // shows which photo is mid-swap (see renderJobs in upload.ts) rather than
  // a bare status badge, since Ideogram's API exposes no progress percentage
  // to show instead (see shared/src/ideogram.ts).
  const processingJobs = jobRows.filter((j) => j.status === 'processing');

  let maskReviewUrlByKey: Record<string, string> = {};
  if (maskReviewJobs.length || processingJobs.length) {
    try {
      maskReviewUrlByKey = await signGrouped(
        supabase,
        [
          ...maskReviewJobs
            .map((j) => targetPhotoById[j.target_photo_id])
            .filter(Boolean)
            .map((t) => ({ bucket: t!.bucket as string, path: t!.storage_path })),
          ...maskReviewJobs.map((j) => ({ bucket: USER_PHOTOS_BUCKET, path: j.mask_storage_path as string })),
          ...processingJobs
            .map((j) => targetPhotoById[j.target_photo_id])
            .filter(Boolean)
            .map((t) => ({ bucket: t!.bucket as string, path: t!.storage_path })),
        ],
        SIGNED_URL_TTL
      );
    } catch (signError) {
      console.error('mask_review/processing sign failed', signError);
    }
  }

  const jobs = [
    // needs_review jobs do have a result_storage_path (the pipeline uploads
    // its last rejected attempt so an admin has something to look at), but
    // it's deliberately never signed/exposed here -- the whole point of that
    // status is that our own quality bar rejected it, so it shouldn't reach
    // the customer until a human overrides that.
    ...jobRows.map((j) => {
      const target = targetPhotoById[j.target_photo_id];
      return {
        status: j.status,
        url: j.status === 'done' && j.result_storage_path ? previewByPath[j.result_storage_path] : null,
        downloadUrl: j.status === 'done' && j.result_storage_path ? downloadByPath[j.result_storage_path] || null : null,
        targetPhotoId: j.target_photo_id,
        liked: j.target_photo_id in likedByTarget ? likedByTarget[j.target_photo_id] : null,
        comment: commentByTarget[j.target_photo_id] || null,
        regenerateCount: regenerateCountByTarget[j.target_photo_id] ?? 0,
        ...(j.status === 'mask_review'
          ? {
              jobId: j.id,
              targetUrl: target ? maskReviewUrlByKey[`${target.bucket}::${target.storage_path}`] || null : null,
              maskUrl: maskReviewUrlByKey[`${USER_PHOTOS_BUCKET}::${j.mask_storage_path}`] || null,
            }
          : {}),
        ...(j.status === 'processing'
          ? {
              targetUrl: target ? maskReviewUrlByKey[`${target.bucket}::${target.storage_path}`] || null : null,
              processingStartedAt: j.processing_started_at,
            }
          : {}),
      };
    }),
    ...Array.from({ length: queuedCount }, () => ({ status: 'queued', url: null })),
  ];

  const faceKindConfig = resolveKind({ kind: 'face' })!;
  const targetKindConfig = resolveKind({ kind: 'target' })!;

  return res.status(200).json({
    name: owner.name,
    paid,
    jobs,
    counts: {
      done: jobs.filter((j) => j.status === 'done').length,
      processing: jobs.filter((j) => j.status === 'processing').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
      needsReview: jobs.filter((j) => j.status === 'needs_review').length,
      queued: queuedCount,
    },
    face: { uploaded: faceUploaded, min: faceKindConfig.min },
    target: { uploaded: targetUploaded, max: targetKindConfig.max },
    referralCode: table === 'profiles' ? owner.referral_code : null,
    regenerateCap: MAX_REGENERATES,
  });
}

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Method not allowed');
  }

  const supabase = getSupabaseClient(res);
  if (!supabase) return;
  const identity = await resolveIdentity(req, supabase);
  if (!identity) {
    return sendError(res, 404, 'This upload link is invalid');
  }

  const { action } = req.body || {};
  if (action === 'feedback') return handleFeedback(req, res, supabase, identity);
  if (action === 'regenerate') return handleRegenerate(req, res, supabase, identity);
  if (action === 'save-face-mask') return handleSaveFaceMask(req, res, supabase, identity);
  if (action === 'approve-swap') return handleApproveSwap(req, res, supabase, identity);
  return handleInit(req, res, supabase, identity);
};
