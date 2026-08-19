import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  UsersTable,
  type UsersTableUser,
  type UsersTableLocation,
} from '@/components/users-table';

const ORG_ID = 1;

function makeUser(overrides: Partial<UsersTableUser> = {}): UsersTableUser {
  return {
    id: 100,
    email: 'pat@example.com',
    name: 'Pat Bowler',
    role: 'user',
    organizationId: ORG_ID,
    locationId: null,
    bowlerId: null,
    invitation: null,
    createdAt: '2026-01-01T00:00:00Z',
    linkedBowler: null,
    ...overrides,
  };
}

function renderTable(props: {
  users: UsersTableUser[];
  currentUser?: UsersTableUser;
  onResetPassword?: (id: number) => void;
  onDeleteUser?: (id: number) => void;
  onChangeEmail?: (id: number) => void;
  orgLocations?: UsersTableLocation[];
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <UsersTable
        users={props.users}
        currentUser={props.currentUser ?? makeUser({ id: 1, role: 'org_admin', name: 'Admin' })}
        orgLocations={props.orgLocations ?? []}
        onDeleteUser={props.onDeleteUser ?? (() => {})}
        onResetPassword={props.onResetPassword ?? (() => {})}
        onChangeEmail={props.onChangeEmail ?? (() => {})}
      />
    </QueryClientProvider>,
  );
}

describe('UsersTable — Reset Password button', () => {
  it('renders the button for a normal user in the same org', () => {
    const target = makeUser({ id: 100, role: 'user', name: 'Pat Bowler' });
    renderTable({ users: [target] });
    expect(screen.getByTestId(`button-reset-password-${target.id}`)).toBeInTheDocument();
  });

  it('hides the button on the current admin\'s own row', () => {
    const admin = makeUser({ id: 1, role: 'org_admin', name: 'Admin' });
    renderTable({ users: [admin], currentUser: admin });
    expect(screen.queryByTestId(`button-reset-password-${admin.id}`)).toBeNull();
  });

  it('hides the button on system_admin rows', () => {
    const sysAdmin = makeUser({ id: 200, role: 'system_admin', name: 'Sys Admin' });
    renderTable({ users: [sysAdmin] });
    expect(screen.queryByTestId(`button-reset-password-${sysAdmin.id}`)).toBeNull();
  });

  it('still shows the button when the current user is undefined', () => {
    const target = makeUser({ id: 100, role: 'user' });
    renderTable({ users: [target], currentUser: undefined });
    expect(screen.getByTestId(`button-reset-password-${target.id}`)).toBeInTheDocument();
  });

  it('invokes onResetPassword with the user id when clicked', async () => {
    const onResetPassword = vi.fn();
    const target = makeUser({ id: 100, role: 'user' });
    renderTable({ users: [target], onResetPassword });
    await userEvent.click(screen.getByTestId(`button-reset-password-${target.id}`));
    expect(onResetPassword).toHaveBeenCalledTimes(1);
    expect(onResetPassword).toHaveBeenCalledWith(target.id);
  });

  it('hides the button when an org_admin somehow sees a cross-org row', () => {
    const orgAdmin = makeUser({ id: 1, role: 'org_admin', organizationId: 7 });
    const crossOrgTarget = makeUser({ id: 100, role: 'user', organizationId: 999 });
    renderTable({ users: [crossOrgTarget], currentUser: orgAdmin });
    expect(screen.queryByTestId(`button-reset-password-${crossOrgTarget.id}`)).toBeNull();
  });

  it('shows the button alongside Resend Invite for a still-pending invitee', () => {
    const pending = makeUser({
      id: 100,
      role: 'user',
      invitation: {
        id: 7,
        action: 'account_invite',
        status: 'pending',
        deliveryStatus: 'failed',
        expiresAt: '2026-01-08T00:00:00Z',
        deliveryAttemptedAt: '2026-01-01T00:00:00Z',
        deliveredAt: null,
        expiredAt: null,
        createdAt: '2026-01-01T00:00:00Z',
      },
    });
    renderTable({ users: [pending] });
    expect(screen.getByTestId(`button-reset-password-${pending.id}`)).toBeInTheDocument();
    expect(screen.getByTitle(/resend invite email/i)).toBeInTheDocument();
  });
});
