// Copies harper.js's slim WebAssembly binary into public/ so the local
// analysis worker can load it as a same-origin static asset.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// harper.js only exposes ESM `import` conditions, so resolve its entry
// (dist/index.js) and take the WASM that sits next to it.
const distDir = dirname(fileURLToPath(import.meta.resolve('harper.js')));
const src = join(distDir, 'harper_wasm_slim_bg.wasm');
const outDir = join(process.cwd(), 'public', 'harper');
const dest = join(outDir, 'harper_wasm_slim_bg.wasm');

mkdirSync(outDir, { recursive: true });
if (!existsSync(dest) || statSync(dest).size !== statSync(src).size) {
  copyFileSync(src, dest);
  console.log('[inkwell] copied harper WASM to public/harper/');
}
