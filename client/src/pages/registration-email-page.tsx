import { FC, ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { z } from "zod";
import { apiRequest, parseRetryAfterSeconds } from "@/lib/queryClient";
import { getApiErrorCode, getApiErrorStatus } from "@/lib/api-error";
import {
  DEFAULT_THROTTLE_FALLBACK_SECONDS,
  formatCountdown,
  useThrottleCountdown,
} from "@/hooks/use-throttle-countdown";
import { ErrorBoundary } from "@/components/error-boundary";
import { PageLoadingState } from "@/components/page-states";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  const [isVisible, setIsVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [forcedMissing, setForcedMissing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  const { isThrottled, remainingSeconds, throttle, clear: clearThrottle } = useThrottleCountdown();

  const statusQuery = useQuery<RegistrationStatus>({
    queryKey: ["/api/auth/registration/status"],
    queryFn: async () => {
      const response = await apiRequest<unknown>("/api/auth/registration/status", "GET");
      if (!response.success) throw new Error(response.error?.message || "Unable to verify registration status.");
      const parsed = registrationStatusSchema.safeParse(response.data);
      if (!parsed.success) throw new Error("Unable to verify registration status.");
      return parsed.data;
    },
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: isVisible ? 30_000 : false,
  });
  const refetchStatus = statusQuery.refetch;

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
    onSuccess: () => setLocation("/sign-up"),
    onError: (error: unknown) => {
      if (isMissingRegistration(error)) {
        setLocation("/sign-up");
        return;
      }
      setActionError("We couldn't discard this sign-up session. Please try again.");
    },
  });

  const statusErrorIsMissing = statusQuery.isError && isMissingRegistration(statusQuery.error);
  const missing = forcedMissing || statusErrorIsMissing;
  const status = statusQuery.data;
  const expiry = expiryLabel(status?.expiresAt);

  const shell = (content: ReactNode) => (
    <ErrorBoundary level="section">
      <div className="min-h-screen bg-background flex items-start sm:items-center justify-center p-4 pt-6 sm:pt-4">
        <Card className="w-full max-w-md mt-4 sm:mt-0">
          {content}
        </Card>
      </div>
    </ErrorBoundary>
  );

  if (statusQuery.isLoading && !status) {
    return shell(<CardContent><PageLoadingState message="Checking your registration…" fullPage={false} /></CardContent>);
  }

  if (missing) {
    return shell(
      <>
        <CardHeader className="space-y-2 text-center">
          <CardTitle>Registration link unavailable</CardTitle>
          <CardDescription>This sign-up session is no longer available. Sign in if you already have an account, or start again with a different email.</CardDescription>
        </CardHeader>
        <CardFooter className="flex flex-col gap-3">
          <Button asChild className="w-full" data-testid="link-registration-sign-in"><Link href="/login">Sign in</Link></Button>
          <Button variant="outline" className="w-full" data-testid="button-registration-correct-email" onClick={() => abandonMutation.mutate()} disabled={abandonMutation.isPending}>
            {abandonMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Use a different email
          </Button>
        </CardFooter>
      </>,
    );
  }

  if ((statusQuery.isError && !status) || !status || status.status !== "pending") {
    return shell(
      <>
        <CardHeader className="space-y-2 text-center">
          <CardTitle>Registration status unavailable</CardTitle>
          <CardDescription>We couldn't verify this sign-up session. You can retry, sign in, or start again with a different email.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert variant="destructive"><AlertCircle className="size-4" /><AlertTitle>We couldn't verify your registration</AlertTitle><AlertDescription>Please try again or start a new sign-up.</AlertDescription></Alert>
          <Button className="w-full" onClick={() => void statusQuery.refetch()} data-testid="button-registration-status-retry">Try again</Button>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button asChild variant="outline" className="w-full" data-testid="link-registration-sign-in"><Link href="/login">Sign in</Link></Button>
          <Button variant="ghost" className="w-full" onClick={() => abandonMutation.mutate()} disabled={abandonMutation.isPending} data-testid="button-registration-correct-email">Use a different email</Button>
        </CardFooter>
      </>,
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
    <>
      <CardHeader className="space-y-2 text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
          <Mail className="size-6 text-primary" />
        </div>
        <CardTitle className="text-2xl font-bold">Check your email</CardTitle>
        <CardDescription>
          {setupDescription} <strong>{status.email || "your email address"}</strong>. {setupGuidance}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant={delivery.tone === "destructive" ? "destructive" : "default"} data-testid="registration-delivery-status" aria-live="polite">
          {delivery.tone === "destructive" ? <AlertCircle className="size-4" /> : <CheckCircle2 className="size-4" />}
          <AlertTitle>{delivery.label}</AlertTitle>
          <AlertDescription>{delivery.message}</AlertDescription>
        </Alert>
        {expiry && <p className="text-center text-xs text-muted-foreground">{expiry}</p>}
        {statusQuery.isError && <p className="text-sm text-destructive" role="alert">We couldn't refresh delivery status. The last known status is still shown.</p>}
        {resendNotice && <p className="text-sm text-muted-foreground" role="status">{resendNotice}</p>}
        {actionError && <p className="text-sm text-destructive" role="alert">{actionError}</p>}
        {isThrottled && (
          <p className="text-sm text-muted-foreground" data-testid="text-registration-retry-in">
            You can request another email in {formatCountdown(remainingSeconds)}.
          </p>
        )}
        <Button className="w-full" onClick={() => resendMutation.mutate()} disabled={resendMutation.isPending || isThrottled} data-testid="button-registration-resend">
          {resendMutation.isPending ? <><Loader2 className="mr-2 size-4 animate-spin" />Requesting…</> : <><RefreshCw className="mr-2 size-4" />Resend setup email</>}
        </Button>
      </CardContent>
      <CardFooter className="flex flex-col gap-3 pt-0">
        <Button variant="ghost" className="w-full" onClick={() => abandonMutation.mutate()} disabled={abandonMutation.isPending} data-testid="button-registration-correct-email">
          {abandonMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
          Use a different email
        </Button>
        <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline" data-testid="link-registration-sign-in">
          <ArrowLeft className="size-3.5" />
          Already have an account? Sign in
        </Link>
      </CardFooter>
    </>,
  );
};

export default RegistrationEmailPage;
