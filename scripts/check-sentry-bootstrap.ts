import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const distDirectory = join(process.cwd(), 'dist');
const entrySource = readFileSync(join(distDirectory, 'index.js'), 'utf8');
const dynamicImports = [...entrySource.matchAll(/import\(["'](.+?)["']\)/g)].map((match) => match[1]);

if (dynamicImports.length < 2) {
  throw new Error('Production server entry must retain separate instrumentation and application imports');
}

const importedSources = dynamicImports.map((relativePath) =>
  readFileSync(join(distDirectory, relativePath), 'utf8'),
);
const instrumentationIndex = importedSources.findIndex((source) => source.includes('SENTRY_TRACES_SAMPLE_RATE'));
const applicationIndex = importedSources.findIndex((source) =>
  /from ["']express["']/.test(source) || source.includes('setupExpressErrorHandler'),
);

if (instrumentationIndex < 0 || applicationIndex < 0 || instrumentationIndex >= applicationIndex) {
  throw new Error('Production bundle does not initialize Sentry before loading the Express application');
}

const serverChunkDirectory = join(distDirectory, 'server-chunks');
const allServerSources = [entrySource, ...readdirSync(serverChunkDirectory)
  .filter((name) => name.endsWith('.js'))
  .map((name) => readFileSync(join(serverChunkDirectory, name), 'utf8'))];
if (!allServerSources.some((source) => source.includes('setupExpressErrorHandler'))) {
  throw new Error('Production bundle is missing Sentry Express error handling');
}

console.log('[sentry-bootstrap] production bundle preserves Sentry-before-Express loading');
