import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { Home, Users, CreditCard, ChevronLeft, ChevronRight, Trophy, ClipboardPlus, LayoutDashboard, Loader2, Building2, MapPin, Mail, Plug, Menu, ChevronDown, Settings, Trash2, Apple, ShieldAlert, ShieldCheck, MessageSquare, MailWarning, UserPlus } from "lucide-react";
import { useState, useEffect, Suspense, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import type { ApiResponse, Organization, User } from "@shared/schema";
import { ErrorBoundary } from "@/components/error-boundary";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { UserProfileMenu } from "@/components/user-profile-menu";
import { GlobalSearch } from "@/components/global-search";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";


function getStoredValue<T>(key: string, defaultValue: T): T {
  try {
    if (typeof window === 'undefined') return defaultValue;
    const item = localStorage.getItem(key);
    return item ? (JSON.parse(item) as T) : defaultValue;
  } catch {
    return defaultValue;
  }
}

const setStoredValue = (key: string, value: unknown) => {
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch (error) {
    logger.warn('Layout', 'localStorage access error', error);
  }
};

interface NavItem {
  icon: typeof LayoutDashboard;
  label: string;
  // For navigable items this is the route. For dropdown-only parents
  // (e.g. "Super Admin") this is just a stable key — there is no
  // landing page and the row is never rendered as a `<Link>`.
  href: string;
  adminOnly?: boolean;
  orgAdminOnly?: boolean;
  paymentManagerAllowed?: boolean;
  // When present, this item renders as a parent row that toggles a
  // nested list of sub-items rather than navigating directly.
  subItems?: NavItem[];
  // When true, the item is pushed to the bottom of the sidebar nav
  // (just above the user profile area).
  pinToBottom?: boolean;
  // When set, the sidebar item shows a small numeric badge sourced from
  // this query key. The query is registered separately in `Layout` so
  // we can scope it to admins and control polling cadence in one place.
  badgeQueryKey?: readonly unknown[];
}

const navItems: NavItem[] = [
  {
    icon: Home,
    label: "Dashboard",
    href: "/"
  },
  {
    icon: Building2,
    label: "Organizations",
    href: "/organizations",
    adminOnly: true
  },
  {
    icon: MapPin,
    label: "Locations",
    href: "/locations",
    orgAdminOnly: true,
  },
  {
    icon: Users,
    label: "Users",
    href: "/users",
    orgAdminOnly: true,
  },
  {
    icon: Trophy,
    label: "Leagues",
    href: "/leagues",
  },
  {
    icon: Users,
    label: "Bowlers",
    href: "/bowlers"
  },
  {
    icon: CreditCard,
    label: "Payments",
    href: "/payments",
    orgAdminOnly: true,
    paymentManagerAllowed: true,
  },
  {
    icon: ClipboardPlus,
    label: "Reports",
    href: "/reports",
    orgAdminOnly: true,
    paymentManagerAllowed: true,
  },
  {
    icon: Plug,
    label: "Integrations",
    href: "/integrations",
    orgAdminOnly: true
  },
  {
    icon: MessageSquare,
    label: "Messaging",
    href: "/messaging",
    orgAdminOnly: true
  },
  {
    icon: UserPlus,
    label: "Unclaimed Users",
    href: "/admin/unclaimed-users",
    orgAdminOnly: true
  },
  // System-admin-only grouping pinned to the bottom of the sidebar.
  // The parent has no landing page; clicking it expands the sub-menu.
  // Pending-count badges from the children are aggregated onto the
  // parent row so admins still see "work waiting" at a glance when the
  // dropdown is collapsed (#591).
  {
    icon: ShieldCheck,
    label: "Super Admin",
    href: "/__super-admin",
    adminOnly: true,
    pinToBottom: true,
    subItems: [
      {
        icon: Mail,
        label: "Email Templates",
        href: "/email-templates",
        adminOnly: true,
      },
      {
        icon: Trash2,
        label: "Deletion Requests",
        href: "/admin/deletion-requests",
        adminOnly: true,
        badgeQueryKey: ['/api/system-admin/deletion-requests/pending-count'] as const,
      },
      {
        icon: Apple,
        label: "Apple Pay Jobs",
        href: "/admin/apple-pay-jobs",
        adminOnly: true,
        badgeQueryKey: ['/api/payments-provider/apple-pay/jobs/pending-count'] as const,
      },
      {
        icon: ShieldAlert,
        label: "Data Integrity",
        href: "/admin/data-integrity",
        adminOnly: true,
      },
      {
        icon: MailWarning,
        label: "Email Change Audits",
        href: "/admin/email-change-audits",
        adminOnly: true,
      },
    ],
  },
];

const pageLabels: Record<string, string> = {
  "/": "Overview",
  "/home": "Overview",
  "/organizations": "Organizations",
  "/locations": "Locations",
  "/users": "Users",
  "/email-templates": "Email Templates",
  "/admin/deletion-requests": "Deletion Requests",
  "/admin/apple-pay-jobs": "Apple Pay Jobs",
  "/admin/data-integrity": "Data Integrity",
  "/admin/email-change-audits": "Email Change Audits",
  "/admin/unclaimed-users": "Unclaimed Users",
  "/leagues": "Leagues",
  "/bowlers": "Bowlers",
  "/payments": "Payments",
  "/reports": "Reports",
  "/integrations": "Integrations",
  "/messaging": "Messaging",
  "/profile": "Profile",
};

function getPageLabel(path: string): string {
  if (pageLabels[path]) return pageLabels[path];
  if (path.startsWith("/leagues/")) return "League Details";
  if (path.startsWith("/bowlers/")) return "Bowler Details";
  if (path.startsWith("/teams/")) return "Team Details";
  if (path.startsWith("/reports/")) return "Report";
  return "Page";
}

function getParentLabel(path: string): { label: string; href: string } | null {
  if (path === "/" || path === "/home") return null;
  if (path.startsWith("/leagues/")) return { label: "Leagues", href: "/leagues" };
  if (path.startsWith("/bowlers/")) return { label: "Bowlers", href: "/bowlers" };
  if (path.startsWith("/teams/")) return { label: "Teams", href: "/leagues" };
  if (path.startsWith("/reports/")) return { label: "Reports", href: "/reports" };
  return { label: "Dashboard", href: "/" };
}

const LoadingFallback = () => (
  <div className="p-4 flex items-center justify-center">
    <Loader2 className="size-6 animate-spin text-muted-foreground" />
  </div>
);

function NavBadge({ count, isCollapsed }: { count: number; isCollapsed: boolean }) {
  if (count <= 0) return null;
  const display = count > 99 ? '99+' : String(count);
  return (
    <span
      data-testid="nav-badge"
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-red-500 text-white font-semibold tabular-nums",
        isCollapsed
          ? "absolute -top-1 -right-1 min-w-[18px] h-[18px] text-[10px] px-1"
          : "ml-auto min-w-[20px] h-5 px-1.5 text-xs"
      )}
      aria-label={`${count} pending`}
    >
      {display}
    </span>
  );
}

