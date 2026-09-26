import { FC, useState } from "react";
import { Link, useSearch } from "wouter";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Loader2, Mail, XCircle } from "lucide-react";
import { ErrorBoundary } from "@/components/error-boundary";
import { redirectToLoginForExpiredSession } from "@/lib/queryClient";
import { PublicPageLayout } from "@/components/public-page-layout";

// Single source of truth for the payment-sync union lives in
// shared/schema/bowlers.ts (task #374). Importing the type and the
// parser from there means a future fifth state only has to be added in
// one place.
import { parsePaymentSyncStatus, type PaymentSyncStatus } from "@shared/schema";

type Status =
  | { kind: "pending" }
  | { kind: "ready"; oldAddress: boolean }
  | { kind: "proof_pending"; message: string }
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
  PENDING_OLD_EMAIL: "The current email address must approve this change before it can complete.",
};

const ConfirmEmailChangePage: FC = () => {
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") ?? "";
  const oldAddress = new URLSearchParams(search).get("kind") === "old";
  const [status, setStatus] = useState<Status>(token
    ? { kind: "ready", oldAddress }
    : { kind: "error", code: "INVALID_TOKEN", message: ERROR_COPY.INVALID_TOKEN });

  const submit = async () => {
    if (!token || status.kind !== "ready") return;
    setStatus({ kind: "pending" });
    try {
      const res = await fetch(oldAddress ? "/api/account/approve-email-change" : "/api/account/confirm-email-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.success) {
        if (res.status === 202 || body?.data?.pending) {
          setStatus({ kind: "proof_pending", message: body?.data?.message ?? "The other email address must confirm before the change can complete." });
          return;
        }
        const requiresLogin = body?.data?.requiresLogin === true;
        setStatus({ kind: "success", email: body?.data?.email ?? "your new address", paymentSyncStatus: parsePaymentSyncStatus(body?.data?.paymentSyncStatus), requiresLogin });
        if (requiresLogin) redirectToLoginForExpiredSession({ cachedAuthenticated: true, force: true, reason: "credential-changed" });
        return;
      }
      const code: string = body?.error?.code ?? "INVALID_TOKEN";
      setStatus({ kind: "error", code, message: ERROR_COPY[code] ?? body?.error?.message ?? "We couldn't confirm this email change." });
    } catch {
      setStatus({ kind: "error", code: "NETWORK", message: "We couldn't reach the server. Please try again in a moment." });
    }
  };

  const isSuccess = status.kind === "success";
  const isError = status.kind === "error";

  return (
    <ErrorBoundary level="section">
      <PublicPageLayout>
        <article className="public-flow-card">
          <div className={`public-flow-icon ${isSuccess ? "public-flow-icon-success" : isError ? "public-flow-icon-danger" : ""}`}>
            {status.kind === "pending" ? (
              <Loader2 className="size-6 animate-spin" />
            ) : isSuccess ? (
              <CheckCircle2 className="size-6" />
            ) : isError ? (
              <XCircle className="size-6" />
            ) : (
              <Mail className="size-6" />
            )}
          </div>

          <p className="public-flow-eyebrow">Email change</p>
          <h1 className="public-flow-title">
            {status.kind === "pending"
              ? "Confirm this email change."
              : status.kind === "ready"
              ? "Confirm this email change."
              : status.kind === "proof_pending"
              ? "Approval recorded"
              : status.kind === "success"
              ? "Email updated"
              : "Couldn't confirm"}
          </h1>
          <p className="public-flow-description">
            {status.kind === "ready" && (status.oldAddress ? "Approve the requested change from this current mailbox." : "Confirm that you own the new mailbox.")}
            {status.kind === "pending" && "Hold tight while we finish the change."}
            {status.kind === "proof_pending" && status.message}
            {status.kind === "success" && (
              <>
                Your sign-in email is now <strong>{status.email}</strong>.
                Please log in again to continue.
              </>
            )}
            {status.kind === "error" && status.message}
          </p>

          {status.kind === "ready" && (
            <>
              <div className="public-flow-inset mb-5">
                <strong>Before you continue</strong>
                {status.oldAddress
                  ? "The current email address must approve this change before it can complete."
                  : "The current email address may also need to approve before the change is complete."}
              </div>
              <button type="button" onClick={() => void submit()} className="public-flow-primary">
                {status.oldAddress ? "Approve email change" : "Confirm new email"}
                <ArrowRight className="size-4" />
              </button>
            </>
          )}

          {status.kind === "success" && (
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-navigation-600">
                If you didn't request this change, please contact support immediately.
              </p>
              {status.paymentSyncStatus === "pending_retry" && (
                <div className="public-flow-inset">
                  <strong className="flex items-center gap-2"><AlertTriangle className="size-4" />Payment record will be retried</strong>
                  Your payment profile is temporarily out of date and will be retried automatically. Charges or saved cards may behave oddly for the next few minutes.
                </div>
              )}
            </div>
          )}

          {status.kind === "proof_pending" && (
            <div className="public-flow-inset">{status.message}</div>
          )}

          {status.kind === "error" && (
            <div className="public-flow-inset public-flow-inset-danger">{status.message}</div>
          )}

          <Link href="/login" className="public-flow-link mt-7">
            <ArrowLeft className="size-3.5" />
            Back to sign in
          </Link>
        </article>
      </PublicPageLayout>
    </ErrorBoundary>
  );
};

export default ConfirmEmailChangePage;
