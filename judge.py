"""
LLM-as-judge quality gate for finished swap results, using Claude's vision
capability to catch generation artifacts (unnatural expressions, blending
seams, distorted features) before a result ever reaches the user -- see
pipeline.swap_for_lead's regenerate-until-approved loop.
"""

from __future__ import annotations

import base64
import os

import anthropic

JUDGE_MODEL = "claude-sonnet-5"

JUDGE_PROMPT = """You are a strict quality reviewer for an AI face-swap product. You'll see two images: the ORIGINAL target photo (a stock/stand-in photo), and the RESULT after swapping a client's own face into it.

IMPORTANT: the RESULT is supposed to show a completely different person's face than the ORIGINAL -- that's the entire point of a face swap. Do NOT reject it just because the facial identity, hairline, beard, skin tone, or expression differs from the original -- that person is gone on purpose. Judge the RESULT on its own technical and visual merits, not on how closely its face matches the original photo's model.

Only two expressions are acceptable: a calm, relaxed NEUTRAL expression, or a genuine, SYMMETRIC smile. Reject anything else -- smirks, one-sided smiles, smugness, tense or furrowed brows, squinting on only one side, partial frowns, or any asymmetry between the left and right half of the face.

To check this, do the analysis explicitly: look at the left half of the face alone -- eyebrow position, eye openness, mouth corner -- then look at the right half alone the same way. If the two halves don't tell the same emotional story (e.g. one side relaxed and smiling while the other is tense, flat, or raised), REJECT even if the photo looks fine at a quick glance. This left/right mismatch is the most common and most easily-missed defect -- look for it carefully before approving anything.

Also reject if you see:
- Visible blending seams, warping, or artifacts around the face/hair/neck
- Face proportions that look anatomically wrong (not just "different person," but actually malformed), including a head size that looks disproportionate to the neck/body
- Lighting or skin tone on the face that doesn't match the lighting/tone of the neck and the rest of the scene (e.g. colored ambient lighting clearly hitting the body but not the face)
- Hallucinated extras that don't belong (e.g. jewelry, objects, or features the generation process invented)
- The overall pose, framing, or background no longer resembles the original target (a sign the swap broke rather than just changed the face)
- Anything that would make a normal person say "that's obviously AI-generated" or "that looks off"

Approve only if the result looks like a natural, believable, well-blended photo of a (different) real person in the original's scene and pose, AND the expression passes the left/right symmetry check above as a clean neutral or genuine smile. A different face, identity, or mood than the original is expected and fine -- the symmetry and technical checks are what matter.

Respond by calling the submit_review tool."""

JUDGE_TOOL = {
    "name": "submit_review",
    "description": "Submit your quality judgment for the swap result.",
    "input_schema": {
        "type": "object",
        "properties": {
            "approved": {"type": "boolean", "description": "True if the result passes quality review, false to reject."},
            "reason": {"type": "string", "description": "One or two sentences on what you saw -- especially if rejecting."},
        },
        "required": ["approved", "reason"],
    },
}


def _b64_image(path: str) -> tuple[str, str]:
    ext = os.path.splitext(path)[1].lower()
    media_type = "image/png" if ext == ".png" else "image/jpeg"
    with open(path, "rb") as f:
        return media_type, base64.standard_b64encode(f.read()).decode("utf-8")


def judge_swap_result(result_path: str, target_path: str) -> dict:
    """
    Returns {"approved": bool, "reason": str}. Raises on API failure --
    callers should decide for themselves whether a judge outage should block
    delivery (see pipeline.py, which treats it as approved rather than
    holding a working image hostage to our own tooling breaking).
    """
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    target_media_type, target_b64 = _b64_image(target_path)
    result_media_type, result_b64 = _b64_image(result_path)

    response = client.messages.create(
        model=JUDGE_MODEL,
        max_tokens=300,
        tools=[JUDGE_TOOL],
        tool_choice={"type": "tool", "name": "submit_review"},
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "ORIGINAL target photo:"},
                    {"type": "image", "source": {"type": "base64", "media_type": target_media_type, "data": target_b64}},
                    {"type": "text", "text": "RESULT after face swap:"},
                    {"type": "image", "source": {"type": "base64", "media_type": result_media_type, "data": result_b64}},
                    {"type": "text", "text": JUDGE_PROMPT},
                ],
            }
        ],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_review":
            return {"approved": bool(block.input["approved"]), "reason": block.input.get("reason", "")}

    raise RuntimeError("Judge did not return a tool_use block")
