import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await build({ entryPoints: ['index.tsx', 'native.ts'], bundle: true, outdir: '/tmp/nitrosniper-check', write: false, platform: 'node', packages: 'external', jsx: 'automatic', target: 'es2022' });
for (const file of await readdir('bot')) if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', `bot/${file}`]);
console.log('Plugin bundles and bot syntax passed. Run upstream Vencord/Equicord type checks for host API compatibility.');
