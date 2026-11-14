export const USER_PHOTOS_BUCKET = 'user-photos';
export const SWAP_LIBRARY_BUCKET = 'swap-library';

// Admin-only bulk crop/upscale/mask/Ideogram-swap tool (formerly the
// standalone local face_swap/ tool) -- separate bucket from the live
// customer flow's USER_PHOTOS_BUCKET since this holds internal test/admin
// content with a different (many-stacked-attempts-per-photo) data shape.
export const ADMIN_PIPELINE_BUCKET = 'admin-pipeline';
export const REFERENCE_PREFIX = '_reference';
// The admin works through a project over a single long session -- signed
// URLs need to outlive that, not just one request.
export const ADMIN_PIPELINE_SIGN_TTL = 6 * 60 * 60;
// Below this side length there isn't enough detail for Ideogram's swap to
// look right -- same floor the local tool used.
export const MIN_SWAP_SIDE = 2000;

export interface Identity {
  column: 'user_id' | 'submission_id';
  id: string | number;
  storagePrefix: string;
}

// profiles (signed-in accounts) vs. submissions (legacy shareable-link
// leads) -- every owner-scoped lookup keys off which identity.column
// resolveIdentity returned, see api/_lib/identity.ts.
export function ownerTableFor(identity: Identity): 'profiles' | 'submissions' {
  return identity.column === 'user_id' ? 'profiles' : 'submissions';
}
