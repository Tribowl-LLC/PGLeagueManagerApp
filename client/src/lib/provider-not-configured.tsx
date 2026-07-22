import { ToastAction } from "@/components/ui/toast";

export const PROVIDER_NOT_CONFIGURED = "PROVIDER_NOT_CONFIGURED";

type ApiErrorBody = {
  error?: { message?: string; code?: string } | string;
  message?: string;
};

export type ApiErrorLike = Error & { code?: string; status?: number };

function getApiErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const err = (body as ApiErrorBody).error;
  if (typeof err === "object" && err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

function getApiErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const b = body as ApiErrorBody;
  if (typeof b.error === "object" && b.error?.message) return b.error.message;
  if (typeof b.error === "string") return b.error;
  if (b.message) return b.message;
  return fallback;
}

export function makeApiError(
  body: unknown,
  status: number,
  fallbackMessage: string,
): ApiErrorLike {
  const message = getApiErrorMessage(body, fallbackMessage);
  const code = getApiErrorCode(body);
  const err = new Error(message) as ApiErrorLike;
  err.status = status;
  if (code) err.code = code;
  return err;
}

export function isProviderNotConfiguredError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string };
  if (e.code === PROVIDER_NOT_CONFIGURED) return true;
  // Some legacy paths (see client/src/lib/square.ts) wrap the
  // server payload as a JSON-encoded message. Detect that too so the
  // not-configured signal still surfaces through one extra layer.
  if (typeof e.message === "string" && e.message.includes(PROVIDER_NOT_CONFIGURED)) {
    return true;
  }
  return false;
}

export interface ProviderNotConfiguredToastOptions {
  /**
   * `wouter` navigate function; used by the "Open Settings" action.
   * When omitted, no action button is rendered.
   */
  navigate?: (path: string) => void;
  /**
   * Optional location id; reserved for future deep-anchoring on the
   * integrations page. Currently included as a query param only.
   */
  locationId?: number | null;
  /**
   * Optional override for the description. Useful on bowler-facing
   * pages where the visitor can't fix the misconfiguration.
   */
  description?: string;
}

export function providerNotConfiguredToast(
  options: ProviderNotConfiguredToastOptions,
): {
  title: string;
  description: string;
  variant: "destructive";
  action?: React.ReactElement;
} {
  const { navigate, locationId, description } = options;
  const settingsPath = locationId
    ? `/integrations?location=${locationId}`
    : "/integrations";
  const finalDescription =
    description ??
    (navigate
      ? "Connect this location's Square account from Settings, then try again."
      : "Please ask your league admin to connect Square in Settings, then try again.");

  return {
    title: "Square isn't connected for this location",
    description: finalDescription,
    variant: "destructive" as const,
    action: navigate
      ? (
        <ToastAction
          altText="Open payment provider settings"
          onClick={() => navigate(settingsPath)}
        >
          Open Settings
        </ToastAction>
      )
      : undefined,
  };
}
