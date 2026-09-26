import { FC, ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { z } from "zod";
import { apiRequest, clearCsrfToken, parseRetryAfterSeconds, throwIfResNotOk } from "@/lib/queryClient";
import { classifyApiError, getApiErrorCode, getApiErrorStatus, getApiRetryDelay, shouldRetryApiQuery } from "@/lib/api-error";
import {
  DEFAULT_THROTTLE_FALLBACK_SECONDS,
  formatCountdown,
  useThrottleCountdown,
} from "@/hooks/use-throttle-countdown";
import { ErrorBoundary } from "@/components/error-boundary";
import { PublicPageLayout, PublicProgress } from "@/components/public-page-layout";
import { PageLoadingState } from "@/components/page-states";
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2, Mail, RefreshCw } from "lucide-react";

const registrationStatusSchema = z.object({
  status: z.enum(["pending", "consumed", "superseded", "revoked", "expired"]),
  email: z.string().nullable().optional(),
  actionStatus: z.enum(["pending", "consumed", "superseded", "revoked", "expired"]).nullable().optional(),
  deliveryStatus: z.enum([
    "not_attempted",
    "queued",
    "sending",
    "submitted",
    "sent",
    "processed",
    "failed",
    "delivered",
    "deferred",
    "bounce",
    "bounced",
    "dropped",
    "unknown",
  ]).nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  deliveryJobStatus: z.enum([
    "pending",
    "processing",
    "retry_scheduled",
    "succeeded",
    "failed",
    "suppressed",
  ]).nullable().optional(),
  deliveryAttemptCount: z.number().int().nonnegative().optional(),
  deliveryLastErrorCode: z.string().nullable().optional(),
  providerDeliveryEvent: z.string().nullable().optional(),
  providerDeliveryEventAt: z.string().nullable().optional(),
}).passthrough();

type RegistrationStatus = z.infer<typeof registrationStatusSchema>;

type RegistrationStatusResult =
  | { kind: 'status'; registration: RegistrationStatus }
  | { kind: 'missing' }
  | { kind: 'signed-in' };

async function loadRegistrationStatus(signal: AbortSignal): Promise<RegistrationStatusResult> {
  const response = await fetch('/api/auth/registration/status', { credentials: 'include', signal });
  if (response.status === 404 || response.status === 401) {
    const body = await response.clone().json().catch(() => null);
    const missing = (response.status === 404 && body?.error?.code === 'NOT_FOUND')
      || (response.status === 401 && body?.error?.code === 'AUTH_REQUIRED');
    if (missing) {
      // Completing the email link in another tab clears the anonymous signup
      // capability. Check the current session before offering signup again.
      const sessionResponse = await fetch('/api/user', { credentials: 'include', signal });
      if (sessionResponse.status === 401) {
        const sessionBody = await sessionResponse.clone().json().catch(() => null);
        if (sessionBody?.error?.code === 'AUTH_REQUIRED') return { kind: 'missing' };
      }
      await throwIfResNotOk(sessionResponse);
      z.object({
        success: z.literal(true), data: z.object({ id: z.number().int().positive() }),
      }).parse(await sessionResponse.json());
      return { kind: 'signed-in' };
    }
  }
  await throwIfResNotOk(response);
  const body = await response.json();
  if (!body.success) throw new Error('Unable to verify registration status.');
  return { kind: 'status', registration: registrationStatusSchema.parse(body.data) };
}

type DeliveryPresentation = {
  label: string;
  message: string;
  tone: "default" | "warning" | "destructive";
};

