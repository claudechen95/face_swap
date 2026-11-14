import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resolveIdentity, resolveKind } from './_lib/identity.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { USER_PHOTOS_BUCKET, SWAP_LIBRARY_BUCKET } from './_lib/constants.js';

const SIGNED_URL_TTL = 3600;

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

  const table = identity.column === 'user_id' ? 'profiles' : 'submissions';
  const { data: owner, error: ownerError } = await supabase.from(table).select('name, paid_at').eq('id', identity.id).maybeSingle();

  if (ownerError || !owner) {
    console.error('Owner lookup failed', ownerError);
    return sendError(res, 500, 'Could not verify link');
  }

  const kindConfig = resolveKind(req.body);
  if (!kindConfig) {
    return sendError(res, 400, 'Unsupported photo kind');
  }

  const { data: photoRows, error: photosError } = await supabase
    .from('uploaded_photos')
    .select('storage_path, bucket, mask_storage_path, mask_reviewed_at')
    .eq(identity.column, identity.id)
    .eq('kind', kindConfig.kind)
    .order('created_at', { ascending: true });

  if (photosError) {
    console.error('Photo lookup failed', photosError);
    return sendError(res, 500, 'Could not verify link');
  }

  const ownPaths = photoRows.filter((row) => row.bucket !== SWAP_LIBRARY_BUCKET).map((row) => row.storage_path);
  const libraryPaths = photoRows.filter((row) => row.bucket === SWAP_LIBRARY_BUCKET).map((row) => row.storage_path);
  const maskPaths = photoRows.filter((row) => row.mask_storage_path).map((row) => row.mask_storage_path as string);

  const urlByPath: Record<string, string> = {};
  const ownAndMaskPaths = [...ownPaths, ...maskPaths];
  if (ownAndMaskPaths.length) {
    const { data: signedUrls, error: signError } = await supabase.storage.from(USER_PHOTOS_BUCKET).createSignedUrls(ownAndMaskPaths, SIGNED_URL_TTL);

    if (signError) {
      console.error('createSignedUrls failed', signError);
      return sendError(res, 500, 'Could not verify link');
    }

    ownAndMaskPaths.forEach((path, i) => {
      urlByPath[path] = signedUrls[i]!.signedUrl as string;
    });
  }
  libraryPaths.forEach((path) => {
    urlByPath[path] = supabase.storage.from(SWAP_LIBRARY_BUCKET).getPublicUrl(path).data.publicUrl;
  });

  const photos = photoRows.map((row) => ({
    path: row.storage_path,
    url: urlByPath[row.storage_path],
    library: row.bucket === SWAP_LIBRARY_BUCKET,
    maskUrl: row.mask_storage_path ? urlByPath[row.mask_storage_path] || null : null,
    maskReviewed: Boolean(row.mask_reviewed_at),
  }));

  const count = photos.length;

  return res.status(200).json({
    name: owner.name,
    paid: Boolean(owner.paid_at),
    uploaded: count,
    remaining: Math.max(0, kindConfig.max - count),
    min: kindConfig.min,
    max: kindConfig.max,
    photos,
  });
};
