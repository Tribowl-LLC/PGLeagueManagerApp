/**
 * Recovery helpers for stale Vite chunks and module MIME failures.
 *
 * A rolling deploy can leave an already-open tab with an old entry module
 * while the server has removed that entry's hashed chunks. The browser then
 * reports a dynamic-import or module-MIME error. Retrying the same import
 * cannot repair that state; one guarded hard refresh can load the new entry,
 * while a second failure must settle on a stable UI instead of refreshing
 * forever.
 */

export const ASSET_RECOVERY_STORAGE_KEY = 'leaguevault:asset-recovery';

export type AssetRecoveryResult = 'not_asset' | 'refreshing' | 'fallback';

interface AssetRecoveryMarker {
  release: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function property(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null || !(key in error)) return undefined;
  return (error as Record<string, unknown>)[key];
}

function text(error: unknown): string {
  const values = [
    property(error, 'message'),
    property(error, 'filename'),
    property(error, 'url'),
    typeof error === 'string' ? error : undefined,
  ];
  return values.filter((value): value is string => typeof value === 'string').join(' ');
}

/** Identify browser errors caused by a missing/stale JavaScript module. */
export function isAssetLoadError(error: unknown): boolean {
  const value = text(error);
  if (!value) return false;
  return /failed to fetch dynamically imported module|importing a module script failed|chunkloaderror|loading (?:javascript )?chunk|module script .*mime type|expected a javascript module script|\/assets\/[^\s"']+\.(?:js|mjs)(?:[?#\s]|$)/i.test(value);
}

/**
 * Return the current entry's immutable hashed path. Vite emits the entry
 * script in `/assets/` for production, so its path changes with every build
 * and naturally scopes the refresh guard to one release. Development's
 * `/src/main.tsx` path remains a stable one-attempt guard.
 */
export function getAssetReleaseKey(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): string {
  if (!doc) return 'unknown';
  const script = doc.querySelector('script[type="module"][src], script[src*="/assets/"]');
  const src = script?.getAttribute('src');
  if (!src) return 'unknown';
  try {
    return new URL(src, doc.baseURI).pathname;
  } catch {
    return src.split(/[?#]/, 1)[0] || 'unknown';
  }
}

function getSessionStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    // Browsers can deny storage in private mode or under a restrictive CSP.
    return null;
  }
}

function readMarker(storage: StorageLike | null): AssetRecoveryMarker | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(ASSET_RECOVERY_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const release = (parsed as Record<string, unknown>).release;
    return typeof release === 'string' && release.length > 0 ? { release } : null;
  } catch {
    return null;
  }
}

function writeMarker(storage: StorageLike | null, release: string): void {
  if (!storage) return;
  try {
    storage.setItem(ASSET_RECOVERY_STORAGE_KEY, JSON.stringify({ release } satisfies AssetRecoveryMarker));
  } catch {
    // The in-memory fallback below still prevents loops in this page.
  }
}

let memoryAttemptedRelease: string | null = null;

/** True once this release has already used its automatic refresh. */
export function hasAttemptedAssetRecovery(
  release = getAssetReleaseKey(),
  storage: StorageLike | null = getSessionStorage(),
): boolean {
  return memoryAttemptedRelease === release || readMarker(storage)?.release === release;
}

/**
 * Refresh once for an asset failure. The caller can render its stable
 * fallback when this returns `fallback`; no caller should invoke reload a
 * second time automatically.
 */
export function recoverFromAssetFailure(
  error: unknown,
  options: {
    release?: string;
    storage?: StorageLike | null;
    reload?: () => void;
  } = {},
): AssetRecoveryResult {
  if (!isAssetLoadError(error)) return 'not_asset';
  const release = options.release ?? getAssetReleaseKey();
  const storage = options.storage === undefined ? getSessionStorage() : options.storage;
  if (hasAttemptedAssetRecovery(release, storage)) return 'fallback';

  memoryAttemptedRelease = release;
  writeMarker(storage, release);
  try {
    (options.reload ?? (() => window.location.reload()))();
    return 'refreshing';
  } catch {
    return 'fallback';
  }
}

/**
 * Catch asset errors that occur outside a React error boundary as well as
 * lazy-route failures. The browser's normal unhandled-error/Sentry handling
 * remains enabled after the one guarded refresh has been consumed.
 */
export function installAssetRecoveryHandlers(): () => void {
  if (typeof window === 'undefined') return () => {};

  const onError = (event: ErrorEvent): void => {
    // Script load errors often expose no Error object and use the generic
    // "Script error" message. Preserve the filename alongside that message
    // so a missing `/assets/*.js` still reaches the release guard.
    const candidate = event.error ?? { message: event.message, filename: event.filename };
    if (recoverFromAssetFailure(candidate) === 'refreshing') event.preventDefault();
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (recoverFromAssetFailure(event.reason) === 'refreshing') event.preventDefault();
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Test-only reset for the module-local fallback when storage is unavailable. */
export function resetAssetRecoveryForTests(): void {
  memoryAttemptedRelease = null;
}
