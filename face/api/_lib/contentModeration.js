const Anthropic = require('@anthropic-ai/sdk');

const MODERATION_MODEL = 'claude-sonnet-5';

const MODERATION_TOOL = {
  name: 'submit_moderation',
  description: 'Submit a content-safety judgment for the photo.',
  input_schema: {
    type: 'object',
    properties: {
      safe: { type: 'boolean', description: 'True if the photo is appropriate for a mainstream face-swap product, false to reject.' },
      reason: { type: 'string', description: 'Brief reason, especially if rejecting.' },
    },
    required: ['safe', 'reason'],
  },
};

const MODERATION_PROMPT = `You are a content moderator for a mainstream face-swap photo product. Users upload photos of themselves (used as their face-swap reference) or photos they want their face swapped into.

Reject the photo if it shows any of the following:
- Nudity, sexually explicit content, or content in underwear/lingerie primarily meant to be sexually suggestive
- Graphic violence or gore
- Anything illegal

This is a mainstream consumer product, not an adult platform -- when in doubt about explicitness, reject.

A normal, fully-clothed photo of a person (even a casual selfie, swimwear at a beach/pool, or a shirtless photo in a non-sexualized context like sports or the gym) is fine and should be approved.

Respond by calling the submit_moderation tool.`;

async function checkImageSafety(url) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: MODERATION_MODEL,
    max_tokens: 300,
    tools: [MODERATION_TOOL],
    tool_choice: { type: 'tool', name: 'submit_moderation' },
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url } }, { type: 'text', text: MODERATION_PROMPT }],
      },
    ],
  });

  const block = response.content.find((b) => b.type === 'tool_use' && b.name === 'submit_moderation');
  if (!block) throw new Error('Moderator did not return a tool_use block');
  return { safe: Boolean(block.input.safe), reason: block.input.reason || '' };
}

module.exports = { checkImageSafety };
