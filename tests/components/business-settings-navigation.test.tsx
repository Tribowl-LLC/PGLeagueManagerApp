import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
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

function renderLayout(role: string, path = '/leagues') {
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
      <Router hook={() => [path, vi.fn()]}>
        <Layout>Content</Layout>
      </Router>
    </QueryClientProvider>,
  );
}

describe('Admin navigation', () => {
  it('shows the full Admin menu to system admins', () => {
    renderLayout('system_admin');

    expect(screen.queryByTestId('nav-link-/business-settings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-link-/locations')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-link-/users')).not.toBeInTheDocument();

    const adminMenu = screen.getByTestId('nav-submenu-trigger-/__super-admin');
    expect(adminMenu).toHaveTextContent('Admin');
    expect(adminMenu).not.toHaveTextContent('Super Admin');
    fireEvent.click(adminMenu);

    expect(screen.getByTestId('nav-link-/business-settings')).toHaveTextContent('Business Settings');
    expect(screen.getByTestId('nav-link-/locations')).toHaveTextContent('Locations');
    expect(screen.getByTestId('nav-link-/users')).toHaveTextContent('Users');
    expect(screen.getByTestId('nav-link-/email-templates')).toHaveTextContent('Email Templates');
    expect(screen.getByTestId('nav-link-/admin/email-delivery-alerts')).toHaveTextContent('Delivery Alerts');
    expect(screen.getByTestId('nav-link-/admin/deletion-requests')).toHaveTextContent('Deletion Requests');
    expect(screen.getByTestId('nav-link-/admin/apple-pay-jobs')).toHaveTextContent('Apple Pay Jobs');
    expect(screen.getByTestId('nav-link-/admin/data-integrity')).toHaveTextContent('Data Integrity');
    expect(screen.getByTestId('nav-link-/admin/email-change-audits')).toHaveTextContent('Email Change Audits');
    expect(screen.queryByTestId('nav-link-/organizations')).not.toBeInTheDocument();
  });

  it('shows only Locations and Users in the Admin menu for organization admins', () => {
    renderLayout('org_admin');

    const adminMenu = screen.getByTestId('nav-submenu-trigger-/__super-admin');
    expect(adminMenu).toHaveTextContent('Admin');
    fireEvent.click(adminMenu);

    expect(screen.queryByTestId('nav-link-/business-settings')).not.toBeInTheDocument();
    expect(screen.getByTestId('nav-link-/locations')).toHaveTextContent('Locations');
    expect(screen.getByTestId('nav-link-/users')).toHaveTextContent('Users');
    expect(screen.queryByTestId('nav-link-/email-templates')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-link-/admin/data-integrity')).not.toBeInTheDocument();
  });

  it('opens Admin when a moved page is active', () => {
    renderLayout('system_admin', '/locations');

    expect(screen.getByTestId('nav-submenu-trigger-/__super-admin')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('nav-link-/locations')).toHaveAttribute('aria-current', 'page');
  });

  it.each(['user', 'payment_manager'])('hides the Admin menu from %s', (role) => {
    renderLayout(role);

    expect(screen.queryByTestId('nav-link-/business-settings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-submenu-trigger-/__super-admin')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-link-/organizations')).not.toBeInTheDocument();
  });
});
