/**
 * Outcome for a bounded transactional-email attempt.
 *
 * `unknown` means the provider call did not settle before the caller's
 * deadline. The provider may still accept that request, so callers must not
 * claim that it was definitely rejected or immediately retry blindly.
 */
export type EmailDeliveryOutcome = "accepted" | "not_sent" | "unknown";

export const DEFAULT_EMAIL_DELIVERY_TIMEOUT_MS = 5_000;

/**
 * Keep post-commit routes responsive while preserving the distinction between
 * a provider rejection and an unresolved provider call. The sender promise is
 * always observed after a timeout so a late rejection cannot become an
 * unhandled rejection.
 */
export async function awaitEmailDelivery(
  send: () => Promise<boolean>,
  timeoutMs = DEFAULT_EMAIL_DELIVERY_TIMEOUT_MS,
): Promise<EmailDeliveryOutcome> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("Email delivery timeout must be positive");
  }

  const sendResult = Promise.resolve()
    .then(send)
    .then((accepted) => (accepted ? "accepted" as const : "not_sent" as const))
    .catch(() => "not_sent" as const);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<EmailDeliveryOutcome>((resolve) => {
    timer = setTimeout(() => resolve("unknown"), timeoutMs);
    if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
  });

  try {
    return await Promise.race([sendResult, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
