import { Switch, Route } from "wouter";
import { queryClient, prefetchQueries } from "./lib/queryClient";
import { logger } from "@/lib/logger";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { lazy, Suspense, useEffect, FC, ReactNode } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { ProtectedRoute, type RouteRequirement } from "@/components/protected-route";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { PageLoadingState } from "@/components/page-states";
import type { ApiResponse, User } from "@shared/schema";
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/login-page";

const HomePage = lazy(() => import("@/pages/home-page"));
const LeaguesPage = lazy(() => import("@/pages/leagues-page"));
const LeagueViewPage = lazy(() => import("@/pages/league-view-page"));
const ManagePaymentsPage = lazy(() => import("@/pages/manage-payments-page"));
const LeagueSchedulePage = lazy(() => import("@/pages/league-schedule-page"));
const TeamsPage = lazy(() => import("@/pages/teams-page"));
const TeamViewPage = lazy(() => import("@/pages/team-view-page"));
const BowlersPage = lazy(() => import("@/pages/bowlers-page"));
const BowlerViewPage = lazy(() => import("@/pages/bowler-view-page"));
const BowlerScoresPage = lazy(() => import("@/pages/bowler-scores-page"));
const LeagueScoresPage = lazy(() => import("@/pages/league-scores-page"));
const PaymentsPage = lazy(() => import("@/pages/payments-page"));
const PaymentHistoryPage = lazy(() => import("@/pages/payment-history-page"));
const MakePaymentPage = lazy(() => import("@/pages/make-payment-page"));
const ReportsPage = lazy(() => import("@/pages/reports-page"));
const LeaguePastDuePage = lazy(() => import("@/pages/league-past-due-page"));
const PastDuePage = lazy(() => import("@/pages/past-due-page"));
const SignUpPage = lazy(() => import("@/pages/sign-up-page"));
const BowlerDashboardPage = lazy(() => import("@/pages/bowler-dashboard-page"));
const OrganizationsPage = lazy(() => import("@/pages/organizations-page"));
const LocationsPage = lazy(() => import("@/pages/locations-page"));
const UsersPage = lazy(() => import("@/pages/users-page"));
const SetPasswordPage = lazy(() => import("@/pages/set-password-page"));
const ForgotPasswordPage = lazy(() => import("@/pages/forgot-password-page"));
const ConfirmEmailChangePage = lazy(() => import("@/pages/confirm-email-change-page"));
const ChangePasswordRequiredPage = lazy(() => import("@/pages/change-password-required-page"));
const ProfileSettingsPage = lazy(() => import("@/pages/profile-settings-page"));
const ClaimBowlerPage = lazy(() => import("@/pages/claim-bowler-page"));
const RegistrationCompletePage = lazy(() => import("@/pages/registration-complete-page"));
const AdminUnclaimedUsersPage = lazy(() => import("@/pages/admin-unclaimed-users-page"));
const EmailTemplatesPage = lazy(() => import("@/pages/email-templates-page"));
const IntegrationsPage = lazy(() => import("@/pages/integrations-page"));
const PrivacyPolicyPage = lazy(() => import("@/pages/privacy-policy-page"));
const DeleteAccountPage = lazy(() => import("@/pages/delete-account-page"));
const DeletionRequestsPage = lazy(() => import("@/pages/deletion-requests-page"));
const ApplePayJobsPage = lazy(() => import("@/pages/apple-pay-jobs-page"));
const DataIntegrityPage = lazy(() => import("@/pages/data-integrity-page"));
const AdminEmailChangeAuditsPage = lazy(() => import("@/pages/admin-email-change-audits-page"));
const MessagingPage = lazy(() => import("@/pages/messaging-page"));

function PageLoader() {
  return <PageLoadingState />;
}

const guard = (requirement: RouteRequirement, node: ReactNode) => (
  <ProtectedRoute requirement={requirement}>{node}</ProtectedRoute>
);

const RootRedirectHandler: FC = () => {
  const [, navigate] = useLocation();

  const { data: currentUserResponse, isLoading, error } = useQuery<ApiResponse<User>>({
    queryKey: ['/api/user'],
    staleTime: 1000 * 60 * 5,
  });

  useEffect(() => {
    if (!isLoading) {
      if (error || !currentUserResponse?.data) {
        navigate('/login');
      } else {
        const user = currentUserResponse.data;
        // Task #455: forced-rotation gate. If an admin reset this
        // user's password, the server flags `mustChangePassword=true`
        // on the row and the SAFE_USER_FIELDS allowlist surfaces it
        // here. Pinning the user to /change-password-required from
        // the root redirect keeps the forced-rotation behaviour
        // consistent with the per-route ProtectedRoute guard — the
        // user can't slip through by hitting `/` directly.
        if (user.mustChangePassword === true) {
          navigate('/change-password-required');
          return;
        }
        const isAdmin = user.role === 'system_admin' || user.role === 'org_admin';

        if (isAdmin && user.organizationId) {
          navigate('/home');
        } else if (user.bowlerId) {
          navigate('/bowler-dashboard');
        } else if (user.organizationId) {
          navigate('/leagues');
        } else {
          navigate('/login');
        }
      }
    }
  }, [isLoading, error, currentUserResponse, navigate]);

  if (isLoading) {
    return <PageLoader />;
  }

  return null;
};

