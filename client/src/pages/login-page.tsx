import { FC, useState } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { parseRetryAfterSeconds, queryClient, resetSessionExpiryRedirect } from "@/lib/queryClient";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Link, useLocation, useSearch } from "wouter";
import {
  DEFAULT_THROTTLE_FALLBACK_SECONDS,
  formatCountdown,
  useThrottleCountdown,
} from "@/hooks/use-throttle-countdown";
import { AlertCircle, AlertTriangle, ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { PublicPageLayout } from "@/components/public-page-layout";

const loginSchema = z.object({
  email: z
    .string()
    .email("Please enter a valid email address"),
  password: z
    .string()
    .min(1, "Password is required"),
});

type LoginFormData = z.infer<typeof loginSchema>;

const LoginPage: FC = () => {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const loginReason = new URLSearchParams(search).get("reason");
  const sessionExpired = loginReason === "session-expired";
  const credentialChanged = loginReason === "credential-changed";
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { isThrottled, remainingSeconds, throttle, clear: clearThrottle } =
    useThrottleCountdown();

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const onSubmit = async (data: LoginFormData) => {
    setLoginError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
        credentials: "include",
      });

      if (response.status === 429) {
        // Surface limiter throttling as a dedicated banner + disabled submit
        // instead of the generic error pipeline; nudges the user to recovery.
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
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || "Invalid email or password");
      }

      const userData = await response.json();

      queryClient.setQueryData(['/api/user'], userData);
      resetSessionExpiryRedirect();
      clearThrottle();

      setLocation("/");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to login. Please try again.";
      setLoginError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ErrorBoundary level="section">
    <PublicPageLayout>
      <section className="public-flow-card">
        <header className="public-flow-card-header">
          <h1 className="public-flow-title">
            Welcome back.
          </h1>
          <p className="public-flow-description">
            Sign in to see your league, payments, and next bowling night.
          </p>
        </header>
        <div className="public-flow-card-content">
          {sessionExpired && (
            <Alert className="mb-4" data-testid="alert-session-expired">
              <AlertTitle>Session expired</AlertTitle>
              <AlertDescription>Your session expired. Please sign in again.</AlertDescription>
            </Alert>
          )}
          {credentialChanged && (
            <Alert className="mb-4" data-testid="alert-credential-changed">
              <AlertTitle>Account security details updated</AlertTitle>
              <AlertDescription>
                Your password or email was updated. Please sign in again with your new credentials.
              </AlertDescription>
            </Alert>
          )}
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3 sm:space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem spacing="responsive">
                    <FormLabel>Email address</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        autoComplete="email"
                        placeholder="john@example.com"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem spacing="responsive">
                    <FormLabel>Password</FormLabel>
                    <div className="public-flow-input-wrap">
                      <FormControl>
                        <Input
                          type={showPassword ? "text" : "password"}
                          autoComplete="current-password"
                          {...field}
                        />
                      </FormControl>
                      <button
                        type="button"
                        className="public-flow-password-toggle"
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        aria-pressed={showPassword}
                        onClick={() => setShowPassword((shown) => !shown)}
                      >
                        {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                      </button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex justify-end">
                <Link href="/forgot-password" className="public-flow-link">Forgot your password?</Link>
              </div>
              {isThrottled && (
                <Alert variant="destructive" data-testid="alert-login-throttled">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>Too many sign-in attempts</AlertTitle>
                  <AlertDescription spacing="tight">
                    <p>
                      For your protection, we've paused sign-ins for this
                      account for about{" "}
                      <span data-testid="text-login-retry-in">
                        {formatCountdown(remainingSeconds)}
                      </span>
                      . Please try again then.
                    </p>
                    <p>
                      Forgot your password?{" "}
                      <Link
                        href="/forgot-password"
                        className="font-medium underline underline-offset-2"
                        data-testid="link-login-throttled-forgot"
                      >
                        Reset it instead
                      </Link>
                      .
                    </p>
                  </AlertDescription>
                </Alert>
              )}
              {loginError && !isThrottled && (
                <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 size-4 shrink-0" />
                  <span>{loginError}</span>
                </div>
              )}
              <button
                type="submit"
                className="public-flow-primary mt-2"
                disabled={isSubmitting || isThrottled}
                data-testid="button-login-submit"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 w-4 animate-spin" />
                    Signing in…
                  </>
                ) : isThrottled ? (
                  `Try again in ${formatCountdown(remainingSeconds)}`
                ) : (
                  <>Sign in <ArrowRight size={18} aria-hidden="true" /></>
                )}
              </button>
            </form>
          </Form>
        </div>
        <footer className="public-flow-card-footer">
          <p className="text-sm text-muted-foreground">
            New to LeagueVault?{" "}
            <Link href="/register" className="public-flow-link">
              Register
            </Link>
          </p>
          <div className="flex gap-3">
            <Link href="/privacy-policy" className="public-flow-link">
              Privacy Policy
            </Link>
            <span className="text-xs text-muted-foreground">·</span>
            <Link href="/delete-account" className="public-flow-link">
              Delete Account
            </Link>
          </div>
        </footer>
      </section>
    </PublicPageLayout>
    </ErrorBoundary>
  );
};

export default LoginPage;
