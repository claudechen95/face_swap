import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdminAuth } from './_lib/adminAuth.js';

/**
 * Server-rendered shell for the admin pipeline tool (crop/upscale/mask/
 * Ideogram character-swap), gated by requireAdminAuth same as api/admin.ts.
 * A static HTML file wouldn't get that gate -- requireAdminAuth only runs
 * inside api/*.ts handlers -- so this just returns the HTML directly; all
 * real data loading happens client-side against admin-pipeline-data.ts/
 * admin-pipeline-action.ts/admin-pipeline-run.ts, same as face_swap/'s old
 * embedded-script page but pointed at the new endpoints.
 */

const HTML = `<!doctype html>
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

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(200).send(HTML);
};
