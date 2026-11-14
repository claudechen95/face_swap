/**
 * The admin pipeline's global Ideogram character-reference photo + its
 * optional paint mask -- one pair, reused across every project until
 * replaced. Storage-backed replacement for face_swap/server/characterReference.ts's
 * local files.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ADMIN_PIPELINE_BUCKET, REFERENCE_PREFIX } from './constants.js';

export const CHARACTER_REFERENCE_PATH = `${REFERENCE_PREFIX}/character_reference.jpg`;
export const CHARACTER_REFERENCE_MASK_PATH = `${REFERENCE_PREFIX}/character_reference_mask.png`;

async function exists(supabase: SupabaseClient, path: string): Promise<boolean> {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  const { data, error } = await supabase.storage.from(ADMIN_PIPELINE_BUCKET).list(dir, { search: name });
  if (error) throw error;
  return (data ?? []).some((entry) => entry.name === name);
}

export async function characterReferenceStatus(supabase: SupabaseClient): Promise<{ hasReference: boolean; hasReferenceMask: boolean }> {
  const [hasReference, hasReferenceMask] = await Promise.all([
    exists(supabase, CHARACTER_REFERENCE_PATH),
    exists(supabase, CHARACTER_REFERENCE_MASK_PATH),
  ]);
  return { hasReference, hasReferenceMask };
}

// Unlike the local tool's byte-compare-to-preserve-mask optimization (which
// needs a full download to compare), every reference replace here simply
// clears the mask -- a deliberate simplification, flagged in the plan.
export async function clearReferenceMask(supabase: SupabaseClient): Promise<void> {
  await supabase.storage.from(ADMIN_PIPELINE_BUCKET).remove([CHARACTER_REFERENCE_MASK_PATH]);
}
