import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdminAuth } from './_lib/adminAuth.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';
import { startUpscaleJob, startIdeogramJob, advanceJob, type PipelinePhotoRow, type PipelineJobRow } from './_lib/pipelineJobs.js';

/**
 * The async job endpoints -- every Topaz/Ideogram step that used to block
 * inside a single long-running request (face_swap/server/app.ts's
 * /run/upscale, /run/ideogram) instead starts here and advances one
 * non-blocking step per poll-job call. See pipelineJobs.ts for the actual
 * state machine; this file is just the thin HTTP wrapper around it.
 */

async function getPhoto(supabase: SupabaseClient, photoId: string): Promise<PipelinePhotoRow> {
  const { data, error } = await supabase.from('pipeline_photos').select('*').eq('id', photoId).single();
  if (error || !data) throw new Error('photo not found');
  return data as PipelinePhotoRow;
}

async function getJob(supabase: SupabaseClient, jobId: string): Promise<PipelineJobRow> {
  const { data, error } = await supabase.from('pipeline_jobs').select('*').eq('id', jobId).single();
  if (error || !data) throw new Error('job not found');
  return data as PipelineJobRow;
}

async function handleStartUpscale(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { photoId, target } = req.body || {};
  if (!photoId || !Number.isFinite(target)) return sendError(res, 400, 'Missing photoId or target');

  try {
    const photo = await getPhoto(supabase, photoId);
    const job = await startUpscaleJob(supabase, photo, target);
    return res.status(200).json(job);
  } catch (err) {
    console.error('start-upscale failed', err);
    return sendError(res, 500, (err as Error).message);
  }
}

async function handleStartIdeogram(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { photoId, expression } = req.body || {};
  if (!photoId) return sendError(res, 400, 'Missing photoId');

  try {
    const photo = await getPhoto(supabase, photoId);
    const job = await startIdeogramJob(supabase, photo, expression || null);
    return res.status(200).json(job);
  } catch (err) {
    console.error('start-ideogram failed', err);
    return sendError(res, 500, (err as Error).message);
  }
}

async function handlePollJob(req: VercelRequest, res: VercelResponse, supabase: SupabaseClient) {
  const { jobId } = req.body || {};
  if (!jobId) return sendError(res, 400, 'Missing jobId');

  try {
    const job = await getJob(supabase, jobId);
    const photo = await getPhoto(supabase, job.photo_id);
    const advanced = await advanceJob(supabase, job, photo);
    return res.status(200).json(advanced);
  } catch (err) {
    console.error('poll-job failed', err);
    return sendError(res, 500, (err as Error).message);
  }
}

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Method not allowed');
  }
  if (!requireAdminAuth(req, res)) return;

  const supabase = getSupabaseClient(res);
  if (!supabase) return;

  const { action } = req.body || {};
  switch (action) {
    case 'start-upscale':
      return handleStartUpscale(req, res, supabase);
    case 'start-ideogram':
      return handleStartIdeogram(req, res, supabase);
    case 'poll-job':
      return handlePollJob(req, res, supabase);
    default:
      return sendError(res, 400, 'Unknown action');
  }
};
