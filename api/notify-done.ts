import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resolveIdentity, resolveKind } from './_lib/identity.js';
import { triggerPipeline } from './_lib/triggerPipeline.js';
import { validateFacePhotoSet } from './_lib/facePhotoJudge.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { USER_PHOTOS_BUCKET, ownerTableFor } from './_lib/constants.js';

const SIGNED_URL_TTL = 600;

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

  const table = ownerTableFor(identity);
  const { data: owner } = await supabase.from(table).select('name, paid_at').eq('id', identity.id).maybeSingle();

  const kindConfig = resolveKind(req.body);
  if (!kindConfig) {
    return sendError(res, 400, 'Unsupported photo kind');
  }

  const { data, count } = await supabase
    .from('uploaded_photos')
    .select('storage_path', { count: 'exact' })
    .eq(identity.column, identity.id)
    .eq('kind', kindConfig.kind);
  const photoRows = data ?? [];

  if (kindConfig.kind === 'face') {
    const { data: signedUrls, error: signError } = await supabase.storage
      .from(USER_PHOTOS_BUCKET)
      .createSignedUrls(
        photoRows.map((row) => row.storage_path),
        SIGNED_URL_TTL
      );

    if (signError) {
      console.error('createSignedUrls failed', signError);
      return sendError(res, 500, 'Could not verify link');
    }

    try {
      // photoRows and signedUrls come from the same createSignedUrls(paths)
      // call, in the same order it was given -- safe to zip by index
      // regardless of what order the earlier DB query happened to return.
      const photos = photoRows.map((row, i) => ({ storagePath: row.storage_path, url: signedUrls[i]!.signedUrl as string }));
      const review = await validateFacePhotoSet(photos);
      if (!review.ok) {
        return res.status(422).json({ error: review.error, badPaths: review.badPaths || [] });
      }
    } catch (err) {
      // Don't block someone from finishing their upload because our own
      // review tooling is down -- log it and let the upload go through.
      console.error('validateFacePhotoSet failed', err);
    }
  }

  const { NTFY_TOPIC } = process.env;
  if (NTFY_TOPIC) {
    const who = owner ? owner.name : 'A lead';
    const body =
      kindConfig.kind === 'target'
        ? `${who} chose their photos to swap — ${count || 0}/${kindConfig.max} photos.`
        : `${who} says they're done uploading — ${count || 0}/${kindConfig.max} photos.`;
    try {
      await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: 'POST',
        headers: {
          Title: kindConfig.kind === 'target' ? 'Swap photos chosen' : 'Upload complete',
          Tags: 'white_check_mark',
          Click: 'https://faceswap.fit/admin',
        },
        body,
      });
    } catch (err) {
      console.error('ntfy notify failed', err);
    }
  }

  await triggerPipeline();

  return res.status(200).json({ ok: true });
};
