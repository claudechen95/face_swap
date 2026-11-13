const sharp = require('sharp');

// Ported verbatim from face_swap/pipeline_server.py's IDEOGRAM_CHARACTER_PROMPT --
// one source of truth for what "a good swap" means to this prompt, kept in sync
// with the local tool it was proven out in.
const IDEOGRAM_CHARACTER_PROMPT =
  "Replace only the masked person's face with the identity of the reference character. " +
  "Match the reference character's facial structure, features, skin tone, and apparent age. " +
  'Do not render glasses or any other eyewear on the face, even if the reference character or ' +
  'the source/target person is wearing them -- the result must show no glasses. Include facial ' +
  'hair only if present in the character reference; if absent, leave it absent. Exactly mimic ' +
  "the source person's original facial expression -- same mouth, eyes, and brow position -- as " +
  'well as their gaze, head angle, pose, hairstyle, clothing, and accessories outside the face. ' +
  "Match the source image's lighting, shadows, perspective, texture, and visual style so the " +
  'face blends naturally. Keep the original composition and background unchanged. If the mask ' +
  'extends beyond the face, preserve the original content in those areas.';

// Ideogram's mask convention is black=selected region, white=everything else --
// the opposite of this project's white=regenerate convention (masks are now
// always computed client-side in upload.js's computeAutoMaskCanvas, or
// hand-painted, and arrive here already in that white=regenerate form).
function invertForIdeogram(maskBuffer) {
  return sharp(maskBuffer).negate({ alpha: false }).png().toBuffer();
}

const IDEOGRAM_INPAINT_URL = 'https://api.ideogram.ai/v2/image/inpaint/ideogram-3-character';
const IDEOGRAM_POLL_DEADLINE_MS = 120000;
const IDEOGRAM_POLL_INTERVAL_MS = 2000;

// POSTs to Ideogram's character-reference inpaint endpoint with async=true
// (returns a generation_id immediately), then polls until "completed" or
// "failed", mirroring face_swap/pipeline_server.py's ideogram_character_swap.
// Returns the result image's bytes.
async function runIdeogramSwap({ targetBuffer, maskBuffer, referenceBuffer, referenceMaskBuffer }) {
  const { IDEOGRAM_API_KEY } = process.env;
  if (!IDEOGRAM_API_KEY) throw new Error('Missing IDEOGRAM_API_KEY env var');

  const invertedMask = await invertForIdeogram(maskBuffer);

  const form = new FormData();
  form.append('image', new Blob([targetBuffer]), 'image.jpg');
  form.append('mask', new Blob([invertedMask], { type: 'image/png' }), 'mask.png');
  form.append('character_reference_images', new Blob([referenceBuffer]), 'reference.jpg');
  // Optional -- Ideogram uses the whole reference image as the character when
  // it's omitted, same convention as the target mask (see invertForIdeogram).
  if (referenceMaskBuffer) {
    const invertedReferenceMask = await invertForIdeogram(referenceMaskBuffer);
    form.append('character_reference_mask', new Blob([invertedReferenceMask], { type: 'image/png' }), 'reference_mask.png');
  }
  form.append('prompt', IDEOGRAM_CHARACTER_PROMPT);
  form.append('magic_prompt', 'on');
  form.append('num_images', '1');
  form.append('async', 'true');

  const startResponse = await fetch(IDEOGRAM_INPAINT_URL, {
    method: 'POST',
    headers: { 'Api-Key': IDEOGRAM_API_KEY },
    body: form,
  });
  if (!startResponse.ok) {
    throw new Error(`Ideogram request failed: ${startResponse.status} ${await startResponse.text()}`);
  }
  const { generation_id: generationId } = await startResponse.json();

  const deadline = Date.now() + IDEOGRAM_POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, IDEOGRAM_POLL_INTERVAL_MS));

    const pollResponse = await fetch(`https://api.ideogram.ai/v2/generations/${generationId}`, {
      headers: { 'Api-Key': IDEOGRAM_API_KEY },
    });
    if (!pollResponse.ok) {
      throw new Error(`Ideogram poll failed: ${pollResponse.status} ${await pollResponse.text()}`);
    }
    const body = await pollResponse.json();
    if (body.status === 'completed') {
      // A bare fetch without a real User-Agent gets a 403 from Ideogram's result host.
      const imageResponse = await fetch(body.data[0].url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!imageResponse.ok) throw new Error('Could not download Ideogram result image');
      return Buffer.from(await imageResponse.arrayBuffer());
    }
    if (body.status === 'failed') {
      throw new Error(`Ideogram generation failed: ${JSON.stringify(body)}`);
    }
  }
  throw new Error('Ideogram generation timed out after 120s');
}

module.exports = { IDEOGRAM_CHARACTER_PROMPT, runIdeogramSwap };
