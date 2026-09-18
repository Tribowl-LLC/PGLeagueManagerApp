import { FC, useState } from "react";
import { csrfFetch, makeApiError, parseRetryAfterSeconds } from "@/lib/queryClient";
import { isExpectedApiError, isAbortError } from "@/lib/api-error";
import { logger } from "@/lib/logger";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useBusinessContext } from "@/hooks/use-business-context";
import {
  DEFAULT_THROTTLE_FALLBACK_SECONDS,
  formatCountdown,
  useThrottleCountdown,
} from "@/hooks/use-throttle-countdown";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, AlertTriangle, Loader2 } from "lucide-react";

const signUpSchema = z.object({
  name: z
    .string()
    .min(2, "Full name must be at least 2 characters")
    .max(100, "Full name must be less than 100 characters")
    .regex(/^[a-zA-Z\s'-]+$/, "Full name can only contain letters, spaces, hyphens, and apostrophes"),
  email: z
    .string()
    .email("Please enter a valid email address")
    .max(255, "Email must be less than 255 characters"),
  phone: z
    .string()
    .min(10, "Phone number must be at least 10 digits")
    .max(25, "Phone number is too long")
    .regex(/^[+]?[\d\s\-()]+$/, "Please enter a valid phone number"),
});

type SignUpFormData = z.infer<typeof signUpSchema>;

const signUpResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal("pending"),
    email: z.string().optional(),
    registrationMode: z.enum(["email_link", "sms_otp"]).optional(),
  }).passthrough(),
});

const signUpAvailabilityResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    available: z.boolean(),
    registrationMode: z.enum(["email_link", "sms_otp"]).optional(),
  }),
});

