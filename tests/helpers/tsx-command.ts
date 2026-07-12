import { join } from 'node:path';

/** Resolve the repository-local tsx CLI without a platform shell shim. */
export const TSX_CLI = join(
  process.cwd(),
  'node_modules',
  'tsx',
  'dist',
  'cli.mjs',
);
