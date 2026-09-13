import { FC, useMemo, useState } from "react";
import { makeApiError, parseRetryAfterSeconds } from "@/lib/queryClient";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { getSubdomainSlug } from "@/lib/subdomain";
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
    .max(15, "Phone number must be less than 15 digits")
    .regex(/^[+]?[\d\s\-()]+$/, "Please enter a valid phone number"),
  leagueId: z
    .string()
    .min(1, "Please select a league"),
});

type SignUpFormData = z.infer<typeof signUpSchema>;

const signUpResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal("pending"),
    email: z.string().optional(),
  }).passthrough(),
});

interface OrgInfo {
  id: number;
  name: string;
  slug: string;
  logo: string | null;
}

interface League {
  id: number;
  name: string;
  organizationId?: number;
  organizationName?: string;
}

const SignUpPage: FC = () => {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [signupError, setSignupError] = useState<string | null>(null);
  const { isThrottled, remainingSeconds, throttle, clear: clearThrottle } =
    useThrottleCountdown();

  const orgSlug = useMemo(() => {
    const subdomainSlug = getSubdomainSlug();
    if (subdomainSlug) return subdomainSlug;
    const params = new URLSearchParams(searchString);
    return params.get("org") || null;
  }, [searchString]);

  const form = useForm<SignUpFormData>({
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      leagueId: "",
    },
    mode: "onChange",
  });

  const { data: orgResponse } = useQuery<{ success: boolean; data: OrgInfo }>({
    queryKey: ["/api/organizations/slug", orgSlug],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/slug/${orgSlug}`);
      if (!res.ok) throw new Error("Organization not found");
      return res.json();
    },
    enabled: !!orgSlug,
  });

  const orgInfo = orgResponse?.data ?? null;

  const { data: orgLeaguesResponse } = useQuery<{ success: boolean; data: League[] }>({
    queryKey: ["/api/organizations/slug", orgSlug, "leagues"],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/slug/${orgSlug}/leagues`);
      if (!res.ok) throw new Error("Failed to fetch leagues");
      return res.json();
    },
    enabled: !!orgSlug,
  });

  const { data: publicLeaguesResponse } = useQuery<{ success: boolean; data: League[] }>({
    queryKey: ["/api/organizations/public-leagues"],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/public-leagues`);
      if (!res.ok) throw new Error("Failed to fetch leagues");
      return res.json();
    },
    enabled: !orgSlug,
  });

  const leagues = orgSlug
    ? (orgLeaguesResponse?.data ?? [])
    : (publicLeaguesResponse?.data ?? []);
  const showOrgInLabel = !orgSlug;

  const onSubmit = async (data: SignUpFormData) => {
    if (isThrottled) return;
    setSignupError(null);
    setIsSubmitting(true);
    try {
      const selectedLeagueId = Number(data.leagueId);
      const selectedLeague = leagues.find((league) => league.id === selectedLeagueId);
      const resolvedOrgId = orgInfo?.id ?? selectedLeague?.organizationId;
      const registerBody: Record<string, unknown> = {
        name: data.name,
        email: data.email,
        phone: data.phone,
        leagueId: data.leagueId,
      };
      if (resolvedOrgId) registerBody.organizationId = resolvedOrgId;

      const response = await fetch("/api/auth/register", {
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
      toast({
        title: "Registration request received",
        description: "If registration can continue, we'll send setup instructions to your email.",
      });
      setLocation("/registration-email");
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
          <CardHeader className="space-y-1 pb-4 sm:pb-6">
            {orgInfo?.logo && (
              <div className="flex justify-center mb-2">
                <img src={orgInfo.logo} alt={orgInfo.name} className="h-16 w-auto object-contain" />
              </div>
            )}
            <CardTitle className="text-2xl font-bold text-center">
              {orgInfo ? `Welcome to ${orgInfo.name}` : "Join Your Bowling League"}
            </CardTitle>
            <CardDescription className="text-center">
              Sign up to manage your weekly league payments
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-4 sm:pb-6">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3 sm:space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="space-y-1 sm:space-y-2">
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
                    <FormItem className="space-y-1 sm:space-y-2">
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
                    <FormItem className="space-y-1 sm:space-y-2">
                      <FormLabel>Phone Number</FormLabel>
                      <FormControl>
                        <Input type="tel" placeholder="(555) 123-4567" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="leagueId"
                  render={({ field }) => (
                    <FormItem className="space-y-1 sm:space-y-2">
                      <FormLabel>League</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl><SelectTrigger><SelectValue placeholder="Select a league" /></SelectTrigger></FormControl>
                        <SelectContent>
                          {Array.isArray(leagues) ? leagues.map((league) => (
                            <SelectItem key={league.id} value={league.id.toString()}>
                              {showOrgInLabel && league.organizationName
                                ? `${league.organizationName} — ${league.name}`
                                : league.name}
                            </SelectItem>
                          )) : null}
                        </SelectContent>
                      </Select>
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
          </CardContent>
          <CardFooter className="flex flex-col items-center gap-2 pt-0">
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