function isItemActive(href: string, location: string): boolean {
  return location === href || (href !== "/" && location.startsWith(href + "/"));
}

function getBadgeCount(item: NavItem, badgeCounts: Record<string, number>): number {
  return item.badgeQueryKey ? badgeCounts[item.badgeQueryKey.join('|')] ?? 0 : 0;
}

// Flat leaf nav row used both at the top level and inside the
// Super Admin dropdown (in the nested-list and popover variants).
//
// Rendered as a single `<a>` (wouter's `<Link>` produces an anchor by
// default) so middle-click / cmd-click open the route in a new tab and
// screen readers announce the row as one link instead of a button
// nested inside a link (#596).
function NavLeafRow({
  item,
  isActive,
  isCollapsed,
  badgeCount,
  onNavigate,
  variant = 'top',
}: {
  item: NavItem;
  isActive: boolean;
  isCollapsed: boolean;
  badgeCount: number;
  onNavigate?: () => void;
  variant?: 'top' | 'sub' | 'popover';
}) {
  // Sub-rows live in a nested list (slightly indented) or inside a popover
  // (full width, no indent, never "collapsed" styling). The top variant is
  // the existing sidebar row.
  const isSub = variant === 'sub';
  const isPopover = variant === 'popover';
  const effectiveCollapsed = isPopover ? false : isCollapsed;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      data-testid={`nav-link-${item.href}`}
      aria-label={effectiveCollapsed ? item.label : undefined}
      aria-current={isActive ? "page" : undefined}
      title={effectiveCollapsed ? item.label : undefined}
      className={cn(
        "flex w-full items-center gap-3 rounded-md transition-all duration-200 group no-underline",
        "focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f172a]",
        effectiveCollapsed
          ? "relative justify-center p-2.5"
          : isSub
            ? "pl-9 pr-3 py-2"
            : "px-3 py-2.5",
        isActive
          ? "bg-indigo-500/10 text-indigo-400"
          : "text-slate-300 hover:bg-slate-800 hover:text-white"
      )}
    >
      <item.icon
        className={cn(
          "size-5 shrink-0",
          isActive ? "text-indigo-400" : "text-slate-400 group-hover:text-slate-300"
        )}
      />
      {!effectiveCollapsed && (
        <span className={cn("font-medium", isSub ? "text-[13px]" : "text-sm")}>
          {item.label}
        </span>
      )}
      {item.badgeQueryKey && (
        <NavBadge count={badgeCount} isCollapsed={effectiveCollapsed} />
      )}
    </Link>
  );
}

