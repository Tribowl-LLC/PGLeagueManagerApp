import { FC, useState } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { parseRetryAfterSeconds, queryClient, resetSessionExpiryRedirect } from "@/lib/queryClient";
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
import { useSubdomainOrg } from "@/hooks/use-subdomain-org";
import {
  DEFAULT_THROTTLE_FALLBACK_SECONDS,
  formatCountdown,
  useThrottleCountdown,
} from "@/hooks/use-throttle-countdown";
import { AlertCircle, AlertTriangle, Loader2 } from "lucide-react";

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
  const { org: subdomainOrg } = useSubdomainOrg();
  const loginReason = new URLSearchParams(search).get("reason");
  const sessionExpired = loginReason === "session-expired";
  const credentialChanged = loginReason === "credential-changed";
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
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
    <div className="min-h-screen bg-background flex items-start sm:items-center justify-center p-4 pt-6 sm:pt-4">
      <Card className="w-full max-w-md mt-4 sm:mt-0">
        <CardHeader className="space-y-1 pb-4 sm:pb-6">
          {subdomainOrg?.logo && (
            <div className="flex justify-center mb-4">
              <img
                src={subdomainOrg.logo}
                alt={subdomainOrg.name}
                className="h-14 w-auto max-w-[200px] object-contain"
              />
            </div>
          )}
          <CardTitle className="text-2xl font-bold text-center">
            Welcome Back
          </CardTitle>
          <CardDescription className="text-center">
            {subdomainOrg
              ? `Sign in to ${subdomainOrg.name}`
              : "Sign in to your bowling league account"}
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4 sm:pb-6">
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
                  <FormItem className="space-y-1 sm:space-y-2">
                    <FormLabel>Email Address</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
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
                  <FormItem className="space-y-1 sm:space-y-2">
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder="••••••••"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {isThrottled && (
                <Alert variant="destructive" data-testid="alert-login-throttled">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>Too many sign-in attempts</AlertTitle>
                  <AlertDescription className="space-y-2">
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
              <Button
                type="submit"
                className="w-full mt-2"
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
                  "Sign In"
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
        <CardFooter className="flex flex-col items-center gap-2 pt-0">
          <Link href="/forgot-password" className="text-sm text-primary hover:underline">
            Forgot your password?
          </Link>
          <p className="text-sm text-muted-foreground">
            Don't have an account?{" "}
            <Link href="/sign-up" className="text-primary hover:underline">
              Sign up
            </Link>
          </p>
          <div className="flex gap-3">
            <Link href="/privacy-policy" className="text-xs text-muted-foreground hover:underline">
              Privacy Policy
            </Link>
            <span className="text-xs text-muted-foreground">·</span>
            <Link href="/delete-account" className="text-xs text-muted-foreground hover:underline">
              Delete Account
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
    </ErrorBoundary>
  );
};

export default LoginPage;