function deliveryPresentation(status: RegistrationStatus): DeliveryPresentation {
  const normalizedDeliveryStatus = status.deliveryStatus?.trim().toLowerCase();
  const knownConfigurationFailure = ["not_configured", "render_error"].includes(
    status.deliveryLastErrorCode?.trim().toLowerCase() ?? "",
  );

  // The API puts exact provider evidence and safe worker classifications into
  // deliveryStatus. Honor that coarse result before looking at job state:
  // an uncertain timeout must not be presented as a confirmed bad address,
  // and a terminal known-unsent configuration failure must not be hidden by
  // the queue's generic failed state.
  if (normalizedDeliveryStatus === "unknown") {
    return { label: "Status unknown", message: "Delivery status is unknown. Check your inbox and spam folder, then try again if needed.", tone: "warning" };
  }
  if (normalizedDeliveryStatus === "delivered") {
    return { label: "Delivered", message: "The email provider confirmed delivery.", tone: "default" };
  }
  if (["bounce", "bounced", "dropped", "failed"].includes(normalizedDeliveryStatus ?? "")) {
    return knownConfigurationFailure
      ? { label: "Delivery unavailable", message: "The setup email service is temporarily unavailable. Contact your league administrator for help.", tone: "destructive" }
      : { label: "Delivery failed", message: "We could not deliver the setup email. Check the address or use a different email.", tone: "destructive" };
  }
  if (normalizedDeliveryStatus === "deferred") {
    return { label: "Delivery deferred", message: "The email provider deferred delivery. The app will not resend automatically.", tone: "warning" };
  }
  if (["processed", "submitted", "sent"].includes(normalizedDeliveryStatus ?? "")) {
    return { label: "Submitted", message: "The setup email was submitted, but delivery has not been confirmed yet.", tone: "default" };
  }

  // Provider events are the authoritative signal when one is present. The
  // app's queue state is only used as a fallback while provider delivery is
  // still unknown.
  const providerEvent = status.providerDeliveryEvent?.trim().toLowerCase();
  if (providerEvent === "delivered") {
    return { label: "Delivered", message: "The email provider confirmed delivery.", tone: "default" };
  }
  if (["bounce", "bounced", "dropped"].includes(providerEvent ?? "")) {
    return { label: "Delivery failed", message: "The email provider could not deliver this message. Check the address or use a different email.", tone: "destructive" };
  }
  if (providerEvent === "deferred") {
    return { label: "Delivery deferred", message: "The email provider deferred delivery. The app will not resend automatically.", tone: "warning" };
  }
  if (["processed", "submitted", "sent"].includes(providerEvent ?? "")) {
    return { label: "Submitted", message: "The setup email was submitted, but delivery has not been confirmed yet.", tone: "default" };
  }
  if (providerEvent) {
    return { label: "Status unknown", message: "Delivery status is unknown. Check your inbox and spam folder, then try again if needed.", tone: "warning" };
  }

  if (status.deliveryJobStatus === "processing" || status.deliveryStatus === "sending") {
    return { label: "Sending", message: "Your setup email is being submitted to the email provider.", tone: "default" };
  }
  if (status.deliveryJobStatus === "pending" || status.deliveryJobStatus === "retry_scheduled"
    || status.deliveryStatus === "queued" || status.deliveryStatus === "not_attempted") {
    return { label: "Queued", message: "Your setup email is queued for delivery.", tone: "default" };
  }
  if (status.deliveryJobStatus === "suppressed" || status.deliveryStatus === "deferred") {
    return { label: "Delivery deferred", message: "Delivery was deferred. The app will not resend automatically.", tone: "warning" };
  }
  if (status.deliveryJobStatus === "failed" || ["failed", "bounce", "bounced", "dropped"].includes(status.deliveryStatus ?? "")) {
    return knownConfigurationFailure
      ? { label: "Delivery unavailable", message: "The setup email service is temporarily unavailable. Contact your league administrator for help.", tone: "destructive" }
      : { label: "Delivery failed", message: "We could not deliver the setup email. Check the address or use a different email.", tone: "destructive" };
  }
  if (status.deliveryJobStatus === "succeeded" || ["submitted", "sent"].includes(status.deliveryStatus ?? "")) {
    return { label: "Submitted", message: "The setup email was submitted, but delivery has not been confirmed yet.", tone: "default" };
  }
  if (status.deliveryStatus === "delivered") {
    return { label: "Delivered", message: "The email provider confirmed delivery.", tone: "default" };
  }
  return { label: "Status unknown", message: "Delivery status is unknown. Check your inbox and spam folder, then try again if needed.", tone: "warning" };
}

function isMissingRegistration(error: unknown): boolean {
  const status = getApiErrorStatus(error);
  return status === 401 || status === 404 || getApiErrorCode(error) === "NOT_FOUND";
}

function retryAfterFromError(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const retryAfterSeconds = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  if (typeof retryAfterSeconds !== "number" || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) {
    return null;
  }
  return parseRetryAfterSeconds(String(Math.floor(retryAfterSeconds)), null);
}

function expiryLabel(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime()) ? null : `Link valid until ${date.toLocaleString()}`;
}

