import { FC, useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import type { ApiResponse, User } from "@shared/schema";
import { ErrorBoundary } from "@/components/error-boundary";
import { PublicPageLayout } from "@/components/public-page-layout";
import { apiRequest, clearCsrfToken, queryClient } from "@/lib/queryClient";
import { logger } from "@/lib/logger";
import { Clock3, Home, Loader2, LogOut, MailCheck, RefreshCw } from "lucide-react";

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
  const [checkedManually, setCheckedManually] = useState(false);

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
    setCheckedManually(true);
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
      <PublicPageLayout>
        <article className="public-flow-card">
          <div className="public-flow-icon"><Clock3 className="size-6" aria-hidden="true" /></div>
          <p className="public-flow-eyebrow">Account setup</p>
          <h1 className="public-flow-title">Your account is almost ready</h1>
          <p className="public-flow-description">
            Your account is created. An administrator still needs to connect it to a bowler profile before your league appears.
          </p>

          <div className="public-flow-inset public-flow-waiting-inset">
            <span className="public-flow-inset-icon" aria-hidden="true"><MailCheck className="size-5" /></span>
            <div><strong>Waiting for administrator setup</strong><p>Only an administrator can make this connection. You can continue once your profile is linked.</p></div>
          </div>

          {statusError && <div className="public-flow-alert" role="alert"><strong>Couldn’t check registration status.</strong><p>Your account is still safe. Try again when you’re ready.</p></div>}

          <div className="public-flow-status-row" aria-live="polite">
            <span>{isLoading || isFetching ? "Checking registration status…" : statusError ? "Status check needs another try." : checkedManually ? "Checked just now. No profile has been linked yet." : "We’ll check again automatically."}</span>
            <button type="button" className="public-flow-secondary public-flow-status-button" onClick={checkStatus} disabled={isFetching} data-testid="button-check-registration-status">
              {isFetching ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
              {statusError ? "Try again" : "Check status"}
            </button>
          </div>

          <div className="public-flow-actions-stack">
            <Link href="/profile" className="public-flow-secondary"><Home className="size-4" aria-hidden="true" />View profile</Link>
            <button type="button" className="public-flow-link public-flow-sign-out" onClick={handleLogout} disabled={isLoggingOut} data-testid="button-registration-sign-out">
              {isLoggingOut ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <LogOut className="size-4" aria-hidden="true" />}
              {isLoggingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </article>
      </PublicPageLayout>
    </ErrorBoundary>
  );
};

export default RegistrationCompletePage;
