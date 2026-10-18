/**
 * The package's public API, checked against reports kept in api/ (one per
 * entry point). Any change to what consumers can import — a new export, a
 * changed signature, a removed type — shows up as a diff of api/*.api.md, so
 * it is reviewed, and versioned (semver), on purpose.
 *
 *   npm run api          fails when the API differs from the reports (CI)
 *   npm run api:update   rewrites the reports after an intended change
 *
 * Runs on the built .d.ts files (npm run build first).
 */
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const update = process.argv.includes('--update');
const ENTRIES = { index: 'dist/index.d.ts', background: 'dist/background/index.d.ts', core: 'dist/core/index.d.ts', 'core-auth': 'dist/core/auth.d.ts', client: 'dist/client.d.ts', types: 'dist/types.d.ts' };

let failed = false;
for (const [name, entry] of Object.entries(ENTRIES)) {
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: root,
      mainEntryPointFilePath: path.join(root, entry),
      compiler: { tsconfigFilePath: path.join(root, 'tsconfig.json') },
      apiReport: { enabled: true, reportFolder: path.join(root, 'api'), reportTempFolder: path.join(root, 'temp'), reportFileName: `${name}.api.md` },
      newlineKind: 'lf',
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: {
        extractorMessageReporting: { default: { logLevel: 'none' }, 'ae-missing-release-tag': { logLevel: 'none' } },
        tsdocMessageReporting: { default: { logLevel: 'none' } },
        compilerMessageReporting: { default: { logLevel: 'warning' } },
      },
    },
    configObjectFullPath: path.join(root, 'api-extractor.json'),
    packageJsonFullPath: path.join(root, 'package.json'),
  });
  const result = Extractor.invoke(config, { localBuild: update, showVerboseMessages: false });
  if (result.apiReportChanged && !update) {
    console.error(`api/${name}.api.md: the public API changed. If that is intended, run \`npm run api:update\`, commit the report, and version accordingly.`);
    failed = true;
  } else if (!result.succeeded && !result.apiReportChanged) {
    console.error(`api/${name}: ${result.errorCount} errors`);
    failed = true;
  } else {
    console.log(`api/${name}.api.md ${update && result.apiReportChanged ? 'updated' : 'up to date'}`);
  }
}
process.exit(failed ? 1 : 0);
