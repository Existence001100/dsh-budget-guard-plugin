/**
 * Repo-wide BOM guard.
 *
 * A UTF-8 BOM in `package.json` is not cosmetic: Node's JSON.parse rejects it,
 * DSH's plugin manager then reports the bundle as `missing`, the plugin
 * disappears from the tree and every `/dsh-budget/*` route 404s. That actually
 * happened (see 交接文档 3.4), so this check runs as part of `npm test`.
 *
 * YAML/JSON files are checked as well because DSH's loader reads several of
 * them (`cordis.patch.yml`, `prices/*.json`, `locale/*.json`); whether every
 * parser tolerates a BOM is `TODO: 需确认`, and the cheapest answer is "no BOM
 * anywhere".
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL#pathname: the latter stays percent-encoded on Windows
// and this workspace path contains spaces and CJK characters.
const root = fileURLToPath(new URL('..', import.meta.url));
const CHECKED = new Set(['.json', '.yml', '.yaml', '.ts', '.js', '.mjs', '.md', '.svg']);
// `lib/` is generated, but it is what actually loads at runtime: a BOM that
// build.mjs carried over from src would fail there, not in src. Scan it too
// (read-only — this test never writes).
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.tmp-')) continue;
      walk(join(dir, entry.name), found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.tmp-')) continue;
    if (!CHECKED.has(extname(entry.name).toLowerCase())) continue;
    found.push(join(dir, entry.name));
  }
  return found;
}

const files = walk(root).sort();
assert.ok(files.length > 10, `expected to scan the repo, only saw ${files.length} files`);

// `lib/` is generated, but it is the code that actually loads at runtime, so a
// BOM carried over by build.mjs would fail there rather than in src. Pin the
// scan to include it instead of trusting the walker.
const relativeFiles = files.map((file) => relative(root, file).split('\\').join('/'));
assert.ok(
  relativeFiles.includes('lib/client.js'),
  `the scan must include the generated lib/ (scanned: ${relativeFiles.filter((name) => name.startsWith('lib/')).join(', ') || 'none'})`,
);
assert.ok(relativeFiles.some((name) => name.startsWith('lib/')), 'lib/ is part of the BOM scan');

const withBom = [];
for (const file of files) {
  const bytes = readFileSync(file);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    withBom.push(relative(root, file));
  }
}

assert.deepEqual(withBom, [], `UTF-8 BOM found in: ${withBom.join(', ')}`);

// `package.json` is the one that must also *parse*, not merely lack a BOM.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(typeof pkg.name, 'string');
assert.ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, 'package.json still declares the bundle patch');

console.log(`bom tests passed (${files.length} files scanned)`);
