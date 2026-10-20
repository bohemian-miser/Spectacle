// The server as one file, dist-server/index.mjs, run with plain `node`: no
// tsx compiling TypeScript at startup, no npm process in front, no
// node_modules in the image (ws is bundled in). shared/ still ships beside
// it — the hot-loaded brains' key is a hash of that source (server/brains.ts).
import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // ws's optional native speed-ups: it falls back to JS without them.
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS: give its require() of Node's builtins a real one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});
