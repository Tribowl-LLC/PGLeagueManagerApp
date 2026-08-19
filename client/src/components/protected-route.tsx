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

export const ProtectedRoute: FC<ProtectedRouteProps> = ({ requirement, children }) => {
  const [location, navigate] = useLocation();
  const { toast } = useToast();
  const redirectingRef = useRef(false);

  const { data: currentUserResponse, isLoading, error } = useQuery<ApiResponse<User>>({
    queryKey: ['/api/user'],
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
  const onForcePage = location === FORCE_PASSWORD_CHANGE_PATH;

  useEffect(() => {
    if (!isLoading && !error && !allowed) {
      const { title, description, redirectTo } = DENY_MESSAGES[requirement];
      toast({ title, description, variant: 'destructive' });
      navigate(redirectTo);
    }
  }, [allowed, isLoading, error, requirement, navigate, toast]);

  useEffect(() => {
    if (!isLoading && !error && allowed && mustChangePassword && !onForcePage) {
      navigate(FORCE_PASSWORD_CHANGE_PATH);
    }
  }, [allowed, isLoading, error, mustChangePassword, onForcePage, navigate]);

  useEffect(() => {
    if (error && !redirectingRef.current) {
      redirectingRef.current = true;
      apiRequest('/api/auth/logout', 'POST', {}).catch(() => {}).finally(() => {
        window.location.href = '/login';
      });
    }
  }, [error]);

  if (isLoading || error) {
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

  return allowed ? <>{children}</> : null;
};
