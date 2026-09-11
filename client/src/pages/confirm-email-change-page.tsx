import { FC, useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { redirectToLoginForExpiredSession } from "@/lib/queryClient";

// Single source of truth for the payment-sync union lives in
// shared/schema/bowlers.ts (task #374). Importing the type and the
// parser from there means a future fifth state only has to be added in
// one place.
import { parsePaymentSyncStatus, type PaymentSyncStatus } from "@shared/schema";

type Status =
  | { kind: "pending" }
  | {
      kind: "success";
      email: string;
      paymentSyncStatus: PaymentSyncStatus;
      requiresLogin: boolean;
    }
  | { kind: "error"; code: string; message: string };

const ERROR_COPY: Record<string, string> = {
  INVALID_TOKEN:
    "This confirmation link isn't valid. It may have already been replaced by a newer request.",
  TOKEN_CONSUMED: "This confirmation link has already been used.",
  TOKEN_EXPIRED:
    "This confirmation link has expired. Please request another email change from your profile.",
  EMAIL_IN_USE:
    "That email address is already in use by another account. Please request another change with a different address.",
  USER_NOT_FOUND: "This account no longer exists.",
};

const ConfirmEmailChangePage: FC = () => {
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") ?? "";
  const [status, setStatus] = useState<Status>({ kind: "pending" });

  useEffect(() => {
    if (!token) {
      setStatus({
        kind: "error",
        code: "INVALID_TOKEN",
        message: ERROR_COPY.INVALID_TOKEN,
      });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/account/confirm-email-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && body?.success) {
          const requiresLogin = body?.data?.requiresLogin === true;
          setStatus({
            kind: "success",
            email: body?.data?.email ?? "your new address",
            // Server defaults to "not_applicable" when there's no linked
            // bowler. The shared parser (task #374) collapses any
            // unrecognized value to "not_applicable" too so a future
            // server-side addition never trips a notice an old client
            // doesn't know how to interpret.
            paymentSyncStatus: parsePaymentSyncStatus(
              body?.data?.paymentSyncStatus,
            ),
            requiresLogin,
          });
          if (requiresLogin) {
            // The email transaction committed, but Passport could not save
            // the refreshed session. Clear cached auth state and require a
            // normal login rather than leaving the stale session visible.
            redirectToLoginForExpiredSession({
              cachedAuthenticated: true,
              force: true,
              reason: "credential-changed",
            });
          }
        } else {
          const code: string = body?.error?.code ?? "INVALID_TOKEN";
          const message =
            ERROR_COPY[code] ??
            body?.error?.message ??
            "We couldn't confirm this email change.";
          setStatus({ kind: "error", code, message });
        }
      } catch {
        if (cancelled) return;
        setStatus({
          kind: "error",
          code: "NETWORK",
          message: "We couldn't reach the server. Please try again in a moment.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <ErrorBoundary level="section">
      <div className="min-h-screen bg-background flex items-start sm:items-center justify-center p-4 pt-6 sm:pt-4">
        <Card className="w-full max-w-md mt-4 sm:mt-0">
          <CardHeader className="space-y-1 pb-4 sm:pb-6 text-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
              {status.kind === "pending" ? (
                <Loader2 className="size-6 text-primary animate-spin" />
              ) : status.kind === "success" ? (
                <CheckCircle2 className="size-6 text-primary" />
              ) : (
                <XCircle className="size-6 text-destructive" />
              )}
            </div>
            <CardTitle className="text-2xl font-bold">
              {status.kind === "pending"
                ? "Confirming your new email…"
                : status.kind === "success"
                ? "Email updated"
                : "Couldn't confirm"}
            </CardTitle>
            <CardDescription>
              {status.kind === "pending" &&
                "Hold tight while we finish the change."}
              {status.kind === "success" && (
                <>
                  Your sign-in email is now <strong>{status.email}</strong>.
                  Please log in again to continue.
                </>
              )}
              {status.kind === "error" && status.message}
            </CardDescription>
          </CardHeader>
          {status.kind !== "pending" && (
            <CardContent className="pb-2 space-y-3 text-center text-sm text-muted-foreground">
              {status.kind === "success" && (
                <>
                  <p>
                    If you didn't request this change, please contact support
                    immediately.
                  </p>
                  {status.paymentSyncStatus === "pending_retry" && (
                    // Wording mirrors the toast in
                    // client/src/components/profile-info-card.tsx so a
                    // user who edits their profile and a user who
                    // confirms an email change see the same explanation.
                    <Alert
                      variant="default"
                      className="text-left"
                      data-testid="alert-payment-sync-pending-retry"
                    >
                      <AlertTriangle className="size-4" />
                      <AlertTitle>Payment record will be retried</AlertTitle>
                      <AlertDescription>
                        Your payment profile is temporarily out of date and
                        will be retried automatically. Charges or saved cards
                        may behave oddly for the next few minutes.
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}
            </CardContent>
          )}
          <CardFooter className="flex flex-col items-center gap-2 pt-0">
            <Link
              href="/login"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <ArrowLeft className="size-3.5" />
              Back to login
            </Link>
          </CardFooter>
        </Card>
      </div>
    </ErrorBoundary>
  );
};

export default ConfirmEmailChangePage;