// Parent row with a static list of sub-items (e.g. "Super Admin").
// - Expanded sidebar / mobile sheet: collapsible nested list, auto-open
//   when a child route is active.
// - Collapsed sidebar: icon button that opens a side popover listing the
//   sub-items as a flyout.
function NavSubMenu({
  item,
  isCollapsed,
  location,
  onNavigate,
  badgeCounts,
}: {
  item: NavItem;
  isCollapsed: boolean;
  location: string;
  onNavigate?: () => void;
  badgeCounts: Record<string, number>;
}) {
  const subItems = item.subItems ?? [];
  const childActive = subItems.some((s) => isItemActive(s.href, location));
  const aggregatedBadge = subItems.reduce(
    (sum, s) => sum + getBadgeCount(s, badgeCounts),
    0,
  );

  // Auto-expand whenever a child route is active. Users may also toggle
  // the menu open/closed manually; we re-sync on route change so
  // navigating into a child always reveals the sub-menu.
  const [userOpen, setUserOpen] = useState<boolean>(childActive);
  useEffect(() => {
    if (childActive) setUserOpen(true);
  }, [childActive]);

  // Popover open state for the collapsed-sidebar flyout.
  const [popoverOpen, setPopoverOpen] = useState(false);

  // Collapsed sidebar: icon trigger + popover flyout.
  if (isCollapsed) {
    return (
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid={`nav-submenu-trigger-${item.href}`}
            aria-label={item.label}
            aria-haspopup="menu"
            className={cn(
              "flex w-full items-center gap-3 rounded-md transition-all duration-200 group relative justify-center p-2.5",
              "focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f172a]",
              childActive
                ? "bg-indigo-500/10 text-indigo-400"
                : "text-slate-300 hover:bg-slate-800 hover:text-white"
            )}
            title={item.label}
          >
            <item.icon
              className={cn(
                "size-5 shrink-0",
                childActive ? "text-indigo-400" : "text-slate-400 group-hover:text-slate-300"
              )}
            />
            <NavBadge count={aggregatedBadge} isCollapsed />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={8}
          className="w-56 p-1 bg-[#0f172a] border-slate-800 text-slate-300"
        >
          <div className="px-3 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
            {item.label}
          </div>
          <div className="flex flex-col gap-0.5">
            {subItems.map((sub) => (
              <NavLeafRow
                key={sub.href}
                item={sub}
                isActive={isItemActive(sub.href, location)}
                isCollapsed={false}
                badgeCount={getBadgeCount(sub, badgeCounts)}
                onNavigate={() => {
                  setPopoverOpen(false);
                  onNavigate?.();
                }}
                variant="popover"
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  // Expanded sidebar / mobile sheet: collapsible nested list.
  return (
    <Collapsible open={userOpen} onOpenChange={setUserOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-testid={`nav-submenu-trigger-${item.href}`}
          aria-expanded={userOpen}
          className={cn(
            "flex w-full items-center gap-3 rounded-md transition-all duration-200 group px-3 py-2.5",
            "focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f172a]",
            childActive
              ? "bg-indigo-500/10 text-indigo-400"
              : "text-slate-300 hover:bg-slate-800 hover:text-white"
          )}
        >
          <item.icon
            className={cn(
              "size-5 shrink-0",
              childActive ? "text-indigo-400" : "text-slate-400 group-hover:text-slate-300"
            )}
          />
          <span className="font-medium text-sm">{item.label}</span>
          {!userOpen && aggregatedBadge > 0 && (
            <NavBadge count={aggregatedBadge} isCollapsed={false} />
          )}
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-slate-500 transition-transform",
              userOpen ? "rotate-180" : "rotate-0",
              !userOpen && aggregatedBadge > 0 ? "ml-1" : "ml-auto"
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1">
        <div className="flex flex-col gap-0.5 mt-0.5">
          {subItems.map((sub) => (
            <NavLeafRow
              key={sub.href}
              item={sub}
              isActive={isItemActive(sub.href, location)}
              isCollapsed={false}
              badgeCount={getBadgeCount(sub, badgeCounts)}
              onNavigate={onNavigate}
              variant="sub"
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SidebarNav({
  navItems,
  isAdmin,
  canSeeOrgAdminItems,
  isPaymentManager,
  isCollapsed,
  location,
  onNavigate,
  badgeCounts,
}: {
  navItems: NavItem[];
  isAdmin: boolean;
  canSeeOrgAdminItems: boolean;
  isPaymentManager: boolean;
  isCollapsed: boolean;
  location: string;
  onNavigate?: () => void;
  badgeCounts: Record<string, number>;
}) {
  const renderItem = (item: NavItem) => {
    if (item.adminOnly && !isAdmin) return null;
    if (item.orgAdminOnly && !canSeeOrgAdminItems && !(item.paymentManagerAllowed && isPaymentManager)) return null;

    if (item.subItems && item.subItems.length > 0) {
      return (
        <NavSubMenu
          key={item.href}
          item={item}
          isCollapsed={isCollapsed}
          location={location}
          onNavigate={onNavigate}
          badgeCounts={badgeCounts}
        />
      );
    }

    const isActive = isItemActive(item.href, location);
    const isDashboardActive =
      item.href === "/" && (location === "/" || location === "/home");

    return (
      <NavLeafRow
        key={item.href}
        item={item}
        isActive={isActive || isDashboardActive}
        isCollapsed={isCollapsed}
        badgeCount={getBadgeCount(item, badgeCounts)}
        onNavigate={onNavigate}
      />
    );
  };

  // Split items into top (default) and bottom (pinToBottom) so the
  // pinned ones sit just above the user profile area regardless of how
  // many other rows are present.
  const topItems = navItems.filter((i) => !i.pinToBottom);
  const bottomItems = navItems.filter((i) => i.pinToBottom);

  return (
    <nav className="flex-1 py-6 px-3 flex flex-col gap-1 overflow-y-auto">
      {topItems.map(renderItem)}
      {bottomItems.length > 0 && (
        <div className="mt-auto pt-4 flex flex-col gap-1 border-t border-slate-800/60">
          {bottomItems.map(renderItem)}
        </div>
      )}
    </nav>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [isCollapsed, setIsCollapsed] = useState(() =>
    getStoredValue("sidebarCollapsed", false)
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 1000 * 60 * 5,
  });

  const userOrgId = currentUserResponse?.data?.organizationId;

  const { data: organizationResponse } = useQuery<ApiResponse<Organization>>({
    queryKey: ["/api/organizations", userOrgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${userOrgId}`, {
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      if (!res.ok) throw new Error(`Failed to fetch organization: ${res.status}`);
      return res.json();
    },
    enabled: !!userOrgId,
    staleTime: 1000 * 60 * 5,
  });

  const userRole = currentUserResponse?.data?.role;
  const isAdmin = userRole === 'system_admin';
  const isSystemAdmin = userRole === 'system_admin';
  const isOrgAdmin = userRole === 'org_admin';
  const isPaymentManager = String(userRole) === 'payment_manager';
  const canSeeOrgAdminItems = isSystemAdmin || (isOrgAdmin && !!userOrgId);

  // Load the pending-deletion-request count for the sidebar badge on mount
  // and focus. Mutations on the deletion-requests page invalidate this key.
  // The deletion-requests page also invalidates this key on review,
  // which clears the badge as soon as the queue is empty.
  const { data: pendingDeletionResponse } = useQuery<ApiResponse<{ count: number }>>({
    queryKey: ['/api/system-admin/deletion-requests/pending-count'],
    enabled: isSystemAdmin,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  // System-admin only; Apple Pay mutations invalidate this key, and focus
  // refresh catches work completed outside this browser session (#313).
  const { data: pendingApplePayResponse } = useQuery<ApiResponse<{ count: number }>>({
    queryKey: ['/api/payments-provider/apple-pay/jobs/pending-count'],
    enabled: isSystemAdmin,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const badgeCounts = useMemo<Record<string, number>>(() => ({
    [['/api/system-admin/deletion-requests/pending-count'].join('|')]:
      pendingDeletionResponse?.data?.count ?? 0,
    [['/api/payments-provider/apple-pay/jobs/pending-count'].join('|')]:
      pendingApplePayResponse?.data?.count ?? 0,
  }), [
    pendingDeletionResponse?.data?.count,
    pendingApplePayResponse?.data?.count,
  ]);

  const toggleSidebar = useCallback(() => {
    setIsCollapsed((prev: boolean) => !prev);
  }, []);

  useEffect(() => {
    setStoredValue("sidebarCollapsed", isCollapsed);
  }, [isCollapsed]);

  const [location] = useLocation();

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location]);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) setMobileMenuOpen(false);
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const organization = organizationResponse?.data;
  const orgName = organization?.name || "LeagueVault";
  const orgInitials = orgName.split(/\s+/).map(w => w[0]).join("").substring(0, 2).toUpperCase();

  const parentLabel = getParentLabel(location);
  const pageLabel = getPageLabel(location);

  const logoElement = (organization?.darkLogo || organization?.logo) ? (
    <img
      src={organization.darkLogo || organization.logo || ''}
      alt={orgName}
      className="w-full h-auto max-h-12 object-contain"
    />
  ) : (
    <div className="size-10 rounded-md bg-indigo-500 flex items-center justify-center shadow-sm">
      <span className="text-sm font-bold text-white">{orgInitials}</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 font-sans flex overflow-hidden">
      <aside
        className={cn(
          "transition-all duration-300 ease-in-out bg-[#0f172a] text-slate-300 flex-col border-r border-slate-800 shadow-xl z-50 shrink-0 fixed top-0 bottom-0 left-0 hidden md:flex",
          isCollapsed ? "w-20" : "w-64"
        )}
      >
        <div className="border-b border-slate-800/60 shrink-0">
          <div className="flex items-center justify-center p-3">
            {logoElement}
          </div>
          <div className="flex justify-end px-3 pb-2">
            <button type="button"
              onClick={toggleSidebar}
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="p-1 rounded-md hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
            >
              <Menu className="size-4" />
            </button>
          </div>
        </div>

        <ErrorBoundary level="section" onReset={() => window.location.reload()}>
          <Suspense fallback={<LoadingFallback />}>
            <SidebarNav
              navItems={navItems}
              isAdmin={isAdmin}
              canSeeOrgAdminItems={canSeeOrgAdminItems}
              isPaymentManager={isPaymentManager}
              isCollapsed={isCollapsed}
              location={location}
              badgeCounts={badgeCounts}
            />
          </Suspense>
        </ErrorBoundary>

        <div className="p-4 border-t border-slate-800/60 shrink-0">
          {currentUserResponse?.data && (
            <div className={cn("flex items-center", isCollapsed ? "justify-center" : "gap-3")}>
              <UserProfileMenu user={currentUserResponse.data} />
              {!isCollapsed && (
                <div className="flex flex-col overflow-hidden">
                  <span className="text-sm font-medium text-white truncate">
                    {currentUserResponse.data.name || currentUserResponse.data.email}
                  </span>
                  <span className="text-xs text-slate-500 truncate">
                    {currentUserResponse.data.email}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="left" className="w-72 p-0 bg-[#0f172a] text-slate-300 border-slate-800 [&>button]:text-slate-400 [&>button]:hover:text-white">
          <SheetTitle className="sr-only">Navigation Menu</SheetTitle>
          <div className="border-b border-slate-800/60 shrink-0">
            <div className="flex items-center justify-center p-3">
              {logoElement}
            </div>
          </div>

          <ErrorBoundary level="section" onReset={() => window.location.reload()}>
            <Suspense fallback={<LoadingFallback />}>
              <SidebarNav
                navItems={navItems}
                isAdmin={isAdmin}
                canSeeOrgAdminItems={canSeeOrgAdminItems}
                isPaymentManager={isPaymentManager}
                isCollapsed={false}
                location={location}
                onNavigate={() => setMobileMenuOpen(false)}
                badgeCounts={badgeCounts}
              />
            </Suspense>
          </ErrorBoundary>

          <div className="p-4 border-t border-slate-800/60 shrink-0">
            {currentUserResponse?.data && (
              <div className="flex items-center gap-3">
                <UserProfileMenu user={currentUserResponse.data} />
                <div className="flex flex-col overflow-hidden">
                  <span className="text-sm font-medium text-white truncate">
                    {currentUserResponse.data.name || currentUserResponse.data.email}
                  </span>
                  <span className="text-xs text-slate-500 truncate">
                    {currentUserResponse.data.email}
                  </span>
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <main className={cn(
        "flex-1 flex flex-col min-h-screen transition-all duration-300",
        isCollapsed ? "md:ml-20" : "md:ml-64"
      )}>
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 md:px-8 shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.02)] z-10 sticky top-0">
          <div className="flex items-center gap-3 text-slate-500">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={mobileMenuOpen}
              className="p-2 -ml-2 rounded-md hover:bg-slate-100 text-slate-600 transition-colors md:hidden"
            >
              <Menu className="size-5" />
            </button>

            <div className="hidden sm:flex items-center">
              {parentLabel ? (
                <>
                  <Link href={parentLabel.href} className="text-sm font-medium hover:text-slate-900 transition-colors">{parentLabel.label}</Link>
                  <ChevronRight className="size-4 mx-2 text-slate-300" />
                  <span className="text-sm font-medium text-slate-900">{pageLabel}</span>
                </>
              ) : (
                <>
                  <Link href="/" className="text-sm font-medium hover:text-slate-900 transition-colors">Dashboard</Link>
                  <ChevronRight className="size-4 mx-2 text-slate-300" />
                  <span className="text-sm font-medium text-slate-900">{pageLabel}</span>
                </>
              )}
            </div>
            <span className="text-sm font-medium text-slate-900 sm:hidden">{pageLabel}</span>
          </div>

          <div className="flex items-center gap-3 md:gap-5">
            <GlobalSearch />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          <div className="max-w-[1400px] mx-auto">
            <ErrorBoundary level="section" onReset={() => window.location.reload()}>
              <Suspense fallback={<LoadingFallback />}>
                {children}
              </Suspense>
            </ErrorBoundary>
          </div>
        </div>
      </main>
    </div>
  );
}
