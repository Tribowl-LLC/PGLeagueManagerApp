import { useState } from "react";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import {
  apiRequest,
  queryClient,
  redirectToLoginForExpiredSession,
} from "@/lib/queryClient";
import {
  DEFAULT_THROTTLE_FALLBACK_SECONDS,
  formatCountdown,
  useThrottleCountdown,
} from "@/hooks/use-throttle-countdown";

type ApiErrorLike = Error & {
  status?: number;
  code?: string;
  retryAfterSeconds?: number | null;
};

function isRateLimitError(err: unknown): err is ApiErrorLike {
  if (!(err instanceof Error)) return false;
  const e = err as ApiErrorLike;
  return e.code === "RATE_LIMITED" || e.status === 429 || e.message.startsWith("429:");
}

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(6, "New password must be at least 6 characters"),
  confirmPassword: z.string().min(1, "Please confirm your new password"),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

type PasswordFormData = z.infer<typeof passwordSchema>;
type ChangePasswordResponse = {
  message?: string;
  requiresLogin?: boolean;
};

// Task #455: when `forced` is true the card mounts in the always-
// open state with no toggle and no Cancel button — it is rendered
// by the /change-password-required page after an admin reset, and
// the user has to complete the form before the route guard will
// stop bouncing them. The success path doesn't collapse back into
// the toggle either; the next /api/user refetch flips the flag and
// the guard releases the user automatically. `alwaysOpen` embeds the same
// form in Profile without implying an administrator reset.
export function ChangePasswordCard({ forced = false, alwaysOpen = false, onSuccess }: { forced?: boolean; alwaysOpen?: boolean; onSuccess?: () => void } = {}) {
  const { toast } = useToast();
  // These embedding props are stable for this card's lifetime, so the form
  // stays open for either focused route/dialog without syncing extra state.
  const [userOpen, setUserOpen] = useState(false);
  const [visibleFields, setVisibleFields] = useState({ current: false, next: false, confirm: false });
  const showForm = forced || alwaysOpen || userOpen;
  const { isThrottled, remainingSeconds, throttle, clear: clearThrottle } =
    useThrottleCountdown();

  const form = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const mutation = useMutation({
    mutationFn: async (data: PasswordFormData) => {
      return apiRequest<ChangePasswordResponse>("/api/account/change-password", "POST", {
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });
    },
    onSuccess: (response) => {
      form.reset();
      setVisibleFields({ current: false, next: false, confirm: false });
      // Task #455: in the forced-rotation flow we keep the form
      // mounted so the success toast is visible without an empty
      // collapsed card flashing in. The /api/user refetch
      // invalidation below releases the route guard and the user
      // navigates away naturally.
      if (!forced && !alwaysOpen) {
        setUserOpen(false);
      }
      clearThrottle();
      if (response.data?.requiresLogin === true) {
        toast({
          title: "Password Changed",
          description: "Your password has been updated. Please sign in again to continue.",
        });
        // The credential transaction committed, but Passport could not save
        // the refreshed session. Clear cached auth state before routing to a
        // normal login so the UI never presents the old session as valid.
        redirectToLoginForExpiredSession({
          cachedAuthenticated: true,
          force: true,
          reason: "credential-changed",
        });
        return;
      }
      // Task #455: invalidate /api/user so the guard sees
      // mustChangePassword=false on the next render and the user is
      // no longer pinned to /change-password-required.
      queryClient.invalidateQueries({ queryKey: ['/api/user'] });
      toast({ title: "Password Changed", description: "Your password has been updated successfully." });
      onSuccess?.();
    },
    onError: (error: Error) => {
      if (isRateLimitError(error)) {
        const retry = (error as ApiErrorLike).retryAfterSeconds;
        const waitSeconds =
          retry != null && retry > 0 ? retry : DEFAULT_THROTTLE_FALLBACK_SECONDS;
        throttle(waitSeconds);
        return;
      }
      toast({
        title: "Password Change Failed",
        description: error.message || "Failed to change password",
        variant: "destructive",
      });
    },
  });

  return (
    <Card surface={forced || alwaysOpen ? "plain" : "default"} noPadding={forced || alwaysOpen}>
      {!forced && !alwaysOpen && <CardHeader padding="standard">
        <CardTitle>Change Password</CardTitle>
        <CardDescription className="mt-1.5">Update your account password</CardDescription>
      </CardHeader>}
      <CardContent>
        {!showForm ? (
          <Button variant="outline" onClick={() => setUserOpen(true)} data-testid="button-change-password-toggle">
            <Lock className="size-4" />
            Change Password
          </Button>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit((data) => mutation.mutate(data))} className={forced || alwaysOpen ? "space-y-3" : "space-y-5"}>
              {isThrottled && (
                <Alert variant="destructive" data-testid="alert-change-password-throttled">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>Too many attempts</AlertTitle>
                  <AlertDescription spacing="tight">
                    <p>
                      You've made too many password change attempts. Please wait about{" "}
                      <span data-testid="text-change-password-retry-in">
                        {formatCountdown(remainingSeconds)}
                      </span>{" "}
                      and try again.
                    </p>
                    <p>
                      Can't remember your current password?{" "}
                      <Link
                        href="/forgot-password"
                        className="font-medium underline underline-offset-2"
                        data-testid="link-change-password-forgot"
                      >
                        Reset it instead
                      </Link>
                      .
                    </p>
                  </AlertDescription>
                </Alert>
              )}
              <FormField
                control={form.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current password</FormLabel>
                    <div className="relative">
                      <FormControl><Input type={visibleFields.current ? "text" : "password"} autoComplete="current-password" placeholder={forced ? "Temporary password" : undefined} trailing="lg" {...field} /></FormControl>
                      <button type="button" className="absolute inset-y-0 right-0 grid w-12 place-items-center text-muted-foreground hover:text-foreground" aria-label={`${visibleFields.current ? "Hide" : "Show"} current password`} aria-pressed={visibleFields.current} onClick={() => setVisibleFields(previous => ({ ...previous, current: !previous.current }))}>{visibleFields.current ? <EyeOff className="size-4.5" aria-hidden="true" /> : <Eye className="size-4.5" aria-hidden="true" />}</button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New password</FormLabel>
                    <div className="relative">
                      <FormControl><Input type={visibleFields.next ? "text" : "password"} autoComplete="new-password" placeholder={forced ? "Choose a new password" : undefined} trailing="lg" {...field} /></FormControl>
                      <button type="button" className="absolute inset-y-0 right-0 grid w-12 place-items-center text-muted-foreground hover:text-foreground" aria-label={`${visibleFields.next ? "Hide" : "Show"} new password`} aria-pressed={visibleFields.next} onClick={() => setVisibleFields(previous => ({ ...previous, next: !previous.next }))}>{visibleFields.next ? <EyeOff className="size-4.5" aria-hidden="true" /> : <Eye className="size-4.5" aria-hidden="true" />}</button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <p className="text-xs text-muted-foreground">At least 6 characters. New passwords must match.</p>
              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confirm new password</FormLabel>
                    <div className="relative">
                      <FormControl><Input type={visibleFields.confirm ? "text" : "password"} autoComplete="new-password" placeholder={forced ? "Re-enter your new password" : undefined} trailing="lg" {...field} /></FormControl>
                      <button type="button" className="absolute inset-y-0 right-0 grid w-12 place-items-center text-muted-foreground hover:text-foreground" aria-label={`${visibleFields.confirm ? "Hide" : "Show"} confirmed password`} aria-pressed={visibleFields.confirm} onClick={() => setVisibleFields(previous => ({ ...previous, confirm: !previous.confirm }))}>{visibleFields.confirm ? <EyeOff className="size-4.5" aria-hidden="true" /> : <Eye className="size-4.5" aria-hidden="true" />}</button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-2 pt-1">
                <Button
                  type="submit"
                  disabled={mutation.isPending || isThrottled}
                  data-testid="button-change-password-submit"
                >
                  {mutation.isPending ? (
                    <><Loader2 className="mr-2 size-4 animate-spin" />Updating…</>
                  ) : isThrottled ? (
                    `Try again in ${formatCountdown(remainingSeconds)}`
                  ) : <>{forced ? "Update password" : "Update Password"}{forced && <ArrowRight className="ml-2 size-4" aria-hidden="true" />}</>}
                </Button>
                {!forced && !alwaysOpen && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => { form.reset(); setUserOpen(false); }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}
