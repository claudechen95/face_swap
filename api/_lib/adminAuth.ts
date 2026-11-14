import crypto from 'crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

function safeEqual(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

// Checks HTTP Basic Auth against ADMIN_USER/ADMIN_PASSWORD, writing the
// 401/500 response itself. Returns whether the caller should continue.
export function requireAdminAuth(req: VercelRequest, res: VercelResponse): boolean {
  const { ADMIN_USER, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_USER || !ADMIN_PASSWORD) {
    console.error('Missing ADMIN_USER or ADMIN_PASSWORD env vars');
    res.status(500).send('Server misconfigured');
    return false;
  }

  const authHeader = req.headers.authorization || '';
  const [scheme, encoded] = authHeader.split(' ');
  let providedUser = '';
  let providedPass = '';
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep !== -1) {
      providedUser = decoded.slice(0, sep);
      providedPass = decoded.slice(sep + 1);
    }
  }

  if (!safeEqual(providedUser, ADMIN_USER) || !safeEqual(providedPass, ADMIN_PASSWORD)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Better Hello Studio admin", charset="UTF-8"');
    res.status(401).send('Authentication required');
    return false;
  }

  return true;
}
