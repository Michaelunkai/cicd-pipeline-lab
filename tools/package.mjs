/**
 * package.mjs — "Package" stage. Freezes the build output into a versioned,
 * checksummed ZIP artifact (the immutable thing that gets promoted between
 * environments — what you deploy is what you tested).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { zipFiles } from './zip.mjs';

const ROOT = path.resolve(process.cwd());
const distDir = path.join(ROOT, 'dist');
const artifactsDir = path.join(ROOT, 'artifacts');

if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
  console.error('package: dist/manifest.json missing — run the Build stage first (this is why stages declare needs)');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
const zipPath = path.join(artifactsDir, `taskflow-${manifest.version}.zip`);

const entries = fs
  .readdirSync(distDir)
  .filter(f => manifest.files[f])
  .map(f => ({ name: f, data: fs.readFileSync(path.join(distDir, f)) }));
zipFiles(entries, zipPath);

const zipBuf = fs.readFileSync(zipPath);
const sha = createHash('sha256').update(zipBuf).digest('hex');
console.log(`package: ${path.relative(ROOT, zipPath).replaceAll('\\', '/')} — ${entries.length} entries, ${(zipBuf.length / 1024).toFixed(1)} KiB`);
for (const e of entries) console.log(`  ${e.name}  (${e.data.length} bytes)`);
console.log(`package: sha256 ${sha}`);
