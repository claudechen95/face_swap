import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { VercelResponse } from '@vercel/node';
import { sendError } from './http.js';

// Service-role client -- writes the 500 response itself and returns null so
// every handler can `const supabase = getSupabaseClient(res); if (!supabase) return;`
export function getSupabaseClient(res: VercelResponse): SupabaseClient | null {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
    sendError(res, 500, 'Server misconfigured');
    return null;
  }
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
}
