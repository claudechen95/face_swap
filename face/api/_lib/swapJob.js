const BUCKET = 'user-photos';

// Copies the owner's already-reviewed face mask for this target, then
// inserts the swap_jobs row that puts it in mask_review -- the state that
// unlocks the end user's own review/approve modal (see results-init.js's
// approve-swap action). Called synchronously right when a target photo is
// added (self-uploaded in upload-confirm.js, or picked from the library in
// library.js), not lazily by an admin's button click.
//
// The target's own mask_storage_path is set here but left unpopulated --
// upload.js computes a fresh MediaPipe auto-mask client-side the first time
// the review modal opens (see computeAutoMaskCanvas) and uploads it to this
// same path on approve, so there's always somewhere valid for that to land.
async function createSwapJobForTarget(supabase, { photoColumn, ownerId, target, faceMaskStoragePath }) {
  const storagePrefix = String(ownerId);
  const maskPath = `${storagePrefix}/masks/${target.id}.png`;

  let referenceMaskPath = null;
  if (faceMaskStoragePath) {
    const { data: faceMaskBlob, error: faceMaskDownloadError } = await supabase.storage.from(BUCKET).download(faceMaskStoragePath);
    if (faceMaskDownloadError) {
      console.error(`createSwapJobForTarget face mask download failed for target photo ${target.id}`, faceMaskDownloadError);
    } else {
      referenceMaskPath = `${storagePrefix}/reference_masks/${target.id}.png`;
      const referenceMaskBuffer = Buffer.from(await faceMaskBlob.arrayBuffer());
      const { error: refMaskUploadError } = await supabase.storage
        .from(BUCKET)
        .upload(referenceMaskPath, referenceMaskBuffer, { contentType: 'image/png', upsert: true });
      if (refMaskUploadError) {
        console.error(`createSwapJobForTarget reference mask upload failed for target photo ${target.id}`, refMaskUploadError);
        referenceMaskPath = null;
      }
    }
  }

  const { error: insertError } = await supabase.from('swap_jobs').insert({
    target_photo_id: target.id,
    status: 'mask_review',
    mask_storage_path: maskPath,
    reference_mask_storage_path: referenceMaskPath,
    [photoColumn]: ownerId,
  });
  if (insertError) console.error(`createSwapJobForTarget swap_jobs insert failed for target photo ${target.id}`, insertError);
}

module.exports = { createSwapJobForTarget };
