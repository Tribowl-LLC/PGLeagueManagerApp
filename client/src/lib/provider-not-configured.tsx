import { ToastAction } from "@/components/ui/toast";
export { ApiError, makeApiError } from "@/lib/api-error";
export type { ApiErrorOptions } from "@/lib/api-error";

export const PROVIDER_NOT_CONFIGURED = "PROVIDER_NOT_CONFIGURED";

/** Legacy structural shape retained for provider call sites during migration. */
export type ApiErrorLike = Error & {
  code?: string;
  status?: number;
  retryAfterSeconds?: number | null;
};

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
