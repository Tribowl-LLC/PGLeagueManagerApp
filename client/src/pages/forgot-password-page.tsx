import { FC, useState } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { parseRetryAfterSeconds } from "@/lib/queryClient";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import {
  DEFAULT_THROTTLE_FALLBACK_SECONDS,
  formatCountdown,
  useThrottleCountdown,
} from "@/hooks/use-throttle-countdown";
import { AlertCircle, AlertTriangle, ArrowLeft, Loader2, Mail } from "lucide-react";
import { PublicPageLayout } from "@/components/public-page-layout";

const ForgotPasswordPage: FC = () => {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const { isThrottled, remainingSeconds, throttle } = useThrottleCountdown();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      if (response.status === 429) {
        // Forgot-password limiter is aggressive (anti-enumeration) — show a
        // dedicated throttle banner so users get a clear "try again later".
        const retryAfter = parseRetryAfterSeconds(
          response.headers.get('retry-after'),
          response.headers.get('ratelimit-reset'),
        );
        const waitSeconds =
          retryAfter != null && retryAfter > 0
            ? retryAfter
            : DEFAULT_THROTTLE_FALLBACK_SECONDS;
        throttle(waitSeconds);
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error?.message || "Something went wrong. Please try again.");
      }

      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (sent) {
    return (
      <ErrorBoundary level="section">
        <PublicPageLayout>
          <section className="public-flow-card">
            <header className="public-flow-card-header">
              <div className="public-flow-icon">
                <Mail className="size-6" aria-hidden="true" />
              </div>
              <h1 className="public-flow-title">Check your email.</h1>
              <p className="public-flow-description">
                If an account matches <strong>{email}</strong>, a reset link will arrive there. Check your inbox and spam folder.
              </p>
            </header>
            <footer className="public-flow-card-footer">
              <Link href="/login" className="public-flow-link">
                <ArrowLeft className="size-3.5" />
                Back to sign in
              </Link>
            </footer>
          </section>
        </PublicPageLayout>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary level="section">
      <PublicPageLayout>
        <section className="public-flow-card">
          <header className="public-flow-card-header">
            <h1 className="public-flow-title">
              Reset your password.
            </h1>
            <p className="public-flow-description">
              Enter your email and we’ll help you get back in.
            </p>
          </header>
          <div className="public-flow-card-content">
            <form onSubmit={handleSubmit} className="space-y-3 sm:space-y-4">
              <div className="space-y-1 sm:space-y-2">
                <Label htmlFor="email">Email address</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="john@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              {isThrottled && (
                <Alert variant="destructive" data-testid="alert-forgot-throttled">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>Too many reset requests</AlertTitle>
                  <AlertDescription>
                    To protect your account, we've paused password reset
                    emails for about{" "}
                    <span data-testid="text-forgot-retry-in">
                      {formatCountdown(remainingSeconds)}
                    </span>
                    . Please try again then. (If you've already received a
                    reset email, it's still valid: check your inbox and
                    spam folder.)
                  </AlertDescription>
                </Alert>
              )}
              {error && !isThrottled && (
                <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <button
                type="submit"
                className="public-flow-primary mt-2"
                disabled={isSubmitting || isThrottled}
                data-testid="button-forgot-submit"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Sending…
                  </>
                ) : isThrottled ? (
                  `Try again in ${formatCountdown(remainingSeconds)}`
                ) : (
                  "Send reset link"
                )}
              </button>
            </form>
          </div>
          <footer className="public-flow-card-footer">
            <Link href="/login" className="public-flow-link">
              <ArrowLeft className="size-3.5" />
              Back to sign in
            </Link>
          </footer>
        </section>
      </PublicPageLayout>
    </ErrorBoundary>
  );
};

export default ForgotPasswordPage;
