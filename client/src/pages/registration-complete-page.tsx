import { FC, useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import type { ApiResponse, User } from "@shared/schema";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiRequest, clearCsrfToken, queryClient } from "@/lib/queryClient";
import { logger } from "@/lib/logger";
import { Clock3, Loader2, LogOut, MailCheck, RefreshCw } from "lucide-react";

const REGISTRATION_STATUS_INTERVAL_MS = 30_000;

function isDocumentVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Waiting room for an authenticated ordinary account that has not been
 * connected to a bowler yet. The account remains useful here: the user can
 * update their profile or sign out while an administrator completes setup.
 */
const RegistrationCompletePage: FC = () => {
  const [, setLocation] = useLocation();
  const [isVisible, setIsVisible] = useState(isDocumentVisible);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const {
    data: userResponse,
    error: statusError,
    isLoading,
    isFetching,
    refetch,
  } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    // Registration status can change in another browser/session. Do not
    // treat the cached null bowlerId as authoritative for this page.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: isVisible ? REGISTRATION_STATUS_INTERVAL_MS : false,
    retry: false,
  });

  const checkStatus = useCallback(() => {
    void refetch();
  }, [refetch]);

  // React Query's normal window-focus behavior is disabled globally in this
  // app. Handle focus and visibility explicitly so a hidden tab does not
  // poll, while returning to the page immediately checks for a new link.
  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = isDocumentVisible();
      setIsVisible(visible);
      if (visible) void refetch();
    };
    const handleWindowFocus = () => {
      if (isDocumentVisible()) void refetch();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [refetch]);

  useEffect(() => {
    // Wait for the first fresh request before routing. This prevents a stale
    // linked user in the shared cache from causing a route bounce.
    if (!isFetching && !statusError && userResponse?.data?.bowlerId) {
      queryClient.setQueryData(["/api/user"], userResponse);
      setLocation("/bowler-dashboard");
    }
  }, [isFetching, setLocation, statusError, userResponse]);

  const handleLogout = async () => {
    try {
      setIsLoggingOut(true);
      await apiRequest("/api/auth/logout", "POST", {});
      clearCsrfToken();
      queryClient.removeQueries({ queryKey: ["/api/user"] });
      window.location.href = "/login";
    } catch (error) {
      logger.error("RegistrationComplete", "Logout failed", error);
      setIsLoggingOut(false);
    }
  };

  return (
    <ErrorBoundary level="section">
      <div className="min-h-screen bg-background flex items-start sm:items-center justify-center p-4 pt-6 sm:pt-4">
        <Card className="w-full max-w-md mt-4 sm:mt-0">
          <CardHeader spacing="relaxed" className="text-center">
            <div className="flex justify-center">
              <Clock3 className="size-12 text-primary" aria-hidden="true" />
            </div>
            <CardTitle size="2xl" weight="bold">Registration in progress</CardTitle>
            <CardDescription>
              Your account is waiting for administrator setup.
            </CardDescription>
          </CardHeader>
          <CardContent spacing="normal">
            <div className="rounded-md border bg-muted/40 p-4 flex items-start gap-3">
              <MailCheck className="size-5 text-primary mt-0.5 shrink-0" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                Your sign-in account has been created. A league administrator
                needs to connect it to your bowler profile. We’ll request an
                email notification when your account is ready. This page
                checks automatically, and you can return here to check the
                status yourself.
              </p>
            </div>

            {statusError && (
              <Alert variant="destructive" role="alert">
                <AlertTitle>Couldn’t check registration status</AlertTitle>
                <AlertDescription spacing="normal">
                  <p>
                    We couldn’t reach the registration service. Your account
                    is still safe; please try again.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={checkStatus}
                    disabled={isFetching}
                  >
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-sm text-muted-foreground" aria-live="polite">
              <span>{isLoading || isFetching ? "Checking registration status…" : "We’ll check again automatically."}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={checkStatus}
                disabled={isFetching}
                className="w-full sm:w-auto shrink-0"
                data-testid="button-check-registration-status"
              >
                {isFetching ? <Loader2 className="size-4 mr-2 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4 mr-2" aria-hidden="true" />}
                Check registration status
              </Button>
            </div>
          </CardContent>
          <CardFooter spacing="tight" className="flex flex-col">
            <Button asChild variant="outline" className="w-full">
              <Link href="/profile">View Profile</Link>
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={handleLogout}
              disabled={isLoggingOut}
              data-testid="button-registration-sign-out"
            >
              {isLoggingOut ? <Loader2 className="size-4 mr-2 animate-spin" aria-hidden="true" /> : <LogOut className="size-4 mr-2" aria-hidden="true" />}
              {isLoggingOut ? "Signing out…" : "Sign out"}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </ErrorBoundary>
  );
};

export default RegistrationCompletePage;
