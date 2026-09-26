import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { PublicPageLayout } from "@/components/public-page-layout";

type State =
  | { kind: "loading" }
  | { kind: "ready"; profileName?: string; csrfToken: string }
  | { kind: "reported" }
  | { kind: "error"; message: string };

export default function ProfileClaimReportPage() {
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") ?? "";
  const [state, setState] = useState<State>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setState({ kind: "error", message: "This report link is invalid or expired." });
      return;
    }
    let cancelled = false;
    void fetch(`/api/profile-claims/report?token=${encodeURIComponent(token)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (cancelled) return;
      if (!response.ok || body?.success !== true || typeof body?.data?.csrfToken !== "string") {
        setState({ kind: "error", message: body?.error?.message || "This report link is invalid or expired." });
        return;
      }
      setState({ kind: "ready", profileName: body.data.profileName, csrfToken: body.data.csrfToken });
    }).catch(() => {
      if (!cancelled) setState({ kind: "error", message: "We could not load this report link. Please try again." });
    });
    return () => { cancelled = true; };
  }, [token]);

  const report = async () => {
    if (state.kind !== "ready" || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/profile-claims/report", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-claim-report-csrf": state.csrfToken,
        },
        body: JSON.stringify({ token, confirm: true }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.success !== true) {
        setState({ kind: "error", message: body?.error?.message || "We could not record the report." });
        return;
      }
      setState({ kind: "reported" });
    } catch {
      setState({ kind: "error", message: "We could not record the report. Please try again." });
    } finally {
      setSubmitting(false);
    }
  };

  const isReported = state.kind === "reported";
  const isError = state.kind === "error";

  return (
    <PublicPageLayout>
      <article className="public-flow-card">
        <div className={`public-flow-icon ${isReported ? "public-flow-icon-success" : isError || state.kind === "ready" ? "public-flow-icon-danger" : ""}`}>
          {state.kind === "loading" ? (
            <Loader2 className="size-6 animate-spin" />
          ) : isReported ? (
            <CheckCircle2 className="size-6" />
          ) : isError ? (
            <XCircle className="size-6" />
          ) : (
            <ShieldAlert className="size-6" />
          )}
        </div>

        <p className="public-flow-eyebrow">Profile security</p>
        <h1 className="public-flow-title">Profile assignment report.</h1>
        <p className="public-flow-description">
          {state.kind === "ready" && state.profileName
            ? `An account was connected to ${state.profileName}.`
            : "Review this profile assignment before reporting it."}
        </p>

        {state.kind === "loading" && (
          <div className="flex justify-center py-4" role="status" aria-label="Loading report">
            <Loader2 className="size-5 animate-spin text-navigation-700" />
          </div>
        )}

        {state.kind === "error" && (
          <div className="public-flow-inset public-flow-inset-danger" role="alert">
            <strong>Unable to continue</strong>
            {state.message}
          </div>
        )}

        {state.kind === "ready" && (
          <>
            <div className="public-flow-inset mb-5">
              <strong>Only report this if unexpected</strong>
              Reporting places the linked account on a security hold for administrator review. It does not transfer profile ownership.
            </div>
            <button
              type="button"
              className="public-flow-primary public-flow-primary-danger"
              disabled={submitting}
              aria-busy={submitting}
              onClick={() => void report()}
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  <span>Reporting…</span>
                </>
              ) : (
                <>
                  <span>This wasn’t me</span>
                  <ArrowRight className="size-4" aria-hidden="true" />
                </>
              )}
            </button>
          </>
        )}

        {state.kind === "reported" && (
          <div className="public-flow-inset public-flow-inset-danger" role="status">
            <strong>Report received</strong>
            The account has been placed on a security hold. An administrator will review the assignment.
          </div>
        )}

        <Link href="/login" className="public-flow-link mt-7">
          <ArrowLeft className="size-3.5" />
          Back to sign in
        </Link>
      </article>
    </PublicPageLayout>
  );
}
