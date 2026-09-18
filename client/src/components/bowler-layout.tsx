import { FC, ReactNode, Suspense } from "react";
import { useLocation, Link } from "wouter";
import { LayoutDashboard, History, UserCircle, Loader2, ArrowLeft, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { User, ApiResponse } from "@shared/schema";
import { ErrorBoundary } from "@/components/error-boundary";
import { useBusinessContext } from "@/hooks/use-business-context";

interface BowlerLayoutProps {
  children: ReactNode;
  bowlerName: string;
  leagueName: string;
  currentLeagueId?: number;
}

interface NavItem {
  icon: typeof LayoutDashboard;
  label: string;
  href: string;
  baseHref: string;
}

function buildNavItems(currentLeagueId?: number): NavItem[] {
  const paymentHistoryHref = currentLeagueId
    ? `/payment-history?leagueId=${currentLeagueId}`
    : '/payment-history';
  const makePaymentHref = currentLeagueId
    ? `/make-payment?leagueId=${currentLeagueId}`
    : '/make-payment';
  return [
    {
      icon: LayoutDashboard,
      label: "Overview",
      href: "/bowler-dashboard",
      baseHref: "/bowler-dashboard",
    },
    {
      icon: CreditCard,
      label: "Make Payment",
      href: makePaymentHref,
      baseHref: "/make-payment",
    },
    {
      icon: History,
      label: "Payment History",
      href: paymentHistoryHref,
      baseHref: "/payment-history",
    },
    {
      icon: UserCircle,
      label: "Profile",
      href: "/profile",
      baseHref: "/profile",
    },
  ];
}

const LoadingFallback = () => (
  <div className="p-4 flex items-center justify-center">
    <Loader2 className="size-6 animate-spin text-muted-foreground" />
  </div>
);

export const BowlerLayout: FC<BowlerLayoutProps> = ({ children, bowlerName, leagueName, currentLeagueId }) => {
  const [location] = useLocation();
  const navItems = buildNavItems(currentLeagueId);
  const { business } = useBusinessContext();

  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 1000 * 60 * 5,
  });

  const organization = business;
  const orgName = organization?.name || "Organization";
  const orgInitials = orgName.split(/\s+/).map(w => w[0]).join("").substring(0, 2).toUpperCase();

  const isSystemAdmin = currentUserResponse?.data?.role === 'system_admin';

  return (
    <div className="fixed top-0 right-0 bottom-0 left-0 flex flex-col bg-app-shell font-sans">
      <header className="flex-none bg-white border-b border-navigation-200 px-4 h-14 flex items-center justify-center z-10 shadow-sm relative">
        {(organization?.logo || organization?.darkLogo) ? (
          <img
            src={organization.logo || organization.darkLogo || ''}
            alt={orgName}
            className="h-10 w-auto max-w-50 object-contain"
          />
        ) : organization ? (
          <div className="size-9 bg-navigation-900 rounded-lg flex items-center justify-center shadow-inner">
            <span className="text-white font-bold text-sm tracking-wider">{orgInitials}</span>
          </div>
        ) : null}
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-6 pb-4">
          {isSystemAdmin && (
            <Link
              href="/"
              className="inline-flex items-center text-sm font-medium text-navigation-500 hover:text-navigation-800 transition-colors mb-4 no-underline focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent-500 rounded-sm"
            >
              <ArrowLeft className="size-4 mr-1" />
              Back to Admin Dashboard
            </Link>
          )}
          <ErrorBoundary level="section" onReset={() => window.location.reload()}>
            <Suspense fallback={<LoadingFallback />}>
              {children}
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>

      <nav className="flex-none bg-white border-t border-navigation-200 z-20 mobile-navigation-shadow">
        <div className="grid grid-cols-4 w-full items-center gap-1 px-2 pt-2 pb-safe-area">
          {navItems.map((item) => {
            const isActive = location === item.baseHref || location.startsWith(item.baseHref + '?') || location.startsWith(item.baseHref + '/');
            return (
              <Link
                key={item.baseHref}
                href={item.href}
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex min-w-0 flex-col items-center justify-center gap-0.5 w-full no-underline rounded-md focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent-500",
                  isActive ? "text-brand-accent-600" : "text-navigation-400 active:text-navigation-600"
                )}
              >
                <div className={cn(
                  "flex items-center justify-center w-10 h-7 rounded-full transition-all duration-200",
                  isActive ? "bg-brand-accent-50" : "bg-transparent"
                )}>
                  <item.icon className="size-7" />
                </div>
                <span className={cn(
                  "navigation-badge tracking-wide text-center whitespace-nowrap",
                  isActive ? "font-bold" : "font-medium"
                )}>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
};
