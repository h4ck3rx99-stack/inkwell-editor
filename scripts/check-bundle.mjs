// Verifies that no API key material reaches the client bundle.
// Scans every file Next.js serves to browsers (.next/static) for:
//   - known key prefixes (sk-ant-, sk-proj-, sk-…)
//   - the names of secret env vars
//   - the actual values of any secret env vars present at build time
//   - an optional canary value (INKWELL_BUNDLE_CANARY) injected as a fake key at build time
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), '.next', 'static');
const SECRET_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'INKWELL_AI_API_KEY'];
const patterns = [
  { name: 'Anthropic key prefix', re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: 'OpenAI project key prefix', re: /sk-proj-[A-Za-z0-9_-]{8,}/ },
  { name: 'generic sk- key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  ...SECRET_VARS.map((v) => ({ name: `env var name ${v}`, re: new RegExp(`\\b${v}\\b`) })),
];
const literals = [];
for (const v of SECRET_VARS) {
  const value = process.env[v];
  if (value && value.length >= 8) literals.push({ name: `value of ${v}`, value });
}
if (process.env.INKWELL_BUNDLE_CANARY) literals.push({ name: 'canary', value: process.env.INKWELL_BUNDLE_CANARY });

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs|css|html|json|txt|map)$/.test(entry)) out.push(p);
  }
  return out;
}

let files;
try {
  files = walk(root);
} catch {
  console.error('No .next/static directory. Run `pnpm build` first.');
  process.exit(2);
}

const problems = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const p of patterns) if (p.re.test(text)) problems.push(`${p.name} in ${file}`);
  for (const l of literals) if (text.includes(l.value)) problems.push(`${l.name} in ${file}`);
}

if (problems.length) {
  console.error('Key material found in the client bundle:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`Client bundle clean: scanned ${files.length} files; ${literals.length} secret value(s)/canary checked; no key material found.`);
