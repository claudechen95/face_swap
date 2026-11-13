#!/usr/bin/env node
// One-off: bulk-upload a folder of stock/library photos into the public
// swap-library bucket and register each in library_photos. Skips files
// whose storage_path already exists (safe to re-run after a partial run).
//
// Usage: node scripts/upload-library-photos.js <source_dir>

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Minimal .env.local loader (no dotenv dependency in this project).
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match) process.env[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
}

const BUCKET = 'swap-library';
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// Source filenames are literal encoded download URLs
// (image_url=https%3A%2F%2Fonepercentcdn.com%2Fpb%2F<uuid>.jpg) -- pull out
// the embedded UUID as a stable destination name so re-running this script
// after a partial failure can detect and skip already-uploaded files
// instead of re-uploading everything with a fresh random name each time.
function stableNameFor(sourceFilename) {
  const match = sourceFilename.match(UUID_RE);
  return match ? match[1] : path.parse(sourceFilename).name;
}

async function detectMime(filePath) {
  const buf = Buffer.alloc(8);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, 8, 0);
  fs.closeSync(fd);
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  return null;
}

async function main() {
  const srcDir = process.argv[2];
  if (!srcDir) {
    console.error('Usage: node scripts/upload-library-photos.js <source_dir>');
    process.exit(1);
  }

  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local');
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const files = fs.readdirSync(srcDir).filter((f) => !f.startsWith('.'));
  console.log(`Found ${files.length} files in ${srcDir}`);

  const { data: existingRows } = await supabase.from('library_photos').select('storage_path');
  const existingPaths = new Set((existingRows || []).map((r) => r.storage_path));

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const [i, name] of files.entries()) {
    const filePath = path.join(srcDir, name);
    const mime = await detectMime(filePath);
    const ext = EXT_BY_MIME[mime];
    if (!ext) {
      console.warn(`SKIP (unrecognized file type): ${name}`);
      failed++;
      continue;
    }

    const storagePath = `${stableNameFor(name)}.${ext}`;
    if (existingPaths.has(storagePath)) {
      skipped++;
      continue;
    }

    const data = fs.readFileSync(filePath);
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, data, { contentType: mime, upsert: false });

    if (uploadError) {
      console.error(`FAILED upload ${name}: ${uploadError.message}`);
      failed++;
      continue;
    }

    const { error: insertError } = await supabase.from('library_photos').insert({ storage_path: storagePath });
    if (insertError) {
      console.error(`FAILED db insert ${name}: ${insertError.message}`);
      failed++;
      continue;
    }

    uploaded++;
    if ((i + 1) % 50 === 0) console.log(`... ${i + 1}/${files.length}`);
  }

  console.log(`Done. Uploaded ${uploaded}, skipped ${skipped}, failed ${failed}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