function Router() {
  const { data: userData } = useQuery<ApiResponse<User>>({
    queryKey: ['/api/user'],
    staleTime: 1000 * 60 * 5,
  });

  useEffect(() => {
    if (userData?.data) {
      const user = userData.data;
      const isAdmin = user.role === 'system_admin' || user.role === 'org_admin';
      if (isAdmin || String(user.role) === 'payment_manager') {
        prefetchQueries('admin').catch((error) => logger.error('App', 'Failed to prefetch admin queries', error));
      } else if (user.bowlerId) {
        prefetchQueries('bowler').catch((error) => logger.error('App', 'Failed to prefetch bowler queries', error));
      }
    }
  }, [userData]);

  return (
    <Suspense fallback={<PageLoader />}>
      <Switch>
        {/* Public routes */}
        <Route path="/sign-up" component={SignUpPage} />
        <Route path="/signup" component={SignUpPage} />
        <Route path="/login" component={LoginPage} />
        <Route path="/set-password" component={SetPasswordPage} />
        <Route path="/forgot-password" component={ForgotPasswordPage} />
        <Route path="/confirm-email-change" component={ConfirmEmailChangePage} />
        <Route path="/privacy-policy" component={PrivacyPolicyPage} />
        <Route path="/delete-account" component={DeleteAccountPage} />
        <Route path="/claim-bowler">{guard('auth', <ClaimBowlerPage />)}</Route>
        <Route path="/registration-complete">{guard('auth', <RegistrationCompletePage />)}</Route>
        <Route path="/not-found" component={NotFound} />
        {/* Root route with redirect handler */}
        <Route path="/" component={RootRedirectHandler} />

        {/* Authenticated user routes */}
        <Route path="/bowler-dashboard">{guard('auth', <BowlerDashboardPage />)}</Route>
        <Route path="/payment-history">{guard('auth', <PaymentHistoryPage />)}</Route>
        <Route path="/make-payment">{guard('auth', <MakePaymentPage />)}</Route>
        <Route path="/profile">{guard('auth', <ProfileSettingsPage />)}</Route>
        {/* Task #455: forced-rotation landing after an admin reset.
            Guarded by `auth` (anonymous traffic gets bounced to login),
            but the ProtectedRoute exempts THIS path from its own
            mustChangePassword redirect to avoid an infinite loop. */}
        <Route path="/change-password-required">{guard('auth', <ChangePasswordRequiredPage />)}</Route>

        {/* Organization-member routes */}
        <Route path="/home">{guard('org', <HomePage />)}</Route>
        <Route path="/locations">{guard('orgAdmin', <LocationsPage />)}</Route>
        <Route path="/leagues">{guard('org', <LeaguesPage />)}</Route>
        <Route path="/leagues/:leagueId/payments/manage">{guard('paymentManager', <ManagePaymentsPage />)}</Route>
        <Route path="/leagues/:leagueId">{guard('org', <LeagueViewPage />)}</Route>
        <Route path="/leagues/:leagueId/schedule">{guard('org', <LeagueSchedulePage />)}</Route>
        <Route path="/leagues/:leagueId/teams">{guard('org', <TeamsPage />)}</Route>
        <Route path="/leagues/:leagueId/scores">{guard('org', <LeagueScoresPage />)}</Route>
        <Route path="/teams/:teamId">{guard('org', <TeamViewPage />)}</Route>
        <Route path="/bowlers">{guard('org', <BowlersPage />)}</Route>
        <Route path="/bowlers/:bowlerId">{guard('org', <BowlerViewPage />)}</Route>
        <Route path="/bowlers/:bowlerId/scores">{guard('org', <BowlerScoresPage />)}</Route>

        {/* Organization Admin routes */}
        <Route path="/payments">{guard('paymentManager', <PaymentsPage />)}</Route>
        <Route path="/reports">{guard('paymentManager', <ReportsPage />)}</Route>
        <Route path="/reports/leagues/:leagueId/past-due">{guard('paymentManager', <LeaguePastDuePage />)}</Route>
        <Route path="/reports/past-due">{guard('paymentManager', <PastDuePage />)}</Route>
        <Route path="/integrations">{guard('orgAdmin', <IntegrationsPage />)}</Route>
        <Route path="/messaging">{guard('orgAdmin', <MessagingPage />)}</Route>
        <Route path="/admin/unclaimed-users">{guard('orgAdmin', <AdminUnclaimedUsersPage />)}</Route>
        {/* System Admin routes */}
        <Route path="/organizations">{guard('systemAdmin', <OrganizationsPage />)}</Route>
        <Route path="/users">{guard('orgAdmin', <UsersPage />)}</Route>
        <Route path="/email-templates">{guard('systemAdmin', <EmailTemplatesPage />)}</Route>
        <Route path="/admin/deletion-requests">{guard('systemAdmin', <DeletionRequestsPage />)}</Route>
        <Route path="/admin/apple-pay-jobs">{guard('systemAdmin', <ApplePayJobsPage />)}</Route>
        <Route path="/admin/data-integrity">{guard('systemAdmin', <DataIntegrityPage />)}</Route>
        <Route path="/admin/email-change-audits">{guard('systemAdmin', <AdminEmailChangeAuditsPage />)}</Route>

        {/* Fallback route */}
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary level="page">
        <Router />
      </ErrorBoundary>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
