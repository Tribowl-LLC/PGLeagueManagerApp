import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APPLE_PAY_DOMAIN_VERIFICATION_FILENAME =
  'apple-developer-merchantid-domain-association';

export async function copyApplePayVerificationFile(
  projectRoot = path.resolve(import.meta.dirname, '..'),
): Promise<string> {
  const root = path.resolve(projectRoot);
  const sourcePath = path.join(root, '.well-known', APPLE_PAY_DOMAIN_VERIFICATION_FILENAME);
  const destinationPath = path.join(root, 'dist', '.well-known', APPLE_PAY_DOMAIN_VERIFICATION_FILENAME);

  const sourceContents = await readFile(sourcePath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);

  const destinationContents = await readFile(destinationPath);
  if (!sourceContents.equals(destinationContents)) {
    throw new Error(
      `Apple Pay verification artifact does not match its source: ${destinationPath}`,
    );
  }

  return destinationPath;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  copyApplePayVerificationFile()
    .then((destinationPath) => {
      process.stdout.write(`[apple-pay-verification] copied ${destinationPath}\n`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[apple-pay-verification] failed: ${message}\n`);
      process.exitCode = 1;
    });
}
