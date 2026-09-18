import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Organization } from '@shared/schema';
import BusinessSettingsPage from '@/pages/business-settings-page';

const { apiRequestMock, toastMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('@/components/layout', () => ({ Layout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/queryClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queryClient')>('@/lib/queryClient');
  return { ...actual, apiRequest: apiRequestMock };
});
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: toastMock }) }));

const business: Organization = {
  id: 1,
  name: 'Fixture Business',
  slug: 'fixture-business',
  subdomain: null,
  address: '123 Main Street',
  city: 'Detroit',
  state: 'MI',
  zipCode: '48201',
  phone: '313-555-0100',
  email: 'hello@example.com',
  logo: null,
  darkLogo: null,
  appIcon: null,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderPage({
  queryFn,
  seedBusiness = true,
}: {
  queryFn?: (queryKey: readonly unknown[]) => Promise<unknown>;
  seedBusiness?: boolean;
} = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: ({ queryKey }) => queryFn?.(queryKey) ?? Promise.resolve({ success: true, data: business }),
      },
    },
  });
  if (seedBusiness) {
    client.setQueryData(['/api/business-settings'], { success: true, data: business });
  }
  render(
    <QueryClientProvider client={client}>
      <BusinessSettingsPage />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  apiRequestMock.mockReset();
  toastMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('BusinessSettingsPage', () => {
  it('renders editable business details and omits retired tenant controls', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Business Settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Fixture Business');
    expect(screen.getByLabelText('Address')).toHaveValue('123 Main Street');
    expect(screen.getByLabelText('City')).toHaveValue('Detroit');
    expect(screen.getByLabelText('State')).toHaveValue('MI');
    expect(screen.getByLabelText('ZIP')).toHaveValue('48201');
    expect(screen.getByLabelText('Phone')).toHaveValue('313-555-0100');
    expect(screen.getByLabelText('Email')).toHaveValue('hello@example.com');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.queryByText(/subdomain|archive|restore|delete organization|switch organization/i)).not.toBeInTheDocument();
  });

  it('PATCHes the business settings and refreshes the cached branding context', async () => {
    const updatedBusiness = { ...business, name: 'Updated Business' };
    apiRequestMock.mockResolvedValue({ success: true, data: updatedBusiness });
    const client = renderPage();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Business' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Ann Arbor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/business-settings',
      'PATCH',
      expect.objectContaining({
        name: 'Updated Business',
        city: 'Ann Arbor',
        logo: null,
        darkLogo: null,
        appIcon: null,
      }),
    ));
    expect(await screen.findByRole('status')).toHaveTextContent('Business settings saved.');
    expect(client.getQueryData(['/api/business-settings'])).toEqual({ success: true, data: updatedBusiness });
  });

  it('rejects oversized branding files using the established 2MB validation', () => {
    renderPage();
    const file = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'logo.png', { type: 'image/png' });

    fireEvent.change(screen.getByLabelText('Logo'), { target: { files: [file] } });

    expect(apiRequestMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'File too large',
      variant: 'destructive',
    }));
  });

  it('keeps loading and error states actionable', async () => {
    const pending = new Promise<unknown>(() => {});
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, queryFn: () => pending } },
    });
    const { unmount } = render(<QueryClientProvider client={client}><BusinessSettingsPage /></QueryClientProvider>);
    expect(screen.getByText('Loading business settings…')).toBeInTheDocument();
    unmount();

    renderPage({ seedBusiness: false, queryFn: async () => { throw new Error('Service unavailable'); } });
    expect(await screen.findByText(/couldn't load business settings: service unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
