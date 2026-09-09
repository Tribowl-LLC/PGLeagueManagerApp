import { FC, ReactNode, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import type { ApiResponse, User } from '@shared/schema';

export type RouteRequirement =
  | 'auth'
  | 'org'
  | 'orgAdmin'
  | 'paymentManager'
  | 'systemAdmin';

interface ProtectedRouteProps {
  requirement: RouteRequirement;
  children: ReactNode;
}

const DENY_MESSAGES: Record<RouteRequirement, { title: string; description: string; redirectTo: string }> = {
  auth: {
    title: 'Authentication Required',
    description: 'Please login to access this page.',
    redirectTo: '/login',
  },
  org: {
    title: 'Access Denied',
    description: 'You need to be part of an organization to access this page.',
    redirectTo: '/',
  },
  orgAdmin: {
    title: 'Access Denied',
    description: 'You need organization administrator privileges to access this page.',
    redirectTo: '/',
  },
  paymentManager: {
    title: 'Access Denied',
    description: 'You need an administrator or assigned payment-manager account to access this page.',
    redirectTo: '/',
  },
  systemAdmin: {
    title: 'Access Denied',
    description: 'This feature is only available to system administrators.',
    redirectTo: '/',
  },
};

function userMeetsRequirement(user: User | undefined | null, requirement: RouteRequirement): boolean {
  if (!user?.id) return false;
  switch (requirement) {
    case 'auth':
      return true;
    case 'org':
      return user.organizationId !== null;
    case 'orgAdmin':
      return user.role === 'system_admin' || user.role === 'org_admin';
    case 'paymentManager':
      return (user.role === 'system_admin' || user.role === 'org_admin')
        || (String(user.role) === 'payment_manager'
          && user.organizationId !== null
          && user.locationId !== null);
    case 'systemAdmin':
      return user.role === 'system_admin';
  }
}

// Task #455: the dedicated forced-rotation landing page. Has to be
// authenticated (the user is already signed in via the admin-set
// password — the whole point is to make them rotate it) but must
// NOT itself be subject to the forced-rotation redirect, otherwise
// the guard would loop.
const FORCE_PASSWORD_CHANGE_PATH = '/change-password-required';

// These are the authenticated surfaces an unlinked self-registered user can
// use while waiting for an administrator. All league/app routes remain
// blocked until `bowlerId` is present. Claim stays available because an
// ordinary candidate list is filtered by the server to safely claimable
// profiles for the current user.
const PENDING_REGISTRATION_EXEMPT_PATHS = new Set([
  '/claim-bowler',
  '/profile',
  '/registration-complete',
  FORCE_PASSWORD_CHANGE_PATH,
]);

function isAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; status?: unknown };
  return candidate.code === 'AUTH_REQUIRED' || candidate.status === 401;
}

export const ProtectedRoute: FC<ProtectedRouteProps> = ({ requirement, children }) => {
  const [location, navigate] = useLocation();
  const { toast } = useToast();
  const redirectingRef = useRef(false);

  const { data: currentUserResponse, isLoading, isFetching, error } = useQuery<ApiResponse<User>>({
    queryKey: ['/api/user'],
    // Keep the guard's established cache window so ordinary protected-route
    // navigation does not refetch and remount every child. The pending page
    // owns its fresh status checks and polling, while root/login transitions
    // explicitly refresh the auth boundary.
    staleTime: 1000 * 60 * 5,
  });

  const user = currentUserResponse?.data;
  const allowed = userMeetsRequirement(user, requirement);
  // Task #455: when an admin reset this user's password, the server
  // sets `mustChangePassword=true` on the row and the next
  // /api/user response surfaces it via the SAFE_USER_FIELDS allowlist.
  // Until the user clears it via the self-service change-password
  // endpoint, every protected route bounces them to the forced-
  // rotation page. The bypass for the forced-rotation page itself
  // prevents an infinite redirect loop. The error/!allowed branches
  // above already short-circuit unauthenticated traffic, so this only
  // fires for authenticated callers.
  const mustChangePassword = user?.mustChangePassword === true;
  const pathWithoutQuery = location.split('?')[0];
  const onForcePage = pathWithoutQuery === FORCE_PASSWORD_CHANGE_PATH;
  const isPendingRegistration = user?.role === 'user' && !user.bowlerId;
  const onPendingRegistrationExemptPath = PENDING_REGISTRATION_EXEMPT_PATHS.has(pathWithoutQuery);
  // A transient /api/user failure while the cached user is still an ordinary
  // pending registration should leave the waiting/claim/profile surface
  // mounted so its own retry UI remains usable. Authentication failures are
  // still handled by the normal logout path below.
  const preservePendingRouteOnError = Boolean(
    error
    && user?.id
    && isPendingRegistration
    && onPendingRegistrationExemptPath
    && !isAuthenticationError(error)
  );

  useEffect(() => {
    if (
      !isLoading
      && !isFetching
      && !error
      && !allowed
      // An authenticated pending registration is routed to its waiting
      // state below, without an unrelated authorization toast. This does
      // not grant access to the requested route.
      && !(isPendingRegistration && !onPendingRegistrationExemptPath)
      && !(mustChangePassword && user?.id)
    ) {
      const { title, description, redirectTo } = DENY_MESSAGES[requirement];
      toast({ title, description, variant: 'destructive' });
      navigate(redirectTo);
    }
  }, [
    allowed,
    error,
    isFetching,
    isLoading,
    isPendingRegistration,
    mustChangePassword,
    navigate,
    onPendingRegistrationExemptPath,
    requirement,
    toast,
    user?.id,
  ]);

  useEffect(() => {
    if (!isLoading && !isFetching && !error && user?.id && mustChangePassword && !onForcePage) {
      navigate(FORCE_PASSWORD_CHANGE_PATH);
    }
  }, [allowed, error, isFetching, isLoading, mustChangePassword, onForcePage, navigate, user?.id]);

  useEffect(() => {
    if (
      !isLoading
      && !isFetching
      && !error
      && isPendingRegistration
      && !mustChangePassword
      && !onPendingRegistrationExemptPath
    ) {
      navigate('/registration-complete');
    }
  }, [
    allowed,
    error,
    isFetching,
    isLoading,
    mustChangePassword,
    isPendingRegistration,
    navigate,
    onPendingRegistrationExemptPath,
  ]);

  useEffect(() => {
    if (error && !preservePendingRouteOnError && !redirectingRef.current) {
      redirectingRef.current = true;
      apiRequest('/api/auth/logout', 'POST', {}).catch(() => {}).finally(() => {
        window.location.href = '/login';
      });
    }
  }, [error, preservePendingRouteOnError]);

  if (isLoading || (error && !preservePendingRouteOnError)) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }

  // Task #455: while the redirect-effect above is in flight, render
  // null instead of the children so the user can never momentarily
  // see (or interact with) the gated app surface in the gap between
  // the /api/user response landing and the navigate() taking effect.
  if (allowed && mustChangePassword && !onForcePage) return null;

  // Keep ordinary pending registrations from mounting league/admin surfaces
  // while their redirect effect settles. The waiting, claim, profile, and
  // forced-password routes are explicit exemptions and remain mounted.
  if (isPendingRegistration && !onPendingRegistrationExemptPath) return null;

  return allowed ? <>{children}</> : null;
};
