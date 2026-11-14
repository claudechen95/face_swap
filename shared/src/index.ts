// Browser-safe barrel -- automask/faceDetector/maskCanvasEditor all use
// document/Image/canvas and are meant to run client-side. ideogram.ts is
// Node-only (fetch/FormData/Blob/Buffer, dynamic `sharp` import) and
// deliberately excluded here so bundling this package for the browser (see
// face/src/upload.ts) never pulls sharp and friends into a client bundle --
// import it from 'shared/server' instead (see shared/src/server.ts).
export * from './types.js';
export * from './automask.js';
export * from './faceDetector.js';
export * from './maskCanvasEditor.js';
