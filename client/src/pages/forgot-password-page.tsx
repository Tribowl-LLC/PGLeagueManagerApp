import { FC, useState } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { parseRetryAfterSeconds } from "@/lib/queryClient";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import { useBusinessContext } from "@/hooks/use-business-context";
import {
  DEFAULT_THROTTLE_FALLBACK_SECONDS,
  formatCountdown,
  useThrottleCountdown,
} from "@/hooks/use-throttle-countdown";
import { AlertCircle, AlertTriangle, ArrowLeft, Loader2, Mail } from "lucide-react";

const ForgotPasswordPage: FC = () => {
  const { business } = useBusinessContext();
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
        <div className="min-h-screen bg-background flex items-start sm:items-center justify-center p-4 pt-6 sm:pt-4">
          <Card className="w-full max-w-md mt-4 sm:mt-0">
            <CardHeader spacing="tight" padding="comfortable" className="text-center">
              <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
                <Mail className="size-6 text-primary" />
              </div>
              <CardTitle size="2xl" weight="bold">Check your email</CardTitle>
              <CardDescription>
                We've sent an email with next steps for <strong>{email}</strong>, when this address can be used with LeagueVault. Please check your inbox and spam folder.
              </CardDescription>
            </CardHeader>
            <CardFooter spacing="tight" className="flex flex-col items-center">
              <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                <ArrowLeft className="size-3.5" />
                Back to login
              </Link>
            </CardFooter>
          </Card>
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary level="section">
      <div className="min-h-screen bg-background flex items-start sm:items-center justify-center p-4 pt-6 sm:pt-4">
        <Card className="w-full max-w-md mt-4 sm:mt-0">
          <CardHeader spacing="tight" padding="comfortable">
            {business?.logo && (
              <div className="flex justify-center mb-4">
                <img
                src={business.logo}
                alt={business.name}
                  className="h-14 w-auto max-w-50 object-contain"
                />
              </div>
            )}
            <CardTitle size="2xl" weight="bold" className="text-center">
              Reset your password
            </CardTitle>
            <CardDescription className="text-center">
              Enter your email address and we'll send you a link to reset your password.
            </CardDescription>
          </CardHeader>
          <CardContent padding="responsive">
            <form onSubmit={handleSubmit} className="space-y-3 sm:space-y-4">
              <div className="space-y-1 sm:space-y-2">
                <Label htmlFor="email">Email Address</Label>
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
              <Button
                type="submit"
                className="w-full mt-2"
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
              </Button>
            </form>
          </CardContent>
          <CardFooter spacing="tight" className="flex flex-col items-center">
            <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              <ArrowLeft className="size-3.5" />
              Back to login
            </Link>
          </CardFooter>
        </Card>
      </div>
    </ErrorBoundary>
  );
};

export default ForgotPasswordPage;
