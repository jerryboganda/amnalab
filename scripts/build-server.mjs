// Bundles the API server and the restore tool into single ESM files under dist/server.
// Dependencies are bundled in, so the installed app needs no node_modules folder at runtime
// beyond what the bundle already contains. Node built-ins (node:sqlite, node:http, ...) stay external.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist/server', { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  sourcemap: false,
  logLevel: 'info',
  // Forme and React must exist once only. The Forme serializer identifies components by identity,
  // so a second bundled copy silently produces an empty PDF. Forme's engine also loads its WASM from its own folder.
  external: ['@formepdf/core', '@formepdf/react', 'react', 'react/*'],
  // Some bundled CommonJS code calls require(); give it a real require in ESM output.
  banner: {
    js: "import { createRequire as __lmsCreateRequire } from 'node:module'; const require = __lmsCreateRequire(import.meta.url);",
  },
};

await build({ ...shared, entryPoints: ['src/server/index.ts'], outfile: 'dist/server/index.js' });
await build({ ...shared, entryPoints: ['src/server/cli/restore.ts'], outfile: 'dist/server/restore.js' });
console.log('Server bundles written to dist/server');
