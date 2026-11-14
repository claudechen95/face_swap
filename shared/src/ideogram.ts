/**
 * Ideogram character-reference inpaint swap -- the one engine both apps use.
 * Ported from face/api/_lib/ideogram.js (production) and merged with
 * face_swap/pipeline_server.py's ideogram_character_swap (the local tool),
 * which previously had two near-identical hand-ported copies of this same
 * call. Node-only (uses Node's global fetch/FormData/Blob and Buffer).
 */

export const IDEOGRAM_CHARACTER_PROMPT =
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

// Manual per-run expression override (face_swap's UI has an optional
// "expression" field; face/ has no equivalent yet and always uses the plain
// IDEOGRAM_CHARACTER_PROMPT above).
export const IDEOGRAM_CHARACTER_PROMPT_WITH_EXPRESSION =
  "Replace only the masked person's face with the identity of the reference character. " +
  "Match the reference character's facial structure, features, skin tone, and apparent age. " +
  'Do not render glasses or any other eyewear on the face, even if the reference character or ' +
  'the source/target person is wearing them -- the result must show no glasses. Include facial ' +
  'hair only if present in the character reference; if absent, leave it absent. Give the face ' +
  'this exact expression: {expression}. Exactly mimic the source person\'s gaze, head angle, ' +
  'pose, hairstyle, clothing, and accessories outside the face. Match the source image\'s ' +
  'lighting, shadows, perspective, texture, and visual style so the face blends naturally. Keep ' +
  'the original composition and background unchanged. If the mask extends beyond the face, ' +
  'preserve the original content in those areas.';

export function buildPrompt(expression?: string | null): string {
  if (!expression) return IDEOGRAM_CHARACTER_PROMPT;
  return IDEOGRAM_CHARACTER_PROMPT_WITH_EXPRESSION.replace('{expression}', expression);
}

const IDEOGRAM_INPAINT_URL = 'https://api.ideogram.ai/v2/image/inpaint/ideogram-3-character';
const IDEOGRAM_POLL_DEADLINE_MS = 120000;
const IDEOGRAM_POLL_INTERVAL_MS = 2000;

/**
 * Ideogram's mask convention is black=selected region, white=everything
 * else -- the opposite of this project's white=regenerate convention (masks
 * are computed client-side via automask.ts, or hand-painted, and arrive here
 * already in that white=regenerate form).
 */
export async function invertForIdeogram(maskBuffer: Buffer): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp(maskBuffer).negate({ alpha: false }).png().toBuffer();
}

export interface RunIdeogramSwapParams {
  targetBuffer: Buffer;
  maskBuffer: Buffer;
  referenceBuffer: Buffer;
  referenceMaskBuffer?: Buffer | null;
  prompt?: string;
  numImages?: number;
}

/**
 * POSTs to Ideogram's character-reference inpaint endpoint with async=true,
 * returning a generation_id immediately -- this is the one fast HTTP call
 * in the whole swap; the rest is polling (see checkIdeogramGeneration).
 * Split out from runIdeogramSwap so callers that can't block for minutes
 * (face/api/admin-pipeline-run.ts's non-blocking job-advance design) can
 * drive the wait themselves instead of one function sleeping through it.
 */
export async function submitIdeogramSwap({
  targetBuffer,
  maskBuffer,
  referenceBuffer,
  referenceMaskBuffer,
  prompt = IDEOGRAM_CHARACTER_PROMPT,
  numImages = 1,
}: RunIdeogramSwapParams): Promise<{ generationId: string }> {
  const { IDEOGRAM_API_KEY } = process.env;
  if (!IDEOGRAM_API_KEY) throw new Error('Missing IDEOGRAM_API_KEY env var');

  const invertedMask = await invertForIdeogram(maskBuffer);

  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(targetBuffer)]), 'image.jpg');
  form.append('mask', new Blob([new Uint8Array(invertedMask)], { type: 'image/png' }), 'mask.png');
  form.append('character_reference_images', new Blob([new Uint8Array(referenceBuffer)]), 'reference.jpg');
  if (referenceMaskBuffer) {
    const invertedReferenceMask = await invertForIdeogram(referenceMaskBuffer);
    form.append(
      'character_reference_mask',
      new Blob([new Uint8Array(invertedReferenceMask)], { type: 'image/png' }),
      'reference_mask.png'
    );
  }
  form.append('prompt', prompt);
  form.append('magic_prompt', 'on');
  form.append('num_images', String(numImages));
  form.append('async', 'true');

  const startResponse = await fetch(IDEOGRAM_INPAINT_URL, {
    method: 'POST',
    headers: { 'Api-Key': IDEOGRAM_API_KEY },
    body: form,
  });
  if (!startResponse.ok) {
    throw new Error(`Ideogram request failed: ${startResponse.status} ${await startResponse.text()}`);
  }
  const { generation_id: generationId } = (await startResponse.json()) as { generation_id: string };
  return { generationId };
}

export interface IdeogramGenerationStatus {
  status: 'pending' | 'completed' | 'failed';
  urls?: string[];
  error?: string;
}

// One non-blocking status check -- no sleep, no loop.
export async function checkIdeogramGeneration(generationId: string): Promise<IdeogramGenerationStatus> {
  const { IDEOGRAM_API_KEY } = process.env;
  if (!IDEOGRAM_API_KEY) throw new Error('Missing IDEOGRAM_API_KEY env var');

  const pollResponse = await fetch(`https://api.ideogram.ai/v2/generations/${generationId}`, {
    headers: { 'Api-Key': IDEOGRAM_API_KEY },
  });
  if (!pollResponse.ok) {
    throw new Error(`Ideogram poll failed: ${pollResponse.status} ${await pollResponse.text()}`);
  }
  const body = (await pollResponse.json()) as { status: string; data?: { url: string }[] };
  if (body.status === 'completed') {
    return { status: 'completed', urls: (body.data ?? []).map((item) => item.url) };
  }
  if (body.status === 'failed') {
    return { status: 'failed', error: JSON.stringify(body) };
  }
  return { status: 'pending' };
}

/**
 * Submits and polls until "completed" or "failed" in one call. Returns the
 * result images' ephemeral signed URLs, one per numImages -- download them
 * promptly and with a real User-Agent header, bare fetch calls without one
 * get a 403 from Ideogram's result host. Used by callers that can afford to
 * block for up to ~2 minutes (face/api/results-init.ts's live swap flow,
 * already budgeted for this in its own maxDuration); for non-blocking
 * callers, use submitIdeogramSwap/checkIdeogramGeneration directly instead.
 */
export async function runIdeogramSwap(params: RunIdeogramSwapParams): Promise<string[]> {
  const { generationId } = await submitIdeogramSwap(params);

  const deadline = Date.now() + IDEOGRAM_POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, IDEOGRAM_POLL_INTERVAL_MS));
    const status = await checkIdeogramGeneration(generationId);
    if (status.status === 'completed') return status.urls!;
    if (status.status === 'failed') throw new Error(`Ideogram generation failed: ${status.error}`);
  }
  throw new Error('Ideogram generation timed out after 120s');
}

/**
 * Downloads a single Ideogram result URL -- a bare fetch without a real
 * User-Agent gets a 403 from Ideogram's result host.
 */
export async function downloadIdeogramResult(url: string): Promise<Buffer> {
  const imageResponse = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!imageResponse.ok) throw new Error('Could not download Ideogram result image');
  return Buffer.from(await imageResponse.arrayBuffer());
}
