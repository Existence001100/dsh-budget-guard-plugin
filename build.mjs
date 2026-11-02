/**
 * Build the bundle's `lib/` from `src/`.
 *
 * Every Host module is TypeScript 5 "erasable" syntax only: this script uses
 * Node's own `stripTypeScriptTypes` instead of a compiler dependency, so the
 * produced `lib/*.js` is plain ESM and installs without a toolchain.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('./', import.meta.url);
const HOST_MODULES = ['index.ts', 'pricing.ts'];

async function main() {
  await mkdir(new URL('lib/', root), { recursive: true });
  for (const name of HOST_MODULES) {
    const source = await readFile(new URL(`src/${name}`, root), 'utf8');
    const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
    await writeFile(new URL(`lib/${name.replace(/\.ts$/, '.js')}`, root), stripped, 'utf8');
  }
  const client = await readFile(new URL('src/client.js', root), 'utf8');
  await writeFile(new URL('lib/client.js', root), client, 'utf8');
  console.log(`built lib/${HOST_MODULES.map((name) => name.replace(/\.ts$/, '.js')).join(', lib/')} and lib/client.js`);
}

await main();
