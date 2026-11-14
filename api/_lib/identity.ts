import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { VercelRequest } from '@vercel/node';
import * as viewAsToken from './viewAsToken.js';
import type { Identity } from './constants.js';

export const MAX_PHOTOS = 20;
export const MAX_REGENERATES = 3; // per target photo -- each attempt is a real fal.ai + Claude-judge cost

type PhotoKind = 'face' | 'target';

const PHOTO_KINDS: Record<PhotoKind, { min: number; max: number }> = {
  face: { min: 1, max: 1 },
  target: { min: 1, max: MAX_PHOTOS },
};

export interface KindConfig {
  kind: PhotoKind;
  min: number;
  max: number;
}

// Reads `kind` off the request body (default 'face') and returns its config,
// or null if an unrecognized kind was sent. No paywall for now -- everyone
// gets the full target cap regardless of payment status.
export function resolveKind(body: { kind?: unknown } | null | undefined): KindConfig | null {
  const kind = (body && body.kind) || 'face';
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(PHOTO_KINDS, kind)) return null;
  return { kind: kind as PhotoKind, ...PHOTO_KINDS[kind as PhotoKind] };
}

// Resolves the caller to either a real signed-in profile (Authorization: Bearer <jwt>)
// or a legacy shareable-link submission (token in the request body), never both.
// Returns null if neither resolves, so callers can respond with a single 404/401.
export async function resolveIdentity(req: VercelRequest, supabaseAdmin: SupabaseClient): Promise<Identity | null> {
  const authHeader = req.headers.authorization || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);

  if (bearerMatch) {
    const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      console.error('Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY env vars');
      return null;
    }
    const anonClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
    const { data, error } = await anonClient.auth.getUser(bearerMatch[1]);
    if (error || !data.user) return null;
    return { column: 'user_id', id: data.user.id, storagePrefix: data.user.id };
  }

  const { viewAs } = req.body || {};
  if (typeof viewAs === 'string' && viewAs.trim()) {
    const profileId = viewAsToken.verify(viewAs.trim());
    if (profileId) {
      return { column: 'user_id', id: profileId, storagePrefix: profileId };
    }
  }

  const { token } = req.body || {};
  if (typeof token === 'string' && token.trim()) {
    const { data: submission } = await supabaseAdmin
      .from('submissions')
      .select('id')
      .eq('upload_token', token.trim())
      .maybeSingle();
    if (submission) {
      return { column: 'submission_id', id: submission.id, storagePrefix: String(submission.id) };
    }
  }

  return null;
}

// Target photos are gated on having reviewed the auto-generated face mask at
// least once (see upload-confirm.ts's auto-build and results-init.ts's
// save-face-mask action) -- shared by every place a target photo can be
// added (own upload, library pick) so the check can't be bypassed via one path.
export async function hasReviewedFaceMask(supabaseAdmin: SupabaseClient, identity: Identity): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('uploaded_photos')
    .select('mask_reviewed_at')
    .eq(identity.column, identity.id)
    .eq('kind', 'face')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data && data.mask_reviewed_at);
}
