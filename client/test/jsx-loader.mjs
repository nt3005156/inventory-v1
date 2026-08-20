/**
 * Minimal JSX loader for `node:test`.
 *
 * The repository's test convention is plain `node:test` with no framework on
 * top. Node cannot load `.jsx`, so this transforms it on the fly using
 * `rolldown`, which is ALREADY a dependency (Vite 7 bundles with it) — no new
 * build tooling is introduced just to run a handful of component tests.
 */
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {transform} from 'rolldown/experimental';

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.jsx')) return nextLoad(url, context);
  const source = await readFile(fileURLToPath(url), 'utf8');
  const result = await transform(fileURLToPath(url), source, {
    jsx: {mode: 'automatic', importSource: 'react'},
    lang: 'jsx'
  });
  return {format: 'module', source: result.code, shortCircuit: true};
}

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}
