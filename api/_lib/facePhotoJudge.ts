import Anthropic from '@anthropic-ai/sdk';

const JUDGE_MODEL = 'claude-sonnet-5';

const SINGLE_PHOTO_TOOL = {
  name: 'submit_people_check',
  description: 'Report whether more than one person appears in the photo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      multiplePeople: {
        type: 'boolean',
        description:
          "True if more than one person's face is clearly visible and prominent (e.g. a couple photo, group photo, or selfie with a friend) -- NOT true for a random stranger who is small, blurry, or partial in the far background.",
      },
    },
    required: ['multiplePeople'],
  },
};

// Cheap single-photo check used immediately on upload (api/upload-confirm.ts)
// so a bad photo is caught right away instead of only at validateFacePhotoSet's
// batch check below, which only runs once the minimum photo count is reached
// and "Done" is clicked -- too late if the very first photo uploaded is the
// bad one. validateFacePhotoSet still re-checks everything as a backstop
// (e.g. if this call fails transiently and a bad photo slips through).
export async function checkSinglePersonPhoto(url: string): Promise<boolean> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 200,
    tools: [SINGLE_PHOTO_TOOL],
    tool_choice: { type: 'tool', name: 'submit_people_check' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url } },
          {
            type: 'text',
            text: "Does more than one person's face appear clearly and prominently in this photo? Respond by calling submit_people_check.",
          },
        ],
      },
    ],
  });

  const block = response.content.find((b) => b.type === 'tool_use' && b.name === 'submit_people_check');
  if (!block || block.type !== 'tool_use') throw new Error('Classifier did not return a tool_use block');
  return Boolean((block.input as { multiplePeople?: boolean }).multiplePeople);
}

export interface PhotoToValidate {
  storagePath: string;
  url: string;
}

export type FaceSetValidation = { ok: true } | { ok: false; error: string; badPaths: string[] };

// Takes [{ storagePath, url }, ...] rather than bare URLs so a rejection can
// point back at the actual photo (storagePath) instead of a positional
// number. There's only ever one face photo now (one-shot reference), so this
// is just a backstop re-check of checkSinglePersonPhoto -- e.g. if that call
// failed transiently on upload and a bad photo slipped through.
// Never throws -- a classifier outage shouldn't block someone from finishing
// their upload, so callers should treat a thrown error from this module the
// same as { ok: true } (see api/notify-done.ts).
export async function validateFacePhotoSet(photos: PhotoToValidate[]): Promise<FaceSetValidation> {
  const results = await Promise.all(photos.map((p) => checkSinglePersonPhoto(p.url)));
  const badPaths = photos.filter((_, i) => results[i]).map((p) => p.storagePath);

  if (!badPaths.length) return { ok: true };
  const isSingle = badPaths.length === 1;
  const error = `${isSingle ? 'One of your photos has' : 'Some of your photos have'} more than one person in ${isSingle ? 'it' : 'them'} — remove ${
    isSingle ? 'the one flagged' : 'the ones flagged'
  } below and try again.`;
  return { ok: false, error, badPaths };
}
