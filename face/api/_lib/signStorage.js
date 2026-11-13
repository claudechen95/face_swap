// Signs paths grouped by bucket -- createSignedUrls is scoped to one bucket per
// call, and target photos can live in either 'user-photos' (self-uploaded) or
// 'swap-library' (picked from the free-preview library, see library.js) per
// uploaded_photos.bucket. Returns a map keyed `${bucket}::${path}`.
async function signGrouped(supabase, entries, ttl) {
  const pathsByBucket = new Map();
  for (const { bucket, path } of entries) {
    if (!pathsByBucket.has(bucket)) pathsByBucket.set(bucket, new Set());
    pathsByBucket.get(bucket).add(path);
  }

  const urlByKey = {};
  for (const [bucket, pathSet] of pathsByBucket) {
    const paths = [...pathSet];
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, ttl);
    if (error) throw error;
    paths.forEach((path, i) => {
      urlByKey[`${bucket}::${path}`] = data[i].signedUrl;
    });
  }
  return urlByKey;
}

module.exports = { signGrouped };
