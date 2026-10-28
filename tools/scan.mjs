/**
 * scan.mjs — "Security scan" stage. Shift-left secret detection: scan source,
 * tests, tools, build output, and CI workflow files for credential-shaped
 * strings, and fail the pipeline when one is found. A secret that reaches a
 * log or an artifact is already an incident; the scan exists to catch it
 * before the merge, not after.
 */
import fs from 'node:fs';
import path from 'node:path';

// Default sweep covers the code the pipeline ships plus CI definitions; an
// explicit CLI argument scans exactly that directory (used by engine tests
// and safe to point at any path).
const TARGETS = process.argv[2] ? [process.argv[2]] : ['app/src', 'app/test', 'tools', 'dist', '.github/workflows', 'engine-tests'];
const EXCLUDED = path.join('engine-tests', 'fixtures'); // intentional lab fixtures, never real secrets

const PATTERNS = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/, hint: 'AWS access key id' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, hint: 'GitHub personal access token' },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, hint: 'embedded private key' },
  {
    id: 'assigned-secret',
    re: /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][^'"]{8,}['"]/i,
    hint: 'hard-coded credential assignment',
  },
  { id: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/, hint: 'bearer credential in source' },
];

const findings = [];
let filesChecked = 0;

const skip = abs => {
  const rel = path.relative(process.cwd(), abs).replaceAll('\\', '/');
  return rel === EXCLUDED || rel.startsWith(`${EXCLUDED}/`) || rel === '.pipeline' || rel.startsWith('.pipeline/');
};

for (const target of TARGETS) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) continue;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(dir, entry.name);
      if (skip(child)) continue;
      if (entry.isDirectory()) walk(child);
      else if (/\.(mjs|js|json|ya?ml|txt|cmd|ps1)$/i.test(entry.name)) scanFile(child);
    }
  };
  walk(abs);
}

function scanFile(abs) {
  filesChecked++;
  const rel = path.relative(process.cwd(), abs).replaceAll('\\', '/');
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.re.test(line)) findings.push(`${rel}:${i + 1}: ${p.id} (${p.hint})`);
    }
  });
}

// committed credential files are a finding of their own
for (const dangerous of ['.env', 'id_rsa', 'deploy_key.pem']) {
  if (fs.existsSync(path.resolve(dangerous))) findings.push(`${dangerous}: credential-file (must never be committed)`);
}

if (findings.length) {
  console.error(`scan: ${findings.length} finding(s) in ${filesChecked} files — pipeline blocked:`);
  for (const f of findings) console.error(`  ${f}`);
  console.error('Rotate any secret that touched a log, remove it from source, and use environment variables instead.');
  process.exit(1);
}
console.log(`scan: no secrets detected (${filesChecked} files, ${PATTERNS.length} patterns + credential-file check)`);
