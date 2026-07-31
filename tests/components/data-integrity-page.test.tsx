import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/components/layout', () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import DataIntegrityPage from '@/pages/data-integrity-page';

const ORIGINAL_FETCH = global.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async ({ queryKey }) => {
          const response = await fetch(queryKey[0] as string, { credentials: 'include' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        },
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <DataIntegrityPage />
    </QueryClientProvider>,
  );
}

describe('<DataIntegrityPage /> orphaned-data requests', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/system-admin/orphaned-data') {
        return jsonResponse(
          { success: false, error: { message: 'API endpoint not found' } },
          404,
        );
      }
      return jsonResponse({ success: true, data: [] });
    });
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('includes the active orphan type in the list endpoint', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/system-admin/orphaned-data/leagues',
        expect.objectContaining({ credentials: 'include' }),
      );
    });
    expect(global.fetch).not.toHaveBeenCalledWith(
      '/api/system-admin/orphaned-data',
      expect.anything(),
    );

    const teamsTab = await screen.findByTestId('button-orphan-tab-teams');
    await user.click(teamsTab);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/system-admin/orphaned-data/teams',
        expect.objectContaining({ credentials: 'include' }),
      );
    });
  });
});
