const { buildFaceMask } = require('./ideogram');

const BUCKET = 'user-photos';

// Builds a target photo's own mask plus a copy of the owner's already-reviewed
// face mask, then inserts the swap_jobs row that puts it in mask_review --
// the state that unlocks the end user's own review/approve modal (see
// results-init.js's approve-swap action). Called synchronously right when a
// target photo is added (self-uploaded in upload-confirm.js, or picked from
// the library in library.js), not lazily by an admin's button click.
//
// Always inserts the swap_jobs row, even if mask generation fails for either
// photo -- mask_storage_path is still the canonical destination the user's
// own painted mask will upload to on approve, so there's always somewhere
// valid for that to land; the review modal just opens with a blank canvas
// for whichever side's auto-mask didn't come through.
async function createSwapJobForTarget(supabase, { photoColumn, ownerId, target, faceMaskStoragePath }) {
  const storagePrefix = String(ownerId);
  const maskPath = `${storagePrefix}/masks/${target.id}.png`;

  const { data: targetBlob, error: downloadError } = await supabase.storage.from(target.bucket).download(target.storage_path);
  if (downloadError) {
    console.error(`createSwapJobForTarget download failed for target photo ${target.id}`, downloadError);
  } else {
    try {
      const maskBuffer = await buildFaceMask(Buffer.from(await targetBlob.arrayBuffer()));
      const { error: maskUploadError } = await supabase.storage.from(BUCKET).upload(maskPath, maskBuffer, { contentType: 'image/png', upsert: true });
      if (maskUploadError) console.error(`createSwapJobForTarget mask upload failed for target photo ${target.id}`, maskUploadError);
    } catch (err) {
      console.error(`createSwapJobForTarget buildFaceMask failed for target photo ${target.id}`, err);
    }
  }

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
