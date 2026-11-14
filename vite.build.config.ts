import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// This stays a plain static site deployed as-is (favicons, assets/, legal
// pages, etc. all referenced by absolute root paths exactly as before) --
// Vite here only compiles the three TS entry modules into dist/*.js. No HTML
// entries are passed in, so Vite's HTML asset-rewriting never touches
// index.html/upload.html; they keep pointing at the compiled dist/ output
// via plain <script> tags, same as they pointed at raw .js before.
export default defineConfig({
  // Needed for new Worker(new URL('./x.js', import.meta.url)) (see
  // shared/src/mediapipeClient.ts) -- Vite resolves that pattern into an
  // absolute path rooted at `base` (default '/'), not a path relative to
  // the importing chunk's own URL, so without this it generates
  // /assets/mediapipeWorker-*.js instead of /dist/assets/mediapipeWorker-*.js
  // and the worker 404s. Plain inter-chunk `import` statements are
  // unaffected either way since those already use relative specifiers.
  base: '/dist/',
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        upload: resolve(__dirname, 'src/upload.ts'),
        auth: resolve(__dirname, 'src/auth.ts'),
        script: resolve(__dirname, 'src/script.ts'),
        adminPipeline: resolve(__dirname, 'src/adminPipeline.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      },
    },
  },
});
