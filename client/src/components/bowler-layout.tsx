/* eslint-disable shadcn/no-unknown-classes */
import { FC, ReactNode, Suspense } from "react";
import { useLocation, Link } from "wouter";
import { LayoutDashboard, History, UserCircle, Loader2, ArrowLeft, CreditCard, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { User, ApiResponse } from "@shared/schema";
import { ErrorBoundary } from "@/components/error-boundary";
import "./familiar-bowler-shell.css";

interface BowlerLayoutProps {
  children: ReactNode;
  bowlerName: string;
  leagueName: string;
  currentLeagueId?: number;
  onOpenLeagueSheet?: () => void;
}

interface NavItem {
  icon: typeof LayoutDashboard;
  label: string;
  mobileLabel: string;
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
      mobileLabel: "Overview",
      href: "/bowler-dashboard",
      baseHref: "/bowler-dashboard",
    },
    {
      icon: CreditCard,
      label: "Make Payment",
      mobileLabel: "Pay",
      href: makePaymentHref,
      baseHref: "/make-payment",
    },
    {
      icon: History,
      label: "Payment History",
      mobileLabel: "History",
      href: paymentHistoryHref,
      baseHref: "/payment-history",
    },
    {
      icon: UserCircle,
      label: "Profile",
      mobileLabel: "Profile",
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

export const BowlerLayout: FC<BowlerLayoutProps> = ({ children, bowlerName, leagueName, currentLeagueId, onOpenLeagueSheet }) => {
  const [location] = useLocation();
  const navItems = buildNavItems(currentLeagueId);
  const screen = location.startsWith("/bowler-dashboard")
    ? "overview"
    : location.startsWith("/payment-history")
      ? "history"
      : location.startsWith("/make-payment")
        ? "pay"
        : location.startsWith("/profile")
          ? "profile"
          : "overview";
  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 1000 * 60 * 5,
  });

  const isSystemAdmin = currentUserResponse?.data?.role === 'system_admin';

  return (
    <div className="familiar-bowler-shell bowler-familiar-shell fixed top-0 right-0 bottom-0 left-0 flex flex-col font-sans" data-bowler-flow="familiar-a" data-bowler-screen={screen}>
      <header className="familiar-bowler-header flex-none z-10">
        <div className="familiar-bowler-logo-bar" aria-label="Perfect Game">
          <img src="/perfect-game-dark-logo.png" alt="Perfect Game" />
        </div>
        <div className="familiar-bowler-league-bar">
          <button
            type="button"
            className="familiar-bowler-league-select"
            onClick={onOpenLeagueSheet}
            disabled={!onOpenLeagueSheet}
            aria-haspopup={onOpenLeagueSheet ? "dialog" : undefined}
            aria-expanded={onOpenLeagueSheet ? undefined : false}
          >
            <span>{leagueName || "Select a league"}</span>
            <ChevronDown aria-hidden="true" className="size-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="familiar-bowler-content max-w-4xl mx-auto w-full px-4 sm:px-6 py-6 pb-4">
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
                )}>
                  <span className="familiar-nav-label-full">{item.label}</span>
                  <span className="familiar-nav-label-mobile">{item.mobileLabel}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
};
