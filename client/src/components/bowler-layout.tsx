import { FC, ReactNode, Suspense } from "react";
import { useLocation, Link } from "wouter";
import { LayoutDashboard, History, UserCircle, Loader2, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Organization, User, ApiResponse } from "@shared/schema";
import { ErrorBoundary } from "@/components/error-boundary";
import { useSubdomainOrg } from "@/hooks/use-subdomain-org";

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
  return [
    {
      icon: LayoutDashboard,
      label: "Overview",
      href: "/bowler-dashboard",
      baseHref: "/bowler-dashboard",
    },
    {
      icon: History,
      label: "Payments",
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
  const { org: subdomainOrg } = useSubdomainOrg();

  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 1000 * 60 * 5,
  });

  const userOrgId = currentUserResponse?.data?.organizationId;
  const { data: userOrgResponse } = useQuery<ApiResponse<Organization>>({
    queryKey: ["/api/organizations", userOrgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${userOrgId}`, {
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      if (!res.ok) throw new Error(`Failed to fetch organization: ${res.status}`);
      return res.json();
    },
    staleTime: 1000 * 60 * 60,
    enabled: !!userOrgId,
    retry: false,
  });

  const organization = userOrgResponse?.data || (subdomainOrg ? { ...subdomainOrg, darkLogo: subdomainOrg.darkLogo } as Organization : undefined);
  const orgName = organization?.name || "Organization";
  const orgInitials = orgName.split(/\s+/).map(w => w[0]).join("").substring(0, 2).toUpperCase();

  const isSystemAdmin = currentUserResponse?.data?.role === 'system_admin';

  return (
    <div className="fixed top-0 right-0 bottom-0 left-0 flex flex-col bg-[#f8fafc] font-sans">
      <header className="flex-none bg-white border-b border-slate-200 px-4 h-14 flex items-center justify-center z-10 shadow-sm relative">
        {(organization?.logo || organization?.darkLogo) ? (
          <img
            src={organization.logo || organization.darkLogo || ''}
            alt={orgName}
            className="h-10 w-auto max-w-[200px] object-contain"
          />
        ) : organization ? (
          <div className="size-9 bg-slate-900 rounded-lg flex items-center justify-center shadow-inner">
            <span className="text-white font-bold text-sm tracking-wider">{orgInitials}</span>
          </div>
        ) : null}
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-6 pb-4">
          {isSystemAdmin && (
            <Link
              href="/"
              className="inline-flex items-center text-sm font-medium text-slate-500 hover:text-slate-800 transition-colors mb-4 no-underline focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm"
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

      <nav className="flex-none bg-white border-t border-slate-200 z-20 shadow-[0_-4px_12px_rgba(0,0,0,0.06)]">
        <div className="flex justify-center items-center gap-14 pt-2 pb-2" style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom, 8px))' }}>
          {navItems.map((item) => {
            const isActive = location === item.baseHref || location.startsWith(item.baseHref + '?') || location.startsWith(item.baseHref + '/');
            return (
              <Link
                key={item.baseHref}
                href={item.href}
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 w-16 no-underline rounded-md focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                  isActive ? "text-indigo-600" : "text-slate-400 active:text-slate-600"
                )}
              >
                <div className={cn(
                  "flex items-center justify-center w-10 h-7 rounded-full transition-all duration-200",
                  isActive ? "bg-indigo-50" : "bg-transparent"
                )}>
                  <item.icon className="size-7" />
                </div>
                <span className={cn(
                  "text-[10px] tracking-wide",
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
