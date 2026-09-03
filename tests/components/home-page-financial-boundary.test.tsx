import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HomePage from '@/pages/home-page';

vi.mock('@/components/layout', () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/apple-pay-recovery-banner', () => ({ ApplePayRecoveryBanner: () => null }));
vi.mock('@/components/square-catalog-cap-banner', () => ({ SquareCatalogCapBanner: () => null }));
vi.mock('@/components/error-boundary', () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

describe('HomePage F1 financial boundary', () => {
  it('does not request the org-wide financial report for an ordinary member', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({ data: [] }) } },
    });
    queryClient.setQueryData(['/api/leagues'], { data: [{ id: 1, name: 'League', active: true }] });
    queryClient.setQueryData(['/api/payments'], { data: [] });
    queryClient.setQueryData(['/api/bowlers'], { data: [] });
    queryClient.setQueryData(['/api/bowler-leagues'], { data: [] });
    queryClient.setQueryData(['/api/user'], { data: { role: 'member', name: 'Member' } });

    render(<QueryClientProvider client={queryClient}><HomePage /></QueryClientProvider>);

    expect(screen.getByText('Bowlers Past Due (server contract)')).toBeInTheDocument();
    expect(queryClient.getQueryState(['/api/financials/due-past-due'])?.fetchStatus).toBe('idle');
  });

  it('counts one responsible bowler once across multiple leagues', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({ data: [] }) } } });
    queryClient.setQueryData(['/api/leagues'], { data: [{ id: 1, name: 'League A', active: true }, { id: 2, name: 'League B', active: true }] });
    queryClient.setQueryData(['/api/payments'], { data: [] });
    queryClient.setQueryData(['/api/bowlers'], { data: [{ id: 9, name: 'Active Bowler', active: true }] });
    queryClient.setQueryData(['/api/bowler-leagues'], { data: [{ bowlerId: 9, leagueId: 1, active: true }, { bowlerId: 9, leagueId: 2, active: true }] });
    queryClient.setQueryData(['/api/user'], { data: { role: 'org_admin', organizationId: 1, name: 'Admin' } });
    queryClient.setQueryData(['/api/financials/due-past-due'], { data: { leagues: [
      { leagueId: 1, report: { mode: 'canonical', rows: [{ payerBowlerId: 9, classification: 'past_due', outstandingMinor: 100, reviewRequired: false }] } },
      { leagueId: 2, report: { mode: 'canonical', rows: [{ payerBowlerId: 9, classification: 'past_due', outstandingMinor: 100, reviewRequired: false }] } },
    ] } });
    render(<QueryClientProvider client={queryClient}><HomePage /></QueryClientProvider>);
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });

  it('uses active memberships for the denominator even when fewer payers have financial rows', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({ data: [] }) } } });
    queryClient.setQueryData(['/api/leagues'], { data: [{ id: 1, name: 'League A', active: true }, { id: 2, name: 'Archived League', active: false }] });
    queryClient.setQueryData(['/api/payments'], { data: [] });
    queryClient.setQueryData(['/api/bowlers'], { data: [
      { id: 9, name: 'Active Payer', active: true },
      { id: 10, name: 'Active Member', active: true },
      { id: 11, name: 'Inactive Bowler', active: false },
      { id: 12, name: 'Archived League Payer', active: true },
    ] });
    queryClient.setQueryData(['/api/bowler-leagues'], { data: [
      { bowlerId: 9, leagueId: 1, active: true },
      { bowlerId: 10, leagueId: 1, active: true },
      { bowlerId: 11, leagueId: 1, active: true },
      { bowlerId: 12, leagueId: 2, active: true },
    ] });
    queryClient.setQueryData(['/api/user'], { data: { role: 'org_admin', organizationId: 1, name: 'Admin' } });
    queryClient.setQueryData(['/api/financials/due-past-due'], { data: { leagues: [
      { leagueId: 1, report: { mode: 'canonical', rows: [{ payerBowlerId: 9, classification: 'past_due', outstandingMinor: 100, reviewRequired: false }] } },
      { leagueId: 2, report: { mode: 'canonical', rows: [{ payerBowlerId: 12, classification: 'past_due', outstandingMinor: 100, reviewRequired: false }] } },
    ] } });

    render(<QueryClientProvider client={queryClient}><HomePage /></QueryClientProvider>);

    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('excludes debt for inactive memberships and inactive profiles from league and organization numerators', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({ data: [] }) } } });
    queryClient.setQueryData(['/api/leagues'], { data: [{ id: 1, name: 'League A', active: true }, { id: 2, name: 'League B', active: true }] });
    queryClient.setQueryData(['/api/payments'], { data: [] });
    queryClient.setQueryData(['/api/bowlers'], { data: [
      { id: 9, name: 'Active Payer', active: true },
      { id: 10, name: 'Active Elsewhere', active: true },
      { id: 11, name: 'Inactive Profile', active: false },
    ] });
    queryClient.setQueryData(['/api/bowler-leagues'], { data: [
      { bowlerId: 9, leagueId: 1, active: true },
      { bowlerId: 10, leagueId: 1, active: false },
      { bowlerId: 10, leagueId: 2, active: true },
      { bowlerId: 11, leagueId: 1, active: true },
    ] });
    queryClient.setQueryData(['/api/user'], { data: { role: 'org_admin', organizationId: 1, name: 'Admin' } });
    queryClient.setQueryData(['/api/financials/due-past-due'], { data: { leagues: [
      { leagueId: 1, report: { mode: 'canonical', rows: [
        { payerBowlerId: 9, classification: 'past_due', outstandingMinor: 100, reviewRequired: false },
        { payerBowlerId: 10, classification: 'past_due', outstandingMinor: 100, reviewRequired: true },
        { payerBowlerId: 11, classification: 'past_due', outstandingMinor: 100, reviewRequired: true },
      ] } },
      { leagueId: 2, report: { mode: 'canonical', rows: [] } },
    ] } });

    render(<QueryClientProvider client={queryClient}><HomePage /></QueryClientProvider>);

    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByText('1 (100%)')).toBeInTheDocument();
    expect(screen.getByText('2 review required (excluded)')).toBeInTheDocument();
    expect(screen.queryByText('3 (300%)')).not.toBeInTheDocument();
  });

  it('retains a zero-bowler league card when review evidence is present', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({ data: [] }) } } });
    queryClient.setQueryData(['/api/leagues'], { data: [{ id: 1, name: 'Review League', active: true }] });
    queryClient.setQueryData(['/api/payments'], { data: [] });
    queryClient.setQueryData(['/api/bowlers'], { data: [] });
    queryClient.setQueryData(['/api/bowler-leagues'], { data: [] });
    queryClient.setQueryData(['/api/user'], { data: { role: 'org_admin', organizationId: 1, name: 'Admin' } });
    queryClient.setQueryData(['/api/financials/due-past-due'], { data: { leagues: [
      { leagueId: 1, report: { mode: 'canonical', rows: [{ payerBowlerId: 9, classification: 'past_due', outstandingMinor: 100, reviewRequired: true }] } },
    ] } });

    render(<QueryClientProvider client={queryClient}><HomePage /></QueryClientProvider>);

    const card = screen.getByText('Review League').closest('a');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('0 bowlers');
    expect(screen.getByText('1 review required (excluded)')).toBeInTheDocument();
  });

  it('scopes the system-admin org-wide request and query key to the selected organization', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ data: { leagues: [] } }), { status: 200 });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({ data: [] }) } } });
    queryClient.setQueryData(['/api/leagues'], { data: [{ id: 1, name: 'Scoped League', active: true }] });
    queryClient.setQueryData(['/api/payments'], { data: [] });
    queryClient.setQueryData(['/api/bowlers'], { data: [] });
    queryClient.setQueryData(['/api/bowler-leagues'], { data: [] });
    queryClient.setQueryData(['/api/user'], { data: { role: 'system_admin', organizationId: 77, name: 'System Admin' } });

    render(<QueryClientProvider client={queryClient}><HomePage /></QueryClientProvider>);

    await waitFor(() => expect(requestedUrls).toContain('/api/financials/due-past-due?organizationId=77'));
    expect(queryClient.getQueryCache().find({ queryKey: ['/api/financials/due-past-due?organizationId=77'] })).toBeDefined();
    vi.unstubAllGlobals();
  });
});
