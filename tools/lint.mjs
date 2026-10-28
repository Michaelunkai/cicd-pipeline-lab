/**
 * lint.mjs — "Lint" stage. A tiny zero-dependency linter for the sample app:
 * real static checks (line length, tabs, trailing whitespace, forbidden
 * constructs) with file:line:col reporting, the way every CI linter works.
 */
import fs from 'node:fs';
import path from 'node:path';

const TARGETS = ['app/src', 'app/test'];
const MAX_LINE = 120;

const RULES = [
  { id: 'max-len', test: line => line.length > MAX_LINE, msg: `line exceeds ${MAX_LINE} characters` },
  { id: 'no-tabs', test: line => line.includes('\t'), msg: 'tab character (use spaces)' },
  { id: 'no-trailing-space', test: line => /[ \t]+$/.test(line), msg: 'trailing whitespace' },
  { id: 'no-console-log', test: line => /\bconsole\.log\(/.test(line), msg: 'console.log left in code (use a logger or remove)' },
  { id: 'no-debugger', test: line => /\bdebugger\b/.test(line), msg: 'debugger statement left in code' },
  { id: 'no-eval', test: line => /\beval\(/.test(line), msg: 'eval() is forbidden' },
  { id: 'no-unresolved-markers', test: line => /\b(TODO|FIXME|XXX)\b/.test(line), msg: 'unfinished-work marker must be resolved before merge' },
];

const violations = [];
let filesChecked = 0;

for (const target of TARGETS) {
  const dir = path.resolve(target);
  if (!fs.existsSync(dir)) continue; // a target that does not exist simply has nothing to lint
  const walk = abs => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) checkFile(child);
    }
  };
  walk(dir);
}

function checkFile(abs) {
  filesChecked++;
  const rel = path.relative(process.cwd(), abs).replaceAll('\\', '/');
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.test(line)) violations.push(`${rel}:${i + 1}:${rule.id}: ${rule.msg}`);
    }
  });
}

if (violations.length) {
  console.error(`lint: ${violations.length} violation(s) in ${filesChecked} file(s):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error('Fix the violations above, then re-run the pipeline.');
  process.exit(1);
}
console.log(`lint: clean (${filesChecked} files checked, ${RULES.length} rules)`);
