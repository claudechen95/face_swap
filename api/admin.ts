import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdminAuth } from './_lib/adminAuth.js';
import { resolveKind } from './_lib/identity.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';

const FACE_MAX = resolveKind({ kind: 'face' })!.max;
const TARGET_MAX = resolveKind({ kind: 'target' })!.max;

function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch]!
  );
}

// Server-rendered shell for the admin pipeline tool (crop/upscale/mask/
// Ideogram character-swap), served from this same function under
// ?page=pipeline (was its own admin-pipeline.ts file, merged in to stay
// under Vercel's function cap) so it gets the same requireAdminAuth gate --
// a static HTML file wouldn't, since that only runs inside api/*.ts
// handlers. All real data loading happens client-side against
// admin-pipeline-action.ts.
const PIPELINE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<title>Pipeline</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background:#1b1b1f; color:#eee; }
  header { display:flex; align-items:center; gap:14px; padding:14px 20px; background:#222; border-bottom:1px solid #333; position:sticky; top:0; z-index:5; }
  header h1 { font-size:15px; margin:0; }
  #refBar { display:flex; align-items:center; gap:10px; padding:10px 20px; background:#1d2a1d; border-bottom:1px solid #333; }
  #refBar img { height:40px; border-radius:6px; cursor:pointer; }
  select, button, input { background:#333; color:#eee; border:1px solid #444; border-radius:6px; padding:6px 9px; font-size:12px; }
  button { cursor:pointer; }
  button:hover { background:#3a3a3a; }
  button:disabled { opacity:.4; cursor:default; }
  button.primary { background:#2e7d32; border-color:#2e7d32; font-weight:600; }
  button.primary:hover { background:#357a38; }
  button.is-active { background:#2e5a7d; border-color:#2e5a7d; }
  #rows { padding:16px 20px; display:flex; flex-direction:column; gap:14px; }
  .row { display:grid; grid-template-columns:140px repeat(4, 1fr); gap:10px; background:#222; border:1px solid #333; border-radius:10px; padding:12px; align-items:start; }
  .rowlabel { width:140px; font-size:12px; color:#aaa; word-break:break-all; display:flex; flex-direction:column; gap:6px; }
  .rowthumb { width:140px; height:140px; overflow:auto; border-radius:6px; background:#111; }
  .rowthumb img { width:100%; display:block; cursor:zoom-in; }
  .stage { background:#191919; border-radius:8px; padding:8px; display:flex; flex-direction:column; gap:6px; }
  .stage h3 { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#888; margin:0; }
  .stage img { width:100%; height:220px; border-radius:6px; object-fit:contain; cursor:zoom-in; background:#000; }
  .stage .placeholder { height:220px; border:1px dashed #3a3a3a; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#555; font-size:11px; }
  .stage .controls { display:flex; flex-direction:column; gap:6px; }
  .stage .controls-inputs { display:flex; gap:6px; flex-wrap:wrap; align-items:flex-end; min-height:40px; }
  .stage .controls-actions { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .stage .controls input { width:56px; }
  .swaplist { display:flex; gap:6px; flex-wrap:wrap; }
  .swapthumb { position:relative; width:110px; height:110px; }
  .swaplist img { width:110px; height:110px; max-height:110px; display:block; border-radius:4px; object-fit:cover; cursor:zoom-in; }
  .swapinfo {
    position:absolute; top:2px; right:2px; width:14px; height:14px; border-radius:50%;
    background:rgba(0,0,0,.65); color:#fff; font-size:10px; line-height:14px; text-align:center;
    font-family:Georgia,serif; cursor:default; display:none;
  }
  .swapthumb.has-info .swapinfo { display:block; }
  .swapinfo .tooltip {
    display:none; position:absolute; top:18px; right:0; width:260px; z-index:10;
    background:rgba(20,20,20,.97); border:1px solid #444; border-radius:8px; padding:10px 12px;
    font-size:11px; color:#ccc; line-height:1.5; text-align:left; white-space:normal;
  }
  .swapinfo:hover .tooltip { display:block; }
  .swapinfo .tooltip b { color:#eee; }
  .swapdel {
    position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%;
    background:rgba(140,0,0,.8); color:#fff; font-size:11px; line-height:14px; text-align:center;
    cursor:pointer; opacity:0; transition:opacity .15s;
  }
  .swapthumb:hover .swapdel { opacity:1; }
  #lightbox { position:fixed; inset:0; background:rgba(0,0,0,.85); display:none; align-items:center; justify-content:center; z-index:50; cursor:zoom-out; }
  #lightbox img { max-width:92vw; max-height:92vh; border-radius:6px; }
  #lightboxDownload {
    position:absolute; top:20px; right:20px; cursor:pointer; text-decoration:none;
    background:#2e7d32; border:1px solid #2e7d32; color:#eee; border-radius:6px;
    padding:8px 14px; font-size:13px; font-weight:600; font-family:inherit;
  }
  #lightboxDownload:hover { background:#357a38; }
  #lightboxParams {
    position:absolute; bottom:20px; left:20px; right:20px; max-width:800px; margin:0 auto;
    background:rgba(20,20,20,.9); border:1px solid #444; border-radius:8px; padding:10px 14px;
    font-size:12px; color:#ccc; line-height:1.5; display:none;
  }
  #lightboxParams b { color:#eee; }

  #paintView { position:fixed; inset:0; background:#1b1b1f; display:none; z-index:40; flex-direction:column; }
  #paintTop { display:flex; align-items:center; gap:10px; padding:10px 16px; background:#222; border-bottom:1px solid #333; }
  #paintBody { flex:1; display:flex; overflow:hidden; }
  #paintSidebar { width:240px; flex-shrink:0; padding:16px; background:#222; border-right:1px solid #333; display:flex; flex-direction:column; gap:12px; overflow-y:auto; }
  #paintCanvasWrap { flex:1; overflow:auto; background:#111 repeating-conic-gradient(#151515 0% 25%, #111 0% 50%) 50% / 24px 24px; padding:30px; display:flex; align-items:flex-start; justify-content:center; }
  .mask-canvas-wrap { position:relative; line-height:0; }
  .mask-canvas-wrap img { width:100%; display:block; }
  .mask-canvas-wrap canvas { position:absolute; inset:0; width:100%; height:100%; cursor:none; touch-action:none; }
  .mask-canvas-wrap canvas.is-disabled { pointer-events:none; cursor:default; }
  .mask-brush-cursor { position:absolute; display:none; border:1.5px dashed #fff; border-radius:50%; transform:translate(-50%,-50%); mix-blend-mode:difference; pointer-events:none; z-index:5; }
  .row2 { display:flex; gap:8px; }
  .row2 > * { flex:1; }

  #cropView { position:fixed; inset:0; background:#1b1b1f; display:none; z-index:40; flex-direction:column; }
  #cropTop { display:flex; align-items:center; gap:10px; padding:10px 16px; background:#222; border-bottom:1px solid #333; }
  #cropCanvasWrap { flex:1; overflow:auto; background:#111; padding:30px; display:flex; align-items:flex-start; justify-content:center; }
  #cropStage { position:relative; }
  #cropImg { display:block; user-select:none; -webkit-user-drag:none; }
  #cropBox { position:absolute; border:2px solid #4a6cf7; box-shadow:0 0 0 2000px rgba(0,0,0,.6); cursor:move; }
  #cropBox .handle { position:absolute; width:16px; height:16px; background:#4a6cf7; border:2px solid #fff; border-radius:50%; right:-9px; bottom:-9px; cursor:nwse-resize; }
</style>
</head>
<body>
<header>
  <h1>Pipeline</h1>
  <select id="project"></select>
  <button id="newProjectBtn">+ New project</button>
  <button id="deleteProjectBtn" style="color:#f88;border-color:#633;">Delete project</button>
  <button id="uploadBtn">+ Add photo</button>
  <input type="file" id="fileInput" accept="image/*" multiple style="display:none">
  <span style="flex:1"></span>
  <span id="uploadStatus" style="font-size:11px;color:#8bc34a;"></span>
  <span style="font-size:11px;color:#777;">Crop &rarr; Upscale &rarr; Mask &rarr; Ideogram &middot; Cmd/Ctrl+V to paste a photo</span>
</header>
<div id="refBar">
  <strong style="font-size:12px;">Ideogram character reference:</strong>
  <img id="refThumb" style="display:none">
  <span id="refStatus" style="font-size:11px;"></span>
  <button id="setReferenceBtn">Upload reference</button>
  <input type="file" id="refFileInput" accept="image/*" style="display:none">
  <button id="paintReferenceMaskBtn">Paint reference mask (optional)</button>
  <span id="refMaskStatus" style="font-size:11px;color:#777;"></span>
</div>
<div id="rows"></div>
<div id="lightbox">
  <img id="lightboxImg">
  <a id="lightboxDownload" download>Download</a>
  <div id="lightboxParams"></div>
</div>

<div id="paintView">
  <div id="paintTop">
    <button id="paintBack">&larr; Back to pipeline</button>
    <strong id="paintTitle" style="font-size:13px;"></strong>
    <span style="flex:1"></span>
    <button id="paintSave" class="primary">Save mask</button>
    <span id="paintStatus" style="font-size:11px;color:#8bc34a;"></span>
  </div>
  <div id="paintBody">
    <div id="paintSidebar">
      <div class="row2">
        <button id="toolPaint" class="is-active">Paint</button>
        <button id="toolErase">Erase</button>
      </div>
      <label style="font-size:12px;">Brush size: <span id="sizeLabel">60</span>px<br>
        <input type="range" id="size" min="10" max="300" value="60" style="width:100%"></label>
      <label style="font-size:12px;">Zoom: <span id="zoomLabel">100</span>%<br>
        <input type="range" id="zoom" min="5" max="300" value="100" style="width:100%"></label>
      <button id="clear">Clear all</button>
      <p id="paintHint" style="font-size:11px;color:#888;">Red = will be regenerated. Drag to paint/erase. <kbd>X</kbd> toggles eraser.</p>
    </div>
    <div id="paintCanvasWrap">
      <div id="paintStage" class="mask-canvas-wrap">
        <img id="paintImg">
        <canvas id="paintCanvas"></canvas>
      </div>
    </div>
  </div>
</div>

<div id="cropView">
  <div id="cropTop">
    <button id="cropBack">&larr; Back to pipeline</button>
    <strong id="cropTitle" style="font-size:13px;"></strong>
    <span style="flex:1"></span>
    <button id="cropConfirm" class="primary">Confirm crop</button>
    <span id="cropStatus" style="font-size:11px;color:#8bc34a;"></span>
  </div>
  <div id="cropCanvasWrap">
    <div id="cropStage">
      <img id="cropImg">
      <div id="cropBox"><div class="handle"></div></div>
    </div>
  </div>
</div>

<script type="module" src="/dist/adminPipeline.js"></script>
</body>
</html>`;

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAdminAuth(req, res)) return;

  if (req.query.page === 'pipeline') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(200).send(PIPELINE_HTML);
  }

  const supabase = getSupabaseClient(res);
  if (!supabase) return;

  const { data: submissions, error: submissionsError } = await supabase
    .from('submissions')
    .select('id, name, email, phone, created_at, upload_token, paid_at')
    .order('created_at', { ascending: false });

  if (submissionsError) {
    console.error('admin submissions query failed', submissionsError);
    return res.status(500).send('Could not load leads');
  }

  const { data: profiles, error: profilesError } = await supabase
    .from('profiles')
    .select('id, name, email, phone, created_at, paid_at')
    .order('created_at', { ascending: false });

  if (profilesError) {
    console.error('admin profiles query failed', profilesError);
    return res.status(500).send('Could not load leads');
  }

  const { data: photos, error: photosError } = await supabase
    .from('uploaded_photos')
    .select('submission_id, user_id, kind');

  if (photosError) {
    console.error('admin photos query failed', photosError);
    return res.status(500).send('Could not load leads');
  }

  const submissionCounts: Record<string, { face: number; target: number }> = {};
  const profileCounts: Record<string, { face: number; target: number }> = {};
  for (const row of photos) {
    const kind = row.kind === 'target' ? 'target' : 'face';
    if (row.submission_id) {
      submissionCounts[row.submission_id] = submissionCounts[row.submission_id] || { face: 0, target: 0 };
      submissionCounts[row.submission_id]![kind] += 1;
    }
    if (row.user_id) {
      profileCounts[row.user_id] = profileCounts[row.user_id] || { face: 0, target: 0 };
      profileCounts[row.user_id]![kind] += 1;
    }
  }

  const { data: swapJobs, error: swapJobsError } = await supabase
    .from('swap_jobs')
    .select('submission_id, user_id, status');

  if (swapJobsError) {
    console.error('admin swap_jobs query failed', swapJobsError);
    return res.status(500).send('Could not load leads');
  }

  type SwapCounts = { done: number; processing: number; failed: number; needs_review: number; mask_review: number };
  const swapCountsBySubmission: Record<string, SwapCounts> = {};
  const swapCountsByProfile: Record<string, SwapCounts> = {};
  for (const row of swapJobs) {
    const bucket: SwapCounts = row.submission_id
      ? (swapCountsBySubmission[row.submission_id] = swapCountsBySubmission[row.submission_id] || {
          done: 0,
          processing: 0,
          failed: 0,
          needs_review: 0,
          mask_review: 0,
        })
      : (swapCountsByProfile[row.user_id] = swapCountsByProfile[row.user_id] || {
          done: 0,
          processing: 0,
          failed: 0,
          needs_review: 0,
          mask_review: 0,
        });
    bucket[row.status as keyof SwapCounts] += 1;
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${host}`;

  const formatDate = (value: string) => new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  const photoCell = (type: string, id: string | number, counts: { face: number; target: number }, doneSwapCount: number | undefined) => {
    const face = counts.face || 0;
    const target = counts.target || 0;
    const downloads: string[] = [];
    if (face) downloads.push(`<a class="download-btn" href="/api/admin-action?type=${type}&id=${id}&kind=face">Face (${face})</a>`);
    if (target) downloads.push(`<a class="download-btn" href="/api/admin-action?type=${type}&id=${id}&kind=target">Swap (${target})</a>`);
    if (doneSwapCount) downloads.push(`<a class="download-btn" href="/api/admin-action?type=${type}&id=${id}&kind=results">Results (${doneSwapCount})</a>`);
    return { label: `${face}/${FACE_MAX} face · ${target}/${TARGET_MAX} swap`, downloads: downloads.join('') };
  };

  const paidBadge = (paidAt: string | null) =>
    paidAt ? `<span class="badge" title="${escapeHtml(formatDate(paidAt))}">Paid</span>` : '<span class="badge badge-neutral">Unpaid</span>';

  const swapStatusCell = (swapCounts: Partial<SwapCounts>) => {
    const parts: string[] = [];
    if (swapCounts.done) parts.push(`${swapCounts.done} done`);
    if (swapCounts.processing) parts.push(`${swapCounts.processing} processing`);
    if (swapCounts.mask_review) parts.push(`${swapCounts.mask_review} awaiting customer review`);
    if (swapCounts.failed) parts.push(`${swapCounts.failed} failed`);
    if (swapCounts.needs_review) parts.push(`${swapCounts.needs_review} needs review`);
    return parts.length ? `<span class="model-swap-counts">${parts.join(' · ')}</span>` : '<span class="badge badge-neutral">Not started</span>';
  };

  const legacyRows = submissions.map((s) => {
    const counts = submissionCounts[s.id] || { face: 0, target: 0 };
    const photos = photoCell('submission', s.id, counts, (swapCountsBySubmission[s.id] || {}).done);
    const link = `${origin}/upload?token=${s.upload_token}`;
    return `<tr>
        <td data-label="Name">${escapeHtml(s.name)}</td>
        <td data-label="Email"><a href="mailto:${escapeHtml(s.email)}">${escapeHtml(s.email)}</a></td>
        <td data-label="Phone">${escapeHtml(s.phone || '—')}</td>
        <td data-label="Submitted">${escapeHtml(formatDate(s.created_at))}</td>
        <td data-label="Photos">${photos.label}</td>
        <td data-label="Paid">${paidBadge(s.paid_at)}</td>
        <td data-label="Swaps">${swapStatusCell(swapCountsBySubmission[s.id] || {})}</td>
        <td class="link-cell" data-label="Upload link">
          <code>${escapeHtml(link)}</code>
          <button type="button" class="copy-btn" data-copy="${escapeHtml(link)}">Copy</button>
        </td>
        <td class="actions-cell" data-label="Actions">
          ${photos.downloads}
          <button type="button" class="delete-btn" data-type="submission" data-id="${s.id}">Delete</button>
        </td>
      </tr>`;
  });

  const accountRows = profiles.map((p) => {
    const counts = profileCounts[p.id] || { face: 0, target: 0 };
    const photos = photoCell('profile', escapeHtml(p.id), counts, (swapCountsByProfile[p.id] || {}).done);
    return `<tr>
        <td data-label="Name">${escapeHtml(p.name)}</td>
        <td data-label="Email">${p.email ? `<a href="mailto:${escapeHtml(p.email)}">${escapeHtml(p.email)}</a>` : '—'}</td>
        <td data-label="Phone">${escapeHtml(p.phone)}</td>
        <td data-label="Submitted">${escapeHtml(formatDate(p.created_at))}</td>
        <td data-label="Photos">${photos.label}</td>
        <td data-label="Paid">${paidBadge(p.paid_at)}</td>
        <td data-label="Swaps">${swapStatusCell(swapCountsByProfile[p.id] || {})}</td>
        <td data-label="View as"><button type="button" class="view-as-btn" data-view-as data-user-id="${escapeHtml(p.id)}">View as →</button></td>
        <td class="actions-cell" data-label="Actions">
          ${photos.downloads}
          <button type="button" class="delete-btn" data-type="profile" data-id="${escapeHtml(p.id)}">Delete</button>
        </td>
      </tr>`;
  });

  const totalCount = submissions.length + profiles.length;
  const rows = accountRows.concat(legacyRows).join('');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Leads — Better Hello Studio admin</title>
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <style>
      :root { --ink:#10162a; --paper:#f7f5ef; --blue:#315cff; --coral:#ff755e; --line:rgba(16,22,42,.15); }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--paper); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px 32px; }
      h1 { font-size: 24px; letter-spacing: -.02em; margin: 0 0 4px; }
      p.sub { color: #5a6173; margin: 0 0 28px; font-size: 14px; }
      table { width: 100%; border-collapse: collapse; background: #fff; box-shadow: 0 1px 3px rgba(16,22,42,.08); }
      th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: top; }
      th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #747b8d; background: #fbfaf7; }
      tr:last-child td { border-bottom: none; }
      a { color: var(--blue); }
      .link-cell { display: flex; align-items: center; gap: 8px; max-width: 420px; }
      .link-cell code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; background: var(--paper); padding: 4px 6px; }
      .copy-btn { flex-shrink: 0; border: 1px solid var(--line); background: #fff; padding: 5px 10px; font-size: 12px; cursor: pointer; }
      .copy-btn:hover { border-color: var(--blue); color: var(--blue); }
      .copy-btn.is-copied { border-color: #2f8f5b; color: #2f8f5b; }
      .badge { display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #2f8f5b; background: rgba(47,143,91,.1); padding: 4px 8px; }
      .badge-neutral { color: #747b8d; background: rgba(116,123,141,.1); }
      .model-swap-counts { display: block; margin-top: 4px; font-size: 11px; color: #747b8d; }
      .view-as-btn { flex-shrink: 0; border: 1px solid var(--line); background: #fff; color: var(--ink); padding: 5px 10px; font-size: 12px; cursor: pointer; }
      .view-as-btn:hover { border-color: var(--blue); color: var(--blue); }
      .view-as-btn:disabled { opacity: .5; cursor: default; }
      .actions-cell { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
      .download-btn { flex-shrink: 0; display: inline-block; border: 1px solid var(--line); background: #fff; color: var(--ink); padding: 5px 10px; font-size: 12px; text-decoration: none; }
      .download-btn:hover { border-color: var(--blue); color: var(--blue); }
      .delete-btn { flex-shrink: 0; border: 1px solid rgba(192,57,43,.35); background: #fff; color: #c0392b; padding: 5px 10px; font-size: 12px; cursor: pointer; }
      .delete-btn:hover { background: #c0392b; color: #fff; border-color: #c0392b; }
      .delete-btn:disabled { opacity: .5; cursor: default; }
      .empty { padding: 40px; text-align: center; color: #747b8d; }

      .modal-overlay { position: fixed; inset: 0; background: rgba(16,22,42,.6); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 50; }
      .modal-overlay[hidden] { display: none; }
      .modal-panel { position: relative; background: #fff; padding: 32px; max-width: 760px; width: 100%; max-height: 90vh; overflow-y: auto; box-sizing: border-box; }
      .modal-panel h2 { margin: 0 0 4px; font-size: 18px; }
      .modal-close { position: absolute; top: 14px; right: 14px; border: none; background: none; font-size: 22px; line-height: 1; cursor: pointer; color: #747b8d; }
      .modal-close:hover { color: var(--ink); }

      @media (max-width: 750px) {
        body { padding: 20px 14px; }
        h1 { font-size: 20px; }
        /* Classic responsive-table technique: the table becomes a stack of
           card-like rows, each cell labeled by its own column header (via
           data-label, set per-cell above) since <thead> is hidden. */
        table { display: block; box-shadow: none; background: none; }
        thead { display: none; }
        tbody { display: block; }
        tr { display: block; background: #fff; box-shadow: 0 1px 3px rgba(16,22,42,.08); margin-bottom: 10px; padding: 4px 0; }
        tr:last-child { margin-bottom: 0; }
        td { display: block; border-bottom: none; padding: 6px 12px; }
        td::before { content: attr(data-label); display: block; font: 600 10px -apple-system, BlinkMacSystemFont, sans-serif; text-transform: uppercase; letter-spacing: .04em; color: #747b8d; margin-bottom: 3px; }
        .link-cell { max-width: none; width: 100%; }
        .link-cell code { font-size: 11px; min-width: 0; }
        .actions-cell { flex-wrap: wrap; white-space: normal; }

        .modal-overlay { padding: 0; }
        .modal-panel { max-width: 100%; max-height: 100%; height: 100%; padding: 20px 16px; }
      }
    </style>
  </head>
  <body>
    <h1>Leads</h1>
    <p class="sub">${totalCount} total — ${profiles.length} signed-in account${profiles.length === 1 ? '' : 's'}, ${submissions.length} legacy link${submissions.length === 1 ? '' : 's'}.</p>
    ${
      totalCount
        ? `<table>
      <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Submitted</th><th>Photos</th><th>Paid</th><th>Swaps</th><th>Upload link</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`
        : '<p class="empty">No leads yet.</p>'
    }

    <script>
      document.querySelectorAll('.copy-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(btn.dataset.copy);
          } catch (err) {
            const codeEl = btn.previousElementSibling;
            const range = document.createRange();
            range.selectNodeContents(codeEl);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand('copy');
            selection.removeAllRanges();
          }
          btn.textContent = 'Copied';
          btn.classList.add('is-copied');
          setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('is-copied');
          }, 1500);
        });
      });

      document.querySelectorAll('.view-as-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const { userId } = btn.dataset;
          btn.disabled = true;
          const previousText = btn.textContent;
          btn.textContent = 'Loading…';
          try {
            const res = await fetch('/api/admin-action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'view-as', userId }),
            });
            if (!res.ok) throw new Error('view-as failed');
            const { url } = await res.json();
            window.open(url, '_blank', 'noopener');
          } catch (err) {
            alert('Could not generate a view-as link. Please try again.');
          }
          btn.disabled = false;
          btn.textContent = previousText;
        });
      });

      document.querySelectorAll('.delete-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const { type, id } = btn.dataset;
          if (!confirm('Delete this lead and all their uploaded photos? This cannot be undone.')) return;
          btn.disabled = true;
          btn.textContent = 'Deleting…';
          try {
            const res = await fetch('/api/admin-action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'delete', type, id }),
            });
            if (!res.ok) throw new Error('delete failed');
            btn.closest('tr').remove();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Delete';
            alert('Could not delete this lead. Please try again.');
          }
        });
      });

    </script>
  </body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(200).send(html);
};
