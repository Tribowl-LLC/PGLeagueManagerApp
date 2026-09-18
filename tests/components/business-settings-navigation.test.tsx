import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { Layout } from '@/components/layout';

vi.mock('@/components/user-profile-menu', () => ({ UserProfileMenu: () => null }));
vi.mock('@/components/global-search', () => ({ GlobalSearch: () => null }));

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderLayout(role: string) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: ({ queryKey }) => Promise.resolve(
          String(queryKey[0]).includes('count') ? { success: true, data: { count: 0 } } : { success: true, data: null },
        ),
      },
    },
  });
  client.setQueryData(['/api/user'], { success: true, data: { id: 1, role, organizationId: 7 } });
  client.setQueryData(['/api/business-settings'], {
    success: true,
    data: { id: 7, name: 'Fixture Business', logo: null, darkLogo: null },
  });

  render(
    <QueryClientProvider client={client}>
      <Router hook={() => ['/leagues', vi.fn()]}>
        <Layout>Content</Layout>
      </Router>
    </QueryClientProvider>,
  );
}

describe('Business Settings navigation', () => {
  it('shows Business Settings only to the Owner-level role', () => {
    renderLayout('system_admin');

    expect(screen.getByTestId('nav-link-/business-settings')).toHaveTextContent('Business Settings');
    expect(screen.queryByTestId('nav-link-/organizations')).not.toBeInTheDocument();
  });

  it.each(['org_admin', 'user', 'payment_manager'])('hides Business Settings from %s', (role) => {
    renderLayout(role);

    expect(screen.queryByTestId('nav-link-/business-settings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-link-/organizations')).not.toBeInTheDocument();
  });
});
