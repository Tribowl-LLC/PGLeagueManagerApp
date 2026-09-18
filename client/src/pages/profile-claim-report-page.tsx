import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, ShieldAlert } from "lucide-react";

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

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <ShieldAlert className="mx-auto size-8 text-destructive" />
          <CardTitle size="2xl">Profile assignment report</CardTitle>
          <CardDescription>
            {state.kind === "ready" && state.profileName
              ? `An account was connected to ${state.profileName}.`
              : "Review this profile assignment before reporting it."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
          {state.kind === "loading" && <div className="flex justify-center"><Loader2 className="animate-spin" /></div>}
          {state.kind === "error" && <Alert variant="destructive"><AlertTitle>Unable to continue</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert>}
          {state.kind === "ready" && (
            <>
              <Alert><AlertTitle>Only report this if unexpected</AlertTitle><AlertDescription>Reporting places the linked account on a security hold for administrator review. It does not transfer profile ownership.</AlertDescription></Alert>
              <Button className="w-full" variant="destructive" disabled={submitting} onClick={() => void report()}>
                {submitting ? <><Loader2 className="mr-2 size-4 animate-spin" />Submitting…</> : "This wasn’t me"}
              </Button>
            </>
          )}
          {state.kind === "reported" && <Alert><AlertTitle>Report received</AlertTitle><AlertDescription>The account has been placed on a security hold. An administrator will review the assignment.</AlertDescription></Alert>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
