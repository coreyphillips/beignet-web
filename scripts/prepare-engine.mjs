import { mkdirSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Git dependencies build their portable bundles during npm's prepare step.
// Resolve sql.js from that installed engine so clean clones need no siblings.
const engineRequire = createRequire(import.meta.resolve('@beignet/portable-engine'));
const wasm = engineRequire.resolve('sql.js/dist/sql-wasm.wasm');
const output = new URL('../public/engine/', import.meta.url);
mkdirSync(output, { recursive: true });
copyFileSync(wasm, new URL('sql-wasm.wasm', output));
