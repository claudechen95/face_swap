import crypto from 'crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resolveIdentity, resolveKind, hasReviewedFaceMask } from './_lib/identity.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { USER_PHOTOS_BUCKET } from './_lib/constants.js';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Method not allowed');
  }

  const { contentType } = req.body || {};
  const ext = EXT_BY_MIME[contentType];
  if (!ext) {
    return sendError(res, 400, 'Unsupported file type');
  }

  const supabase = getSupabaseClient(res);
  if (!supabase) return;
  const identity = await resolveIdentity(req, supabase);
  if (!identity) {
    return sendError(res, 404, 'This upload link is invalid');
  }

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

  const prefix = kindConfig.kind === 'target' ? `${identity.storagePrefix}/targets` : identity.storagePrefix;
  const storagePath = `${prefix}/${crypto.randomUUID()}.${ext}`;

  const { data: signed, error: signError } = await supabase.storage.from(USER_PHOTOS_BUCKET).createSignedUploadUrl(storagePath);

  if (signError) {
    console.error('createSignedUploadUrl failed', signError);
    return sendError(res, 502, 'Could not prepare upload');
  }

  return res.status(200).json({
    bucket: USER_PHOTOS_BUCKET,
    path: signed.path,
    signToken: signed.token,
  });
};
