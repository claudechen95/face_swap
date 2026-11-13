const { RekognitionClient, DetectFacesCommand } = require('@aws-sdk/client-rekognition');
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

const rekognition = new RekognitionClient({ region: process.env.AWS_REGION || 'us-east-1' });

// Rekognition's DetectFaces Bytes payload is capped at 5MB -- user uploads can be
// up to 20MB (see MAX_FILE_BYTES in upload.js), so a copy for detection only may
// need shrinking first. Quality doesn't matter here, only getting a bounding box.
const FACE_DETECT_MAX_BYTES = 5 * 1024 * 1024;

// Outward scale from the landmark contour's own centroid -- small now, because
// the contour below already hugs the real jaw/chin shape rather than guessing
// it from a bounding box, so it only needs a modest safety margin, not the 40%
// a generic ellipse needed to reliably cover hair/jaw/ears.
const MASK_MARGIN = 0.12;
const MASK_BLUR_SIGMA = 6; // soft edge, same intent as face_swap's feather_px

// Rekognition has no hairline/forehead landmark. Estimated from the classic
// face-thirds proportion (hairline-to-eyebrow distance roughly equals
// eyebrow-to-chin distance) rather than guessed from the bounding box.
const HAIRLINE_FACTOR = 0.9;

// Jawline/chin/eyebrow landmarks needed for the contour-fitted mask. Not part
// of DetectFaces' DEFAULT attribute set (BoundingBox/Confidence/Pose/Quality/
// Landmarks-basic-five) -- requires Attributes: ['ALL'], confirmed against
// https://docs.aws.amazon.com/rekognition/latest/APIReference/API_Landmark.html.
const CONTOUR_LANDMARK_TYPES = [
  'upperJawlineLeft',
  'midJawlineLeft',
  'chinBottom',
  'midJawlineRight',
  'upperJawlineRight',
  'leftEyeBrowUp',
  'rightEyeBrowUp',
];

async function shrinkForDetection(imageBuffer) {
  if (imageBuffer.length <= FACE_DETECT_MAX_BYTES) return imageBuffer;
  return sharp(imageBuffer)
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

function landmarkMap(face) {
  const map = {};
  for (const lm of face.Landmarks || []) map[lm.Type] = lm;
  return map;
}

// Fallback for the rare photo where Rekognition's landmark set is incomplete
// (e.g. partial occlusion) -- the old bounding-box ellipse, generous margin
// since it has no real contour to anchor to.
function ellipseMaskSvg(box, width, height) {
  const boxWidth = box.Width * width;
  const boxHeight = box.Height * height;
  const centerX = (box.Left + box.Width / 2) * width;
  const centerY = (box.Top + box.Height / 2) * height;
  const rx = (boxWidth / 2) * 1.4;
  const ry = (boxHeight / 2) * 1.4;
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="black" />
    <ellipse cx="${centerX}" cy="${centerY}" rx="${rx}" ry="${ry}" fill="white" />
  </svg>`;
}

// Detects the largest face in imageBuffer and returns a white-mask-on-black
// PNG at the image's own dimensions -- white = regenerate, same convention
// face_swap's own hand-painted _3mask.png files use (see ideogram.js's
// invertForIdeogram for where that gets flipped for Ideogram's own convention).
// The mask traces the actual jaw/chin contour from face landmarks rather than
// approximating the whole head as one generic ellipse around the bounding box.
async function buildFaceMask(imageBuffer) {
  const { width, height } = await sharp(imageBuffer).metadata();
  if (!width || !height) throw new Error('Could not read image dimensions');

  const detectBuffer = await shrinkForDetection(imageBuffer);
  const { FaceDetails } = await rekognition.send(
    new DetectFacesCommand({ Image: { Bytes: detectBuffer }, Attributes: ['ALL'] })
  );
  if (!FaceDetails || !FaceDetails.length) {
    throw new Error('No face detected in this photo');
  }

  // Ratios are relative to whatever image was analyzed, not its absolute size,
  // so they carry over unchanged onto the original (shrinkForDetection only
  // ever scales uniformly, never distorts aspect ratio).
  const largest = FaceDetails.reduce((best, face) => {
    const area = face.BoundingBox.Width * face.BoundingBox.Height;
    return !best || area > best.area ? { face, area } : best;
  }, null).face;

  const lm = landmarkMap(largest);
  const hasFullContour = CONTOUR_LANDMARK_TYPES.every((type) => lm[type]);

  let svg;
  if (!hasFullContour) {
    svg = ellipseMaskSvg(largest.BoundingBox, width, height);
  } else {
    const px = (l) => l.X * width;
    const py = (l) => l.Y * height;

    const eyebrowY = (py(lm.leftEyeBrowUp) + py(lm.rightEyeBrowUp)) / 2;
    const chinY = py(lm.chinBottom);
    // The thirds-proportion estimate overshoots badly under the close-range,
    // looking-up-at-the-camera perspective typical of phone selfies (confirmed
    // visually - it ran well past the real hairline into the background on a
    // test photo). Rekognition's own bounding box top is a face detector's
    // actual estimate of where the head starts, so it's used as a ceiling: the
    // hairline estimate can tighten that box but never extend further above it.
    const boxTopY = largest.BoundingBox.Top * height;
    const hairlineY = Math.max(eyebrowY - HAIRLINE_FACTOR * (chinY - eyebrowY), boxTopY);
    const leftX = px(lm.upperJawlineLeft);
    const rightX = px(lm.upperJawlineRight);

    const contour = [
      [leftX, py(lm.upperJawlineLeft)],
      [px(lm.midJawlineLeft), py(lm.midJawlineLeft)],
      [px(lm.chinBottom), chinY],
      [px(lm.midJawlineRight), py(lm.midJawlineRight)],
      [rightX, py(lm.upperJawlineRight)],
      [rightX, hairlineY],
      [leftX, hairlineY],
    ];

    const cx = contour.reduce((sum, p) => sum + p[0], 0) / contour.length;
    const cy = contour.reduce((sum, p) => sum + p[1], 0) / contour.length;
    const points = contour
      .map(([x, y]) => `${cx + (x - cx) * (1 + MASK_MARGIN)},${cy + (y - cy) * (1 + MASK_MARGIN)}`)
      .join(' ');

    svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="black" />
      <polygon points="${points}" fill="white" />
    </svg>`;
  }

  return sharp(Buffer.from(svg)).blur(MASK_BLUR_SIGMA).png().toBuffer();
}

// Ideogram's mask convention is black=selected region, white=everything else --
// the opposite of this project's white=regenerate convention (see buildFaceMask).
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

module.exports = { IDEOGRAM_CHARACTER_PROMPT, buildFaceMask, runIdeogramSwap };
