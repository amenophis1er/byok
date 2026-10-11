#!/usr/bin/env node
/**
 * `npm run dev`: rebuild the library into example/demo/lib on every save, and
 * have the loaded demo reload itself.
 *
 * tsc watches src/ and writes straight into the demo; the DNR rules are copied
 * whenever they change. Any change under example/demo (the rebuilt library
 * included) is written, debounced, to example/demo/dev-reload.json. The demo
 * page polls that file (an unpacked extension is served from disk): a page-only
 * change reloads the page, and a change the worker loads reloads the extension,
 * whose worker then reopens the page. Without the file (no dev server), the
 * demo does nothing.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const demo = `${root}example/demo/`;
const rules = `${root}manifest/dnr-rules.json`;
const marker = `${demo}dev-reload.json`;

/** Files the worker loads: changing one needs an extension reload, not a page reload. */
const forWorker = (file) =>
  file === 'background.js' || file === 'manifest.json' || file === 'rules.json' || file.startsWith('lib/');
/** Files nothing loads: declaration files, and the marker itself. */
const ignored = (file) => file === 'dev-reload.json' || file.endsWith('.d.ts');

const copyRules = () => copyFileSync(rules, `${demo}rules.json`);
copyRules();
watch(rules, copyRules);

let pending = new Set();
let timer;
watch(demo, { recursive: true }, (_event, name) => {
  const file = name?.split('\\').join('/');
  if (!file || ignored(file)) return;
  pending.add(file);
  clearTimeout(timer);
  // tsc writes many files per rebuild: one reload for the batch.
  timer = setTimeout(() => {
    const files = [...pending];
    pending = new Set();
    const worker = files.some(forWorker);
    writeFileSync(marker, JSON.stringify({ stamp: Date.now(), worker }));
    console.log(`[dev] ${worker ? 'extension' : 'page'} reload: ${files.slice(0, 4).join(', ')}${files.length > 4 ? ', …' : ''}`);
  }, 300);
});

const tsc = spawn(
  'npx',
  ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput', '--outDir', 'example/demo/lib'],
  { cwd: root, stdio: 'inherit' },
);

const stop = () => {
  tsc.kill();
  rmSync(marker, { force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
tsc.on('exit', (code) => {
  rmSync(marker, { force: true });
  process.exit(code ?? 0);
});

console.log('[dev] Watching src/ and example/demo. Load example/demo unpacked in chrome://extensions once; it reloads itself from here on.');
