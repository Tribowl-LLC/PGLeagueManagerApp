import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TeamsPage from '@/pages/teams-page';
import DeletionRequestsPage from '@/pages/deletion-requests-page';

vi.mock('@/components/layout', () => ({ Layout: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock('@/components/team-form', () => ({ TeamForm: () => null }));
vi.mock('@/components/reorder-teams-dialog', () => ({ ReorderTeamsDialog: () => null }));
vi.mock('wouter', async (importOriginal) => ({
  ...await importOriginal<typeof import('wouter')>(),
  useParams: () => ({ leagueId: '7' }),
}));
const clients: QueryClient[] = [];
afterEach(() => { clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals(); });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
});
function show(kind: string) {
  const onError = vi.fn();
  const client = new QueryClient({
    queryCache: new QueryCache({ onError }),
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(['/api/user'], { success: true, data: { id: 9, role: 'system_admin' } });
  client.setQueryData(['/api/leagues/7'], { success: true, data: { id: 7, name: 'Fixture League' } });
  render(<QueryClientProvider client={client}>{kind === 'teams' ? <TeamsPage /> : <DeletionRequestsPage />}</QueryClientProvider>);
  return { client, onError };
}

describe.each(['teams', 'deletion requests'])('%s loading errors', (kind) => {
  it('shows access denied instead of an empty list and preserves HTTP details', async () => {
    const fetchMock = vi.fn(async () => json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403));
    vi.stubGlobal('fetch', fetchMock);
    const { onError } = show(kind);
    await screen.findByText(kind === 'teams' ? /don't have permission/ : /does not have access/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('text-requests-count')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0]).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('recovers from a server failure through the visible Retry button', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'SERVER_ERROR', message: 'Unavailable' } }, 503))
      .mockImplementation(async () => json({ success: true, data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    show(kind);
    await screen.findByText(/couldn't load/);
    expect(screen.queryByTestId('text-requests-count')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/couldn't load/)).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('hides previously loaded rows when a background refresh loses access', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, data: [] })));
    const { client } = show(kind);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403)));
    await client.invalidateQueries({ queryKey: kind === 'teams' ? ['/api/teams', 7] : ['/api/system-admin/deletion-requests', 'pending'] });
    await screen.findByText(kind === 'teams' ? /don't have permission/ : /does not have access/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('text-requests-count')).not.toBeInTheDocument();
  });
});
