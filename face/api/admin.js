const { createClient } = require('@supabase/supabase-js');
const { requireAdminAuth } = require('./_lib/adminAuth');
const { resolveKind } = require('./_lib/identity');

const FACE_MAX = resolveKind({ kind: 'face' }).max;
const TARGET_MAX = resolveKind({ kind: 'target' }).max;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

module.exports = async function handler(req, res) {
  if (!requireAdminAuth(req, res)) return;

  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
    return res.status(500).send('Server misconfigured');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

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

  const submissionCounts = {};
  const profileCounts = {};
  for (const row of photos) {
    const kind = row.kind === 'target' ? 'target' : 'face';
    if (row.submission_id) {
      submissionCounts[row.submission_id] = submissionCounts[row.submission_id] || { face: 0, target: 0 };
      submissionCounts[row.submission_id][kind] += 1;
    }
    if (row.user_id) {
      profileCounts[row.user_id] = profileCounts[row.user_id] || { face: 0, target: 0 };
      profileCounts[row.user_id][kind] += 1;
    }
  }

  const { data: swapJobs, error: swapJobsError } = await supabase
    .from('swap_jobs')
    .select('submission_id, user_id, status');

  if (swapJobsError) {
    console.error('admin swap_jobs query failed', swapJobsError);
    return res.status(500).send('Could not load leads');
  }

  const swapCountsBySubmission = {};
  const swapCountsByProfile = {};
  for (const row of swapJobs) {
    const bucket = row.submission_id
      ? (swapCountsBySubmission[row.submission_id] = swapCountsBySubmission[row.submission_id] || { done: 0, processing: 0, failed: 0, needs_review: 0, mask_review: 0 })
      : (swapCountsByProfile[row.user_id] = swapCountsByProfile[row.user_id] || { done: 0, processing: 0, failed: 0, needs_review: 0, mask_review: 0 });
    bucket[row.status] += 1;
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${host}`;

  const formatDate = (value) =>
    new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  const photoCell = (type, id, counts, doneSwapCount) => {
    const face = counts.face || 0;
    const target = counts.target || 0;
    const downloads = [];
    if (face) downloads.push(`<a class="download-btn" href="/api/admin-download-photos?type=${type}&id=${id}&kind=face">Face (${face})</a>`);
    if (target) downloads.push(`<a class="download-btn" href="/api/admin-download-photos?type=${type}&id=${id}&kind=target">Swap (${target})</a>`);
    if (doneSwapCount) downloads.push(`<a class="download-btn" href="/api/admin-download-photos?type=${type}&id=${id}&kind=results">Results (${doneSwapCount})</a>`);
    return { label: `${face}/${FACE_MAX} face · ${target}/${TARGET_MAX} swap`, downloads: downloads.join('') };
  };

  const paidBadge = (paidAt) =>
    paidAt
      ? `<span class="badge" title="${escapeHtml(formatDate(paidAt))}">Paid</span>`
      : '<span class="badge badge-neutral">Unpaid</span>';

  const swapStatusCell = (swapCounts) => {
    const parts = [];
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
