const crypto = require('crypto');

// Short-lived, admin-issued tokens that let an admin view a signed-in
// profile's private pages (upload/swap/results) without needing that
// person's phone/OTP -- mirrors what submissions already get for free via
// their permanent upload_token, but time-boxed since profiles don't have
// an equivalent standing secret.
const TTL_MS = 15 * 60 * 1000;

function sign(profileId) {
  const { ADMIN_PASSWORD } = process.env;
  const payload = JSON.stringify({ id: profileId, exp: Date.now() + TTL_MS });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_PASSWORD).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

// Returns the profile id if the token is validly signed and not expired, else null.
function verify(token) {
  const { ADMIN_PASSWORD } = process.env;
  if (typeof token !== 'string' || !ADMIN_PASSWORD) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  const expectedSig = crypto.createHmac('sha256', ADMIN_PASSWORD).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.id !== 'string' || typeof payload.exp !== 'number' || Date.now() > payload.exp) {
    return null;
  }
  return payload.id;
}

module.exports = { sign, verify };
