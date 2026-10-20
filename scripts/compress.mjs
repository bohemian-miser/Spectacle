// After `vite build`: a brotli and a gzip copy of every text file in dist/,
// which the server sends instead when the browser takes them (serveStatic).
// Squeezed once here at the highest settings, not per request.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const DIST = new URL('../dist/', import.meta.url).pathname;
const TEXT = /\.(js|css|html|svg|json|txt|webmanifest)$/;
let before = 0;
let after = 0;
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, e.name);
    if (e.isDirectory()) walk(file);
    else if (TEXT.test(e.name) && statSync(file).size > 1024) {
      const body = readFileSync(file);
      const br = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
      writeFileSync(`${file}.br`, br);
      writeFileSync(`${file}.gz`, gzipSync(body, { level: 9 }));
      before += body.length;
      after += br.length;
    }
  }
};
walk(DIST);
console.log(`compress: ${(before / 1024).toFixed(0)} KB of text → ${(after / 1024).toFixed(0)} KB brotli`);
