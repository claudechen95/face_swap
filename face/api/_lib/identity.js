const { createClient } = require('@supabase/supabase-js');
const viewAsToken = require('./viewAsToken');

const MAX_PHOTOS = 20;
const MAX_REGENERATES = 3; // per target photo -- each attempt is a real fal.ai + Claude-judge cost

const PHOTO_KINDS = { face: { min: 1, max: 1 }, target: { min: 1, max: MAX_PHOTOS } };

// Reads `kind` off the request body (default 'face') and returns its config,
// or null if an unrecognized kind was sent. No paywall for now -- everyone
// gets the full target cap regardless of payment status.
function resolveKind(body) {
  const kind = (body && body.kind) || 'face';
  if (!Object.prototype.hasOwnProperty.call(PHOTO_KINDS, kind)) return null;
  return { kind, ...PHOTO_KINDS[kind] };
}

// Resolves the caller to either a real signed-in profile (Authorization: Bearer <jwt>)
// or a legacy shareable-link submission (token in the request body), never both.
// Returns null if neither resolves, so callers can respond with a single 404/401.
async function resolveIdentity(req, supabaseAdmin) {
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
// least once (see upload-confirm.js's auto-build and results-init.js's
// save-face-mask action) -- shared by every place a target photo can be
// added (own upload, library pick) so the check can't be bypassed via one path.
async function hasReviewedFaceMask(supabaseAdmin, identity) {
  const { data, error } = await supabaseAdmin
    .from('uploaded_photos')
    .select('mask_reviewed_at')
    .eq(identity.column, identity.id)
    .eq('kind', 'face')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data && data.mask_reviewed_at);
}

module.exports = { resolveIdentity, resolveKind, hasReviewedFaceMask, MAX_PHOTOS, MAX_REGENERATES };