const SignUpPage: FC = () => {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { business: orgInfo } = useBusinessContext();
  const registrationAvailability = useQuery({
    queryKey: ["/api/auth/registration/availability"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/auth/registration/availability", {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error("Sign-up is temporarily unavailable. Please try again later.");
      const parsed = signUpAvailabilityResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Sign-up availability could not be verified. Please try again later.");
      return parsed.data.data;
    },
    retry: false,
    staleTime: 10_000,
  });
  const isRegistrationAvailable = registrationAvailability.data?.available === true;
  const isRegistrationUnavailable = registrationAvailability.isError
    || (!registrationAvailability.isPending && !isRegistrationAvailable);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [signupError, setSignupError] = useState<string | null>(null);
  const { isThrottled, remainingSeconds, throttle, clear: clearThrottle } =
    useThrottleCountdown();

  const form = useForm<SignUpFormData>({
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
    },
    mode: "onChange",
  });

  const onSubmit = async (data: SignUpFormData) => {
    if (isThrottled || registrationAvailability.isError || !isRegistrationAvailable) return;
    setSignupError(null);
    setIsSubmitting(true);
    try {
      const registerBody = {
        name: data.name,
        email: data.email,
        phone: data.phone,
      };

      const response = await csrfFetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registerBody),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const retryAfterSeconds = response.status === 429
          ? parseRetryAfterSeconds(
            response.headers.get("retry-after"),
            response.headers.get("ratelimit-reset"),
          )
          : undefined;
        throw makeApiError(
          errorData,
          response.status,
          "Failed to sign up. Please try again.",
          retryAfterSeconds,
        );
      }

      const parsedResponse = signUpResponseSchema.safeParse(await response.json());
      if (!parsedResponse.success) {
        throw new Error("The sign-up response was invalid. Please try again.");
      }

      clearThrottle();
      const registrationMode = parsedResponse.data.data.registrationMode
        ?? registrationAvailability.data?.registrationMode
        ?? "sms_otp";
      toast({
        title: "Registration request received",
        description: registrationMode === "sms_otp"
          ? "If this email is new, we'll text a six-digit verification code. Existing accounts will receive password-reset instructions by email."
          : "Check your email for the registration link and next steps.",
      });
      setLocation(registrationMode === "sms_otp" ? "/verify-phone" : "/registration-email");
    } catch (error) {
      if (isAbortError(error)) return;
      if (error instanceof Error && ((error as { status?: number }).status === 429
        || (error as { code?: string }).code === "RATE_LIMITED")) {
        const retryAfter = (error as { retryAfterSeconds?: number | null }).retryAfterSeconds;
        throttle(
          retryAfter != null && retryAfter > 0
            ? retryAfter
            : DEFAULT_THROTTLE_FALLBACK_SECONDS,
        );
        return;
      }
      if (!isExpectedApiError(error)) logger.error("SignUp", "Registration error", error);
      const message = error instanceof Error ? error.message : "Failed to sign up. Please try again.";
      setSignupError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ErrorBoundary level="section">
      <div className="min-h-screen bg-background flex items-start sm:items-center justify-center p-4 pt-6 sm:pt-4">
        <Card className="w-full max-w-md mt-4 sm:mt-0">
          <CardHeader spacing="tight" padding="comfortable">
            {orgInfo?.logo && (
              <div className="flex justify-center mb-2">
                <img src={orgInfo.logo} alt={orgInfo.name} className="h-16 w-auto object-contain" />
              </div>
            )}
            <CardTitle size="2xl" weight="bold" className="text-center">
              {orgInfo ? `Welcome to ${orgInfo.name}` : "Create your LeagueVault account"}
            </CardTitle>
            <CardDescription className="text-center">
              Sign up to manage your league payments
            </CardDescription>
          </CardHeader>
          <CardContent padding="responsive">
            {registrationAvailability.isPending ? (
              <Alert data-testid="alert-signup-availability-loading">
                <Loader2 className="size-4 animate-spin" />
                <AlertTitle>Checking sign-up availability</AlertTitle>
                <AlertDescription>Please wait while we check this registration link.</AlertDescription>
              </Alert>
            ) : isRegistrationUnavailable ? (
              <Alert variant="destructive" data-testid="alert-signup-availability-unavailable">
                <AlertCircle className="size-4" />
                <AlertTitle>Sign-up unavailable</AlertTitle>
                  <AlertDescription gap="2" className="flex flex-wrap items-center">
                  <span>Use the registration link provided by your league administrator, or contact them for help.</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={registrationAvailability.isFetching}
                    onClick={() => void registrationAvailability.refetch()}
                  >
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3 sm:space-y-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem spacing="responsive">
                        <FormLabel>Full Name</FormLabel>
                        <FormControl><Input placeholder="John Doe" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem spacing="responsive">
                        <FormLabel>Email Address</FormLabel>
                        <FormControl>
                          <Input type="email" placeholder="john@example.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem spacing="responsive">
                        <FormLabel>Phone Number</FormLabel>
                        <FormControl>
                          <Input type="tel" placeholder="(555) 123-4567" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {isThrottled && (
                    <Alert variant="destructive" data-testid="alert-signup-throttled">
                      <AlertTriangle className="size-4" />
                      <AlertTitle>Too many sign-up attempts</AlertTitle>
                      <AlertDescription>
                        For your protection, sign-up is paused for about{" "}
                        <span data-testid="text-signup-retry-in">{formatCountdown(remainingSeconds)}</span>. Please try again then.
                      </AlertDescription>
                    </Alert>
                  )}
                  {signupError && !isThrottled && (
                    <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                      <AlertCircle className="size-4 shrink-0" />
                      <span>{signupError}</span>
                    </div>
                  )}
                  <Button type="submit" className="w-full mt-2" disabled={isSubmitting || isThrottled} data-testid="button-signup-submit">
                    {isSubmitting ? <><Loader2 className="mr-2 size-4 animate-spin" />Creating account…</> : isThrottled ? `Try again in ${formatCountdown(remainingSeconds)}` : "Create Account"}
                  </Button>
                </form>
              </Form>
            )}
          </CardContent>
          <CardFooter spacing="tight" className="flex flex-col items-center">
            <p className="text-sm text-muted-foreground">
              Already have an account? <Link href="/login" className="text-primary hover:underline">Sign in</Link>
            </p>
            <Link href="/privacy-policy" className="text-xs text-muted-foreground hover:underline">Privacy Policy</Link>
          </CardFooter>
        </Card>
      </div>
    </ErrorBoundary>
  );
};

export default SignUpPage;
