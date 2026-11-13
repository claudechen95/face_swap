const { createClient } = require('@supabase/supabase-js');
const { resolveIdentity, resolveKind, MAX_REGENERATES } = require('./_lib/identity');
const { triggerPipeline } = require('./_lib/triggerPipeline');
const { runIdeogramSwap } = require('./_lib/ideogram');
const { signGrouped } = require('./_lib/signStorage');

const BUCKET = 'user-photos';
const SIGNED_URL_TTL = 3600;

// Folded into this file (rather than separate api/feedback.js and
// api/regenerate.js) because Vercel's Hobby plan caps a deployment at 12
// Serverless Functions and this project was already at that cap -- same
// action-routing pattern as api/admin-action.js and api/stripe.js.
async function handleFeedback(req, res, supabase, identity) {
  const { targetPhotoId, liked, comment } = req.body || {};
  if (!Number.isInteger(targetPhotoId)) {
    return res.status(400).json({ error: 'targetPhotoId (integer) is required' });
  }

  // liked and comment are independent -- an edit request can be submitted
  // without touching the thumbs up/down state, and vice versa -- so only one
  // of the two needs to be present, and whichever is omitted is left as-is
  // (not overwritten) on an existing row via the upsert below.
  const hasLiked = typeof liked === 'boolean';
  const trimmedComment = typeof comment === 'string' ? comment.trim().slice(0, 1000) : '';
  const hasComment = trimmedComment.length > 0;
  if (!hasLiked && !hasComment) {
    return res.status(400).json({ error: 'liked (boolean) or comment (string) is required' });
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
    return res.status(500).json({ error: 'Could not save feedback' });
  }
  if (!photo) {
    return res.status(404).json({ error: 'Photo not found' });
  }

  const payload = { target_photo_id: targetPhotoId, [identity.column]: identity.id };
  if (hasLiked) payload.liked = liked;
  if (hasComment) payload.comment = trimmedComment;

  const { error: upsertError } = await supabase
    .from('swap_feedback')
    .upsert(payload, { onConflict: 'target_photo_id' });

  if (upsertError) {
    console.error('swap_feedback upsert failed', upsertError);
    return res.status(500).json({ error: 'Could not save feedback' });
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

async function handleRegenerate(req, res, supabase, identity) {
  const { targetPhotoId } = req.body || {};
  if (!Number.isInteger(targetPhotoId)) {
    return res.status(400).json({ error: 'targetPhotoId (integer) is required' });
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
    return res.status(500).json({ error: 'Could not start regenerate' });
  }
  if (!photo) {
    return res.status(404).json({ error: 'Photo not found' });
  }

  const { data: job, error: jobError } = await supabase
    .from('swap_jobs')
    .select('id, status')
    .eq('target_photo_id', targetPhotoId)
    .maybeSingle();

  if (jobError) {
    console.error('swap_jobs lookup failed', jobError);
    return res.status(500).json({ error: 'Could not start regenerate' });
  }
  if (!job) {
    return res.status(400).json({ error: "This photo hasn't finished its first swap yet" });
  }
  if (job.status === 'processing' || job.status === 'mask_review') {
    return res.status(400).json({ error: 'Still processing -- try again once it finishes' });
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
    return res.status(500).json({ error: 'Could not start regenerate' });
  }
  if (!claimed || !claimed.length) {
    return res.status(400).json({ error: "You've reached the regenerate limit for this photo" });
  }

  // Deleting the job (rather than resetting its status) is what makes the
  // pipeline's "needs swap" check pick this target photo back up on its next
  // cycle -- see list_leads_ready_to_swap() in the face_swap repo, which only
  // looks for target photos with no swap_jobs row at all. Feedback is cleared
  // too since it described the now-deleted result, not whatever comes next.
  const [{ error: deleteJobError }, { error: deleteFeedbackError }] = await Promise.all([
    supabase.from('swap_jobs').delete().eq('id', job.id),
    supabase.from('swap_feedback').delete().eq('target_photo_id', targetPhotoId),
  ]);

  if (deleteJobError) {
    console.error('swap_jobs delete failed', deleteJobError);
    return res.status(500).json({ error: 'Could not start regenerate' });
  }
  if (deleteFeedbackError) console.error('swap_feedback delete failed', deleteFeedbackError);

  await triggerPipeline();

  return res.status(200).json({ ok: true, regenerateCount: claimed[0].regenerate_count });
}

async function handleSaveFaceMask(req, res, supabase, identity) {
  const { maskDataUrl } = req.body || {};
  const MASK_PREFIX = 'data:image/png;base64,';
  if (typeof maskDataUrl !== 'string' || !maskDataUrl.startsWith(MASK_PREFIX)) {
    return res.status(400).json({ error: 'maskDataUrl (PNG data URL) is required' });
  }

  const { data: facePhoto, error: faceError } = await supabase
    .from('uploaded_photos')
    .select('id, mask_storage_path')
    .eq(identity.column, identity.id)
    .eq('kind', 'face')
    .maybeSingle();

  if (faceError) {
    console.error('uploaded_photos (face) lookup failed', faceError);
    return res.status(500).json({ error: 'Could not save mask' });
  }
  if (!facePhoto) {
    return res.status(400).json({ error: 'Upload your face photo first' });
  }

  // Falls back to the same canonical path upload-confirm.js would have used
  // -- only reachable if the auto-mask build failed there, in which case
  // this is the user's first-ever mask for this photo, painted from scratch.
  const maskPath = facePhoto.mask_storage_path || `${identity.storagePrefix}/face_mask.png`;
  const maskBuffer = Buffer.from(maskDataUrl.slice(MASK_PREFIX.length), 'base64');

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(maskPath, maskBuffer, { contentType: 'image/png', upsert: true });
  if (uploadError) {
    console.error('face mask upload failed', uploadError);
    return res.status(502).json({ error: 'Could not save mask' });
  }

  const { error: updateError } = await supabase
    .from('uploaded_photos')
    .update({ mask_storage_path: maskPath, mask_reviewed_at: new Date().toISOString() })
    .eq('id', facePhoto.id);
  if (updateError) {
    console.error('uploaded_photos (face) mask update failed', updateError);
    return res.status(502).json({ error: 'Could not save mask' });
  }

  return res.status(200).json({ ok: true });
}

// Runs the actual Ideogram swap synchronously (POST + poll, up to ~120s --
// vercel.json needs a raised maxDuration on this file for that). This used
// to be an admin-only action (admin-action.js's handleApproveSwap); now the
// customer runs it themselves after reviewing their own masks, so every
// lookup below is scoped to the caller's own identity rather than trusting
// the job's owner column directly.
async function handleApproveSwap(req, res, supabase, identity) {
  const { jobId, maskDataUrl, referenceMaskDataUrl } = req.body || {};
  const MASK_PREFIX = 'data:image/png;base64,';
  if (!Number.isInteger(jobId)) {
    return res.status(400).json({ error: 'jobId (integer) is required' });
  }
  if (typeof maskDataUrl !== 'string' || !maskDataUrl.startsWith(MASK_PREFIX)) {
    return res.status(400).json({ error: 'maskDataUrl (PNG data URL) is required' });
  }
  if (referenceMaskDataUrl != null && (typeof referenceMaskDataUrl !== 'string' || !referenceMaskDataUrl.startsWith(MASK_PREFIX))) {
    return res.status(400).json({ error: 'referenceMaskDataUrl must be a PNG data URL' });
  }

  const { data: job, error: jobError } = await supabase
    .from('swap_jobs')
    .select('id, submission_id, user_id, target_photo_id, mask_storage_path, reference_mask_storage_path, status')
    .eq('id', jobId)
    .maybeSingle();

  if (jobError) {
    console.error('approve-swap job lookup failed', jobError);
    return res.status(500).json({ error: 'Could not load job' });
  }
  if (!job || job[identity.column] !== identity.id) {
    return res.status(404).json({ error: 'Job not found' });
  }
  if (job.status !== 'mask_review') {
    return res.status(400).json({ error: 'This job is not awaiting mask review' });
  }

  const [targetResult, faceResult] = await Promise.all([
    supabase.from('uploaded_photos').select('storage_path, bucket').eq('id', job.target_photo_id).maybeSingle(),
    supabase.from('uploaded_photos').select('storage_path, bucket').eq(identity.column, identity.id).eq('kind', 'face').maybeSingle(),
  ]);
  if (targetResult.error || !targetResult.data) return res.status(500).json({ error: 'Could not load target photo' });
  if (faceResult.error || !faceResult.data) return res.status(500).json({ error: 'Could not load reference photo' });

  const maskBuffer = Buffer.from(maskDataUrl.slice(MASK_PREFIX.length), 'base64');
  const { error: maskUploadError } = await supabase.storage.from(BUCKET).upload(job.mask_storage_path, maskBuffer, { contentType: 'image/png', upsert: true });
  if (maskUploadError) {
    console.error('approve-swap mask upload failed', maskUploadError);
    return res.status(502).json({ error: 'Could not save the edited mask' });
  }

  // Optional -- jobs where the auto-mask build failed have no
  // reference_mask_storage_path, in which case Ideogram just uses the whole
  // reference photo as the character.
  let referenceMaskBuffer = null;
  if (referenceMaskDataUrl && job.reference_mask_storage_path) {
    referenceMaskBuffer = Buffer.from(referenceMaskDataUrl.slice(MASK_PREFIX.length), 'base64');
    const { error: refMaskUploadError } = await supabase.storage
      .from(BUCKET)
      .upload(job.reference_mask_storage_path, referenceMaskBuffer, { contentType: 'image/png', upsert: true });
    if (refMaskUploadError) {
      console.error('approve-swap reference mask upload failed', refMaskUploadError);
      return res.status(502).json({ error: 'Could not save the edited reference mask' });
    }
  }

  // Target photos can live in 'user-photos' (self-uploaded) or 'swap-library'
  // (picked from the free-preview library, see library.js) -- the face
  // reference is always self-uploaded, so always 'user-photos'.
  const [targetDownload, faceDownload] = await Promise.all([
    supabase.storage.from(targetResult.data.bucket).download(targetResult.data.storage_path),
    supabase.storage.from(faceResult.data.bucket).download(faceResult.data.storage_path),
  ]);
  if (targetDownload.error || faceDownload.error) {
    console.error('approve-swap photo download failed', targetDownload.error || faceDownload.error);
    return res.status(502).json({ error: 'Could not load photos' });
  }

  try {
    const resultBuffer = await runIdeogramSwap({
      targetBuffer: Buffer.from(await targetDownload.data.arrayBuffer()),
      maskBuffer,
      referenceBuffer: Buffer.from(await faceDownload.data.arrayBuffer()),
      referenceMaskBuffer,
    });

    const resultPath = `${identity.storagePrefix}/results/${job.target_photo_id}.jpg`;
    const { error: resultUploadError } = await supabase.storage.from(BUCKET).upload(resultPath, resultBuffer, { contentType: 'image/jpeg', upsert: true });
    if (resultUploadError) throw resultUploadError;

    const { error: updateError } = await supabase.from('swap_jobs').update({ status: 'done', result_storage_path: resultPath, error: null }).eq('id', jobId);
    if (updateError) throw updateError;

    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(resultPath, SIGNED_URL_TTL);
    return res.status(200).json({ ok: true, status: 'done', resultUrl: signed ? signed.signedUrl : null });
  } catch (err) {
    console.error('Ideogram swap failed', err);
    await supabase.from('swap_jobs').update({ status: 'failed', error: String((err && err.message) || err) }).eq('id', jobId);
    return res.status(200).json({ ok: true, status: 'failed', error: String((err && err.message) || err) });
  }
}

async function handleInit(req, res, supabase, identity) {
  const table = identity.column === 'user_id' ? 'profiles' : 'submissions';
  const ownerSelect = table === 'profiles' ? 'name, paid_at, referral_code' : 'name, paid_at';

  const [ownerResult, jobsResult, photosResult, feedbackResult] = await Promise.all([
    supabase.from(table).select(ownerSelect).eq('id', identity.id).maybeSingle(),
    supabase
      .from('swap_jobs')
      .select('id, target_photo_id, status, result_storage_path, error, created_at, mask_storage_path, reference_mask_storage_path')
      .eq(identity.column, identity.id)
      .order('created_at', { ascending: true }),
    supabase.from('uploaded_photos').select('id, kind, regenerate_count, storage_path, bucket, mask_storage_path').eq(identity.column, identity.id),
    supabase.from('swap_feedback').select('target_photo_id, liked, comment').eq(identity.column, identity.id),
  ]);

  if (ownerResult.error || !ownerResult.data) {
    console.error('Owner lookup failed', ownerResult.error);
    return res.status(500).json({ error: 'Could not verify link' });
  }
  if (jobsResult.error) {
    console.error('swap_jobs lookup failed', jobsResult.error);
    return res.status(500).json({ error: 'Could not verify link' });
  }
  if (photosResult.error) {
    console.error('uploaded_photos lookup failed', photosResult.error);
    return res.status(500).json({ error: 'Could not verify link' });
  }
  if (feedbackResult.error) {
    console.error('swap_feedback lookup failed', feedbackResult.error);
    return res.status(500).json({ error: 'Could not verify link' });
  }

  const owner = ownerResult.data;
  const paid = Boolean(owner.paid_at);
  const jobRows = jobsResult.data;
  const faceUploaded = photosResult.data.filter((row) => row.kind === 'face').length;
  const targetPhotos = photosResult.data.filter((row) => row.kind === 'target');
  const targetUploaded = targetPhotos.length;
  const regenerateCountByTarget = Object.fromEntries(targetPhotos.map((p) => [p.id, p.regenerate_count]));
  const likedByTarget = Object.fromEntries(feedbackResult.data.map((f) => [f.target_photo_id, f.liked]));
  const commentByTarget = Object.fromEntries(feedbackResult.data.map((f) => [f.target_photo_id, f.comment]));

  const donePaths = jobRows.filter((j) => j.status === 'done' && j.result_storage_path).map((j) => j.result_storage_path);
  let previewByPath = {};
  let downloadByPath = {};
  if (donePaths.length) {
    // No paywall for now -- download URLs (which set Content-Disposition:
    // attachment so the browser actually saves the file instead of
    // navigating to it) are issued unconditionally, same as preview URLs.
    // download: true adds that header to Supabase's response -- without it,
    // the <a download> attribute is silently ignored for cross-origin URLs
    // (storage lives on a different origin than the app) and clicking
    // "Download" just navigates to the image instead of saving it.
    const [previewResult, downloadResult] = await Promise.all([
      supabase.storage.from(BUCKET).createSignedUrls(donePaths, SIGNED_URL_TTL),
      supabase.storage.from(BUCKET).createSignedUrls(donePaths, SIGNED_URL_TTL, { download: 'better-hello-studio-swap.jpg' }),
    ]);

    if (previewResult.error) {
      console.error('createSignedUrls (preview) failed', previewResult.error);
      return res.status(500).json({ error: 'Could not verify link' });
    }
    if (downloadResult.error) {
      console.error('createSignedUrls (download) failed', downloadResult.error);
      return res.status(500).json({ error: 'Could not verify link' });
    }

    previewByPath = Object.fromEntries(donePaths.map((path, i) => [path, previewResult.data[i].signedUrl]));
    downloadByPath = Object.fromEntries(donePaths.map((path, i) => [path, downloadResult.data[i].signedUrl]));
  }

  // A target photo has no swap_jobs row at all until the pipeline actually
  // picks it up -- without a placeholder, a freshly-chosen photo would show
  // no card whatsoever.
  const targetIdsWithJobs = new Set(jobRows.map((j) => j.target_photo_id));
  const queuedCount = targetPhotos.filter((photo) => !targetIdsWithJobs.has(photo.id)).length;

  // mask_review jobs need their target photo, target mask, face photo, and
  // face-mask copy all signed so the customer's own review/approve modal (see
  // upload.js's target-mask editor) can load them -- unlike done/needs_review
  // jobs above, this status is now truthfully surfaced as the customer's own
  // action, not relabeled away as an internal admin step.
  const targetPhotoById = Object.fromEntries(targetPhotos.map((p) => [p.id, p]));
  const facePhoto = photosResult.data.find((p) => p.kind === 'face');
  const maskReviewJobs = jobRows.filter((j) => j.status === 'mask_review');

  let maskReviewUrlByKey = {};
  if (maskReviewJobs.length && facePhoto) {
    try {
      maskReviewUrlByKey = await signGrouped(
        supabase,
        [
          ...maskReviewJobs.map((j) => targetPhotoById[j.target_photo_id]).filter(Boolean).map((t) => ({ bucket: t.bucket, path: t.storage_path })),
          ...maskReviewJobs.map((j) => ({ bucket: BUCKET, path: j.mask_storage_path })),
          ...maskReviewJobs.filter((j) => j.reference_mask_storage_path).map((j) => ({ bucket: BUCKET, path: j.reference_mask_storage_path })),
          { bucket: facePhoto.bucket, path: facePhoto.storage_path },
        ],
        SIGNED_URL_TTL
      );
    } catch (signError) {
      console.error('mask_review sign failed', signError);
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
              maskUrl: maskReviewUrlByKey[`${BUCKET}::${j.mask_storage_path}`] || null,
              referenceUrl: facePhoto ? maskReviewUrlByKey[`${facePhoto.bucket}::${facePhoto.storage_path}`] || null : null,
              referenceMaskUrl: j.reference_mask_storage_path ? maskReviewUrlByKey[`${BUCKET}::${j.reference_mask_storage_path}`] || null : null,
            }
          : {}),
      };
    }),
    ...Array.from({ length: queuedCount }, () => ({ status: 'queued', url: null })),
  ];

  const faceKindConfig = resolveKind({ kind: 'face' });
  const targetKindConfig = resolveKind({ kind: 'target' });

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

  const { action } = req.body || {};
  if (action === 'feedback') return handleFeedback(req, res, supabase, identity);
  if (action === 'regenerate') return handleRegenerate(req, res, supabase, identity);
  if (action === 'save-face-mask') return handleSaveFaceMask(req, res, supabase, identity);
  if (action === 'approve-swap') return handleApproveSwap(req, res, supabase, identity);
  return handleInit(req, res, supabase, identity);
};
