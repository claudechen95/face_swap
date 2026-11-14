import type { SupabaseClient } from '@supabase/supabase-js';

interface CreateSwapJobParams {
  photoColumn: 'user_id' | 'submission_id';
  ownerId: string | number;
  target: { id: number; storage_path: string; bucket: string };
}

// Inserts the swap_jobs row that puts a target photo in mask_review -- the
// state that unlocks the end user's own review/approve modal (see
// results-init.ts's approve-swap action). Called synchronously right when a
// target photo is added (self-uploaded in upload-confirm.ts, or picked from
// the library in library.ts), not lazily by an admin's button click.
//
// The target's own mask_storage_path is set here but left unpopulated --
// upload.ts computes a fresh MediaPipe auto-mask client-side the first time
// the review modal opens (see computeAutoMaskCanvas) and uploads it to this
// same path on approve, so there's always somewhere valid for that to land.
//
// The face reference photo/mask are deliberately NOT snapshotted here --
// approve-swap reads the owner's face photo and mask live, at approve time,
// so a job created before the owner's most recent face edit still swaps
// with whatever they currently have on file instead of a stale copy.
export async function createSwapJobForTarget(
  supabase: SupabaseClient,
  { photoColumn, ownerId, target }: CreateSwapJobParams
): Promise<{ jobId: number } | null> {
  const storagePrefix = String(ownerId);
  const maskPath = `${storagePrefix}/masks/${target.id}.png`;

  const { data, error: insertError } = await supabase
    .from('swap_jobs')
    .insert({
      target_photo_id: target.id,
      status: 'mask_review',
      mask_storage_path: maskPath,
      [photoColumn]: ownerId,
    })
    .select('id')
    .single();
  if (insertError) {
    console.error(`createSwapJobForTarget swap_jobs insert failed for target photo ${target.id}`, insertError);
    return null;
  }
  return { jobId: data.id };
}
