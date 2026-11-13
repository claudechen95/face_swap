// Fire-and-forget ping to the AWS pipeline (see /Users/Claude/workspace/face_swap)
// so swaps start immediately on the relevant user action instead of waiting
// for the next periodic cron ping. Never throws -- if this fails for
// any reason (network blip, misconfigured env vars), the periodic cron ping
// is still the fallback that will pick up the work, so a failure here must
// never break the caller's actual request.
async function triggerPipeline() {
  const { PIPELINE_URL, PIPELINE_SECRET } = process.env;
  if (!PIPELINE_URL || !PIPELINE_SECRET) {
    console.error('Missing PIPELINE_URL or PIPELINE_SECRET env vars -- skipping direct trigger');
    return;
  }
  try {
    await fetch(`${PIPELINE_URL}?secret=${encodeURIComponent(PIPELINE_SECRET)}`);
  } catch (err) {
    console.error('triggerPipeline ping failed', err);
  }
}

module.exports = { triggerPipeline };
