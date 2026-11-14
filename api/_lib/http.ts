import type { VercelRequest, VercelResponse } from '@vercel/node';

export type ApiHandler = (req: VercelRequest, res: VercelResponse) => Promise<void | VercelResponse>;

export function sendError(res: VercelResponse, status: number, message: string) {
  return res.status(status).json({ error: message });
}
