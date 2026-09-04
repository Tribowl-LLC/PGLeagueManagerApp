import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { logger } from "@/lib/logger";
import {
  makeApiError,
  shouldRetryApiQuery,
  isAbortError,
} from "@/lib/api-error";

export {
  ApiError,
  makeApiError,
  classifyApiError,
  isExpectedApiError,
  shouldRetryApiQuery,
  isAbortError,
} from "@/lib/api-error";
export type {
  ApiErrorClassification,
  ApiErrorOptions,
} from "@/lib/api-error";

let csrfToken: string | null = null;
let csrfFetchPromise: Promise<string> | null = null;

async function fetchCsrfToken(): Promise<string> {
  const res = await fetch('/api/csrf-token', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch CSRF token');
  const json = await res.json();
  csrfToken = json.data.token;
  return csrfToken!;
}

async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  if (!csrfFetchPromise) {
    csrfFetchPromise = fetchCsrfToken().finally(() => { csrfFetchPromise = null; });
  }
  return csrfFetchPromise;
}

export function clearCsrfToken() {
  csrfToken = null;
}

export function initCsrfToken() {
  getCsrfToken().catch(() => {});
}

export async function csrfFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method || 'GET').toUpperCase();
  const needsCsrf = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  const buildInit = async (): Promise<RequestInit | undefined> => {
    if (!needsCsrf) return init;
    const token = await getCsrfToken();
    const existingHeaders = init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init?.headers as Record<string, string>) || {};
    return {
      ...init,
      headers: {
        ...existingHeaders,
        'x-csrf-token': token,
      },
    };
  };

  const res = await fetch(input, await buildInit());

  if (needsCsrf && res.status === 403) {
    const cloned = res.clone();
    try {
      const body = await cloned.json();
      if (body?.error?.code === 'CSRF_ERROR') {
        csrfToken = null;
        await fetchCsrfToken();
        return fetch(input, await buildInit());
      }
    } catch {}
  }

  return res;
}

export function parseRetryAfterSeconds(
  retryAfter: string | null,
  rateLimitReset: string | null,
): number | null {
  const nowSec = Math.floor(Date.now() / 1000);
  // Retry-After: either a non-negative integer "delta-seconds" or an HTTP-date.
  if (retryAfter != null) {
    const trimmed = retryAfter.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number.parseInt(trimmed, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    const dateMs = Date.parse(trimmed);
    if (Number.isFinite(dateMs)) {
      const delta = Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
      return delta;
    }
  }
  // RateLimit-Reset: typically delta-seconds (RFC draft), but some servers
  // emit absolute unix-epoch seconds — heuristically treat very large
  // values as absolute.
  if (rateLimitReset != null) {
    const n = Number.parseInt(rateLimitReset.trim(), 10);
    if (Number.isFinite(n) && n >= 0) {
      // Anything beyond ~1 day in the "delta" interpretation is almost
      // certainly an absolute epoch — convert by subtracting now.
      return n > 86400 ? Math.max(0, n - nowSec) : n;
    }
  }
  return null;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    let errorBody: unknown;
    let responseTextFallback: string | null = null;
    try {
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        errorBody = await res.json();
      } else {
        responseTextFallback = await res.text();
      }
    } catch {
      errorBody = undefined;
    }

    const fallbackMessage =
      (responseTextFallback ?? '').trim() || res.statusText || 'Request failed';
    const retryAfterSeconds = res.status === 429
      ? parseRetryAfterSeconds(
        res.headers.get('retry-after'),
        res.headers.get('ratelimit-reset'),
      )
      : undefined;
    const error = makeApiError(
      errorBody,
      res.status,
      fallbackMessage,
      retryAfterSeconds,
    );
    // Keep the status prefix used by the existing CSRF refresh path while
    // retaining the typed status/code fields for all other callers.
    error.message = `${res.status}: ${error.message}`;
    error.statusText = res.statusText || undefined;

    if (res.status === 403 && error.code === 'CSRF_ERROR') {
      csrfToken = null;
    }
    throw error;
  }
  return res;
}

function ensureApiPrefix(url: string): string {
  if (!url.startsWith('/api/')) {
    return `/api${url}`;
  }
  return url;
}

async function doApiRequest<T = unknown>(
  url: string,
  method: string,
  data?: unknown | undefined,
): Promise<{success: boolean; data: T; error?: {message: string; code?: string}}> {
  const apiUrl = ensureApiPrefix(url);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  const needsCsrf = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
  if (needsCsrf) {
    headers['x-csrf-token'] = await getCsrfToken();
  }

  const res = await fetch(apiUrl, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  const validatedRes = await throwIfResNotOk(res);
  const jsonData = await validatedRes.json();
  return jsonData;
}

export async function apiRequest<T = unknown>(
  url: string,
  method: string,
  data?: unknown | undefined,
): Promise<{success: boolean; data: T; error?: {message: string; code?: string}}> {
  try {
    return await doApiRequest<T>(url, method, data);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '';
    if (errMsg.startsWith('403:') && csrfToken === null) {
      try {
        await fetchCsrfToken();
        return await doApiRequest<T>(url, method, data);
      } catch (retryError) {
        logger.error('API', `${method} retry after CSRF refresh failed`, retryError);
        throw retryError;
      }
    }
    logger.error('API', `${method} request failed`, error);
    throw error;
  }
}

export const getQueryFn: QueryFunction = async ({ queryKey, signal }) => {
  try {
    const url = ensureApiPrefix(queryKey[0] as string);

    const res = await fetch(url, {
      credentials: "include",
      headers: {
        "Accept": "application/json"
      },
      signal,
    });

    const validatedRes = await throwIfResNotOk(res);
    const data = await validatedRes.json();
    return data;
  } catch (error: unknown) {
    if (isAbortError(error)) {
      return undefined;
    }
    logger.error('Query', `Error fetching ${queryKey[0]}`, error);
    throw error;
  }
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn,
      retry: shouldRetryApiQuery,
      refetchOnWindowFocus: false,
      refetchOnMount: true,
      refetchOnReconnect: false,
      staleTime: 5000, // Consider data stale after 5 seconds
      gcTime: 1000 * 60 * 5, // Keep unused data in cache for 5 minutes
      // suspense: false, // Removed due to compatibility with TanStack Query v5
    },
    mutations: {
      retry: false,
    },
  },
});

export const prefetchQueries = async (role: 'admin' | 'bowler') => {
  try {
    if (role === 'admin') {
      await queryClient.prefetchQuery({ queryKey: ['/api/leagues'] });
    } else {
      await queryClient.prefetchQuery({ queryKey: ['/api/bowler-leagues'] });
    }
  } catch (error) {
    logger.error('Query', 'Error prefetching initial data', error);
  }
};
