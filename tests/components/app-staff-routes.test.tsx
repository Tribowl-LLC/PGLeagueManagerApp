import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { queryClient } from '@/lib/queryClient';
import App from '@/App';

vi.mock('@/lib/queryClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queryClient')>();
  return { ...actual, prefetchQueries: vi.fn(async () => {}) };
});

vi.mock('@/pages/bowler-dashboard-page', () => ({
  default: () => <div data-testid="bowler-dashboard">Bowler dashboard</div>,
}));
vi.mock('@/pages/league-schedule-page', () => ({
  default: () => <div data-testid="staff-schedule">Staff schedule</div>,
}));
vi.mock('@/pages/admin-weekly-payments-page', () => ({
  default: () => <div data-testid="admin-weekly-payments">Admin weekly payments</div>,
}));
vi.mock('@/pages/payments-page', () => ({
  default: () => <div data-testid="payments-page">Payments page</div>,
}));
vi.mock('@/pages/leagues-page', () => ({
  default: () => <div data-testid="leagues-page">Leagues page</div>,
}));
vi.mock('@/pages/registration-complete-page', () => ({
  default: () => <div data-testid="registration-complete">Registration pending</div>,
}));
vi.mock('@/pages/change-password-required-page', () => ({
  default: () => <div data-testid="password-change-required">Change password</div>,
}));

function renderRoute(path: string, user: {
  role: 'user' | 'org_admin' | 'payment_manager';
  bowlerId: number | null;
  locationId?: number | null;
  mustChangePassword?: boolean;
}) {
  queryClient.setQueryData(['/api/user'], {
    success: true,
    data: {
      id: 7,
      role: user.role,
      organizationId: 1,
      locationId: user.locationId ?? null,
      bowlerId: user.bowlerId,
      mustChangePassword: user.mustChangePassword ?? false,
    },
  });
  const location = memoryLocation({ path, record: true });
  render(<Router hook={location.hook}><App /></Router>);
  return location;
}

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('staff routes', () => {
  it.each([
    '/home',
    '/leagues',
    '/leagues/7',
    '/manage-payments',
    '/leagues/7/schedule',
    '/leagues/7/teams',
    '/leagues/7/scores',
    '/teams/3',
    '/bowlers',
    '/bowlers/9',
    '/bowlers/9/scores',
  ])('sends an ordinary linked bowler from %s to the four-tab dashboard', async (path) => {
    const location = renderRoute(path, { role: 'user', bowlerId: 9 });

    expect(await screen.findByTestId('bowler-dashboard')).toBeInTheDocument();
    expect(location.history.at(-1)).toBe('/bowler-dashboard');
    expect(screen.queryByTestId('staff-schedule')).not.toBeInTheDocument();
  });

  it.each([
    { role: 'org_admin' as const, locationId: null },
    { role: 'payment_manager' as const, locationId: 4 },
  ])('keeps the staff schedule available to $role', async ({ role, locationId }) => {
    const location = renderRoute('/leagues/7/schedule', { role, locationId, bowlerId: null });

    expect(await screen.findByTestId('staff-schedule')).toBeInTheDocument();
    expect(location.history).toEqual(['/leagues/7/schedule']);
  });

  it('keeps an unlinked ordinary account on the registration path', async () => {
    const location = renderRoute('/leagues/7/schedule', { role: 'user', bowlerId: null });

    expect(await screen.findByTestId('registration-complete')).toBeInTheDocument();
    expect(location.history.at(-1)).toBe('/registration-complete');
  });

  it('allows organization admins on Manage Payments and keeps payment managers on the existing Payments route only', async () => {
    const adminLocation = renderRoute('/manage-payments', { role: 'org_admin', bowlerId: null });
    expect(await screen.findByTestId('admin-weekly-payments')).toBeInTheDocument();
    expect(adminLocation.history).toEqual(['/manage-payments']);
    cleanup();
    queryClient.clear();

    const managerLocation = renderRoute('/payments', { role: 'payment_manager', bowlerId: null, locationId: 4 });
    expect(await screen.findByTestId('payments-page')).toBeInTheDocument();
    expect(managerLocation.history).toEqual(['/payments']);
    cleanup();
    queryClient.clear();

    const deniedLocation = renderRoute('/manage-payments', { role: 'payment_manager', bowlerId: null, locationId: 4 });
    expect(await screen.findByText('Access Denied')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-weekly-payments')).not.toBeInTheDocument();
    expect(deniedLocation.history.at(-1)).toBe('/');
  });

  it('keeps forced password rotation ahead of the bowler redirect', async () => {
    const location = renderRoute('/leagues/7/schedule', {
      role: 'user', bowlerId: 9, mustChangePassword: true,
    });

    expect(await screen.findByTestId('password-change-required')).toBeInTheDocument();
    expect(location.history.at(-1)).toBe('/change-password-required');
  });
});
