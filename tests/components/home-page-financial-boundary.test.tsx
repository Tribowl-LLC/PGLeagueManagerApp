import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomePage from '@/pages/home-page';
import { shouldRetryApiQuery } from '@/lib/queryClient';

vi.mock('@/components/layout', () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/apple-pay-recovery-banner', () => ({ ApplePayRecoveryBanner: () => null }));
vi.mock('@/components/square-catalog-cap-banner', () => ({ SquareCatalogCapBanner: () => null }));
vi.mock('@/components/error-boundary', () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

afterEach(() => vi.unstubAllGlobals());

function systemAdminQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: shouldRetryApiQuery, retryDelay: 0, staleTime: Infinity, queryFn: async () => ({ data: [] }) } },
  });
  queryClient.setQueryData(['/api/leagues'], { data: [] });
  queryClient.setQueryData(['/api/payments'], { data: [] });
  queryClient.setQueryData(['/api/bowlers'], { data: [] });
  queryClient.setQueryData(['/api/bowler-leagues'], { data: [] });
  queryClient.setQueryData(['/api/bowler-leagues', { enriched: true }], { data: [] });
  queryClient.setQueryData(['/api/teams'], { data: [] });
  queryClient.setQueryData(['/api/user'], { data: { role: 'system_admin', organizationId: 77, name: 'System Admin' } });
  return queryClient;
}

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
    expect(queryClient.getQueryState(['/api/financials/due-past-due', null])?.fetchStatus).toBe('idle');
  });

  it('counts one responsible bowler once across multiple leagues', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({ data: [] }) } } });
    queryClient.setQueryData(['/api/leagues'], { data: [{ id: 1, name: 'League A', active: true }, { id: 2, name: 'League B', active: true }] });
    queryClient.setQueryData(['/api/payments'], { data: [] });
    queryClient.setQueryData(['/api/bowlers'], { data: [{ id: 9, name: 'Active Bowler', active: true }] });
    queryClient.setQueryData(['/api/bowler-leagues'], { data: [{ bowlerId: 9, leagueId: 1, active: true }, { bowlerId: 9, leagueId: 2, active: true }] });
    queryClient.setQueryData(['/api/user'], { data: { role: 'org_admin', organizationId: 1, name: 'Admin' } });
    queryClient.setQueryData(['/api/financials/due-past-due', null], { data: { leagues: [
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
    queryClient.setQueryData(['/api/financials/due-past-due', null], { data: { leagues: [
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
    queryClient.setQueryData(['/api/financials/due-past-due', null], { data: { leagues: [
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
    queryClient.setQueryData(['/api/financials/due-past-due', null], { data: { leagues: [
      { leagueId: 1, report: { mode: 'canonical', rows: [{ payerBowlerId: 9, classification: 'past_due', outstandingMinor: 100, reviewRequired: true }] } },
    ] } });

    render(<QueryClientProvider client={queryClient}><HomePage /></QueryClientProvider>);

    const card = screen.getByText('Review League').closest('a');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('0 bowlers');
    expect(screen.getByText('1 review required (excluded)')).toBeInTheDocument();
  });

  it('uses the canonical business endpoint for the system-admin org-wide request', async () => {
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

    await waitFor(() => expect(requestedUrls).toContain('/api/financials/due-past-due'));
    expect(queryClient.getQueryCache().find({ queryKey: ['/api/financials/due-past-due', 77], exact: true })).toBeDefined();
  });

  it('shares one stale financial read between the home summary and past-due section', async () => {
    const financialRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/financials/due-past-due') {
        financialRequests.push(url);
        return new Response(JSON.stringify({ data: { leagues: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    const queryClient = systemAdminQueryClient();
    queryClient.setQueryData(['/api/financials/due-past-due', 77], { data: { leagues: [] } }, { updatedAt: Date.now() - 31_000 });

    render(<QueryClientProvider client={queryClient}><HomePage /></QueryClientProvider>);

    await waitFor(() => expect(financialRequests).toHaveLength(1));
    await waitFor(() => expect(queryClient.getQueryState(['/api/financials/due-past-due', 77])?.fetchStatus).toBe('idle'));
    expect(financialRequests).toHaveLength(1);
  });

  it('recovers from one transport failure before reporting a financial read error', async () => {
    const financialRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/financials/due-past-due') {
        financialRequests.push(url);
        if (financialRequests.length === 1) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ data: { leagues: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    const queryClient = systemAdminQueryClient();
    queryClient.setQueryData(['/api/financials/due-past-due', 77], { data: { leagues: [] } }, { updatedAt: Date.now() - 31_000 });

    render(<QueryClientProvider client={queryClient}><HomePage /></QueryClientProvider>);

    await waitFor(() => expect(queryClient.getQueryState(['/api/financials/due-past-due', 77])?.status).toBe('success'));
    await waitFor(() => expect(financialRequests).toHaveLength(2));
    expect(screen.queryByText(/Financial data could not be loaded|Financial evidence requires review/)).not.toBeInTheDocument();
  });

  it('keeps a financial evidence conflict visible without retrying', async () => {
    const financialRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/financials/due-past-due') {
        financialRequests.push(url);
        return new Response(JSON.stringify({ error: { code: 'FINANCIAL_EVIDENCE_INCOMPATIBLE', message: 'Financial evidence requires review' } }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    const queryClient = systemAdminQueryClient();

    render(<QueryClientProvider client={queryClient}><HomePage /></QueryClientProvider>);

    await waitFor(() => expect(screen.getByText('Financial evidence requires review; no balance is shown.')).toBeInTheDocument());
    expect(financialRequests).toHaveLength(1);
  });
});