const RegistrationEmailPage: FC = () => {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [isVisible, setIsVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [forcedMissing, setForcedMissing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  const { isThrottled, remainingSeconds, throttle, clear: clearThrottle } = useThrottleCountdown();

  const statusQuery = useQuery<RegistrationStatusResult>({
    queryKey: ["/api/auth/registration/status"],
    queryFn: ({ signal }) => loadRegistrationStatus(signal),
    retry: shouldRetryApiQuery,
    retryDelay: getApiRetryDelay,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => isVisible && !forcedMissing
      && query.state.data?.kind === 'status'
      && query.state.data.registration.status === 'pending' ? 30_000 : false,
  });
  const refetchStatus = statusQuery.refetch;

  useEffect(() => {
    if (statusQuery.data?.kind === 'signed-in' && !statusQuery.isFetching && !statusQuery.isError) {
      // The shared session may now belong to a different account. Let the
      // root auth boundary choose its destination from a fresh user read.
      queryClient.clear();
      clearCsrfToken();
      setLocation('/', { replace: true });
    }
  }, [queryClient, setLocation, statusQuery.data, statusQuery.isError, statusQuery.isFetching]);

  useEffect(() => {
    if (statusQuery.data) setForcedMissing(false);
  }, [statusQuery.data]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const visible = document.visibilityState !== "hidden";
      setIsVisible(visible);
      if (visible) void refetchStatus();
    };
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void refetchStatus();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [refetchStatus]);

  const resendMutation = useMutation({
    mutationFn: async () => apiRequest<unknown>("/api/auth/registration/resend", "POST", {}),
    onMutate: () => {
      setActionError(null);
      setResendNotice(null);
    },
    onSuccess: () => {
      clearThrottle();
      setResendNotice("Request submitted. Delivery has not been confirmed yet.");
      void refetchStatus();
    },
    onError: (error: unknown) => {
      if (isMissingRegistration(error)) {
        setForcedMissing(true);
        return;
      }
      if (getApiErrorStatus(error) === 429) {
        throttle(retryAfterFromError(error) || DEFAULT_THROTTLE_FALLBACK_SECONDS);
        return;
      }
      setActionError("We couldn't submit another email. Please try again.");
    },
  });

  const abandonMutation = useMutation({
    mutationFn: async () => apiRequest<unknown>("/api/auth/registration/abandon", "POST", {}),
    onMutate: () => setActionError(null),
    onSuccess: () => setLocation("/register"),
    onError: (error: unknown) => {
      if (isMissingRegistration(error)) {
        setLocation("/register");
        return;
      }
      setActionError("We couldn't discard this sign-up session. Please try again.");
    },
  });

  const missing = forcedMissing || statusQuery.data?.kind === 'missing';
  const status = statusQuery.data?.kind === 'status' ? statusQuery.data.registration : undefined;
  const expiry = expiryLabel(status?.expiresAt);

  const shell = (content: ReactNode, topAligned = false) => (
    <ErrorBoundary level="section">
      <PublicPageLayout topAligned={topAligned}>{content}</PublicPageLayout>
    </ErrorBoundary>
  );

  if ((statusQuery.isLoading && !status) || statusQuery.data?.kind === 'signed-in') {
    return shell(
      <section className="public-flow-card">
        <PageLoadingState message="Checking your registration…" fullPage={false} />
      </section>,
    );
  }

  if (missing) {
    return shell(
      <section className="public-flow-card">
        <h1 className="public-flow-title">Check your email</h1>
        <p className="public-flow-description">If you recently requested registration help, check your email for next steps. If you already have an account, sign in or reset your password. Otherwise, start registration again with the same email address.</p>
        <div className="grid gap-3">
          <Link href="/register" className="public-flow-primary" data-testid="link-registration-continue">Continue sign-up</Link>
          <Link href="/login" className="public-flow-secondary" data-testid="link-registration-sign-in">Sign in</Link>
          <Link href="/forgot-password" className="public-flow-link justify-center" data-testid="link-registration-forgot-password">Forgot password?</Link>
        </div>
      </section>,
    );
  }

  if ((statusQuery.isError && !status) || !status || status.status !== "pending") {
    return shell(
      <section className="public-flow-card">
        <h1 className="public-flow-title">Continue registration</h1>
        <p className="public-flow-description">{classifyApiError(statusQuery.error) === 'transport'
            ? "We couldn't connect to check your registration. Check your internet connection and try again."
            : "We couldn't verify this sign-up session right now. Try again, sign in, or reset your password. Otherwise, start registration again with the same email address."}</p>
        <div className="public-flow-inset public-flow-inset-danger mb-4" role="alert">
          <strong><AlertCircle className="mr-2 inline-block size-4 align-middle" />We couldn't verify your registration</strong>
          Please try again or start a new sign-up.
        </div>
        <button type="button" className="public-flow-primary disabled:cursor-not-allowed disabled:opacity-60" disabled={statusQuery.isFetching} onClick={() => void statusQuery.refetch()} data-testid="button-registration-status-retry">{statusQuery.isFetching ? 'Checking…' : 'Try again'}</button>
        <div className="mt-5 grid gap-3">
          <Link href="/login" className="public-flow-secondary" data-testid="link-registration-sign-in">Sign in</Link>
          <Link href="/forgot-password" className="public-flow-link justify-center" data-testid="link-registration-forgot-password">Forgot password?</Link>
          <Link href="/register" className="public-flow-link justify-center" data-testid="link-registration-continue">Continue sign-up</Link>
        </div>
      </section>,
    );
  }

  const delivery = deliveryPresentation(status);
  const setupDescription = delivery.label === "Queued"
    ? "Your setup email is queued for delivery to"
    : delivery.label === "Sending"
      ? "Your setup email is being submitted for delivery to"
      : delivery.label === "Delivery failed"
        ? "We couldn't deliver a setup email to"
        : "Your setup email is addressed to";
  const setupGuidance = ["Delivery failed", "Delivery deferred", "Status unknown"].includes(delivery.label)
    ? "Check your inbox and spam folder, or use a different email to try again."
    : "Use the link in that email to set your password and finish creating your account.";
  return shell(
    <section className="public-flow-card">
      <PublicProgress step={2} />
      <div className="public-flow-icon"><Mail size={23} strokeWidth={1.8} /></div>
      <h1 className="public-flow-title">Check your email.</h1>
      <p className="public-flow-description">
        {setupDescription} <strong>{status.email || "your email address"}</strong>. {setupGuidance}
      </p>
      <div className={`public-flow-inset${delivery.tone === "destructive" ? " public-flow-inset-danger" : ""}`} data-testid="registration-delivery-status" aria-live="polite">
        <strong>{delivery.tone === "destructive" ? <AlertCircle className="mr-2 inline-block size-4 align-middle" /> : <CheckCircle2 className="mr-2 inline-block size-4 align-middle" />}{delivery.label}</strong>
        {delivery.message}
      </div>
      {expiry && <p className="public-flow-date mt-3 text-center">{expiry}</p>}
      {statusQuery.isError && <p className="mt-3 text-sm text-attention-800" role="alert">We couldn't refresh delivery status. The last known status is still shown.</p>}
      {resendNotice && <p className="mt-3 text-sm text-navigation-600" role="status">{resendNotice}</p>}
      {actionError && <p className="mt-3 text-sm text-attention-800" role="alert">{actionError}</p>}
      {isThrottled && (
        <p className="mt-3 text-sm text-navigation-600" data-testid="text-registration-retry-in">
          You can request another email in {formatCountdown(remainingSeconds)}.
        </p>
      )}
      <button type="button" className="public-flow-primary mt-5 disabled:cursor-not-allowed disabled:opacity-60" onClick={() => resendMutation.mutate()} disabled={resendMutation.isPending || isThrottled} data-testid="button-registration-resend">
        {resendMutation.isPending ? <><Loader2 className="size-4 animate-spin" />Requesting…</> : <><RefreshCw className="size-4" />Resend setup email</>}
      </button>
      <div className="mt-4 grid gap-2 text-center">
        <button type="button" className="public-flow-link justify-center" onClick={() => abandonMutation.mutate()} disabled={abandonMutation.isPending} data-testid="button-registration-correct-email">
          {abandonMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
          Use a different email
        </button>
        <Link href="/login" className="public-flow-link justify-center" data-testid="link-registration-sign-in">
          <ArrowLeft className="size-3.5" />
          Already have an account? Sign in
        </Link>
      </div>
    </section>,
  );
};

export default RegistrationEmailPage;
