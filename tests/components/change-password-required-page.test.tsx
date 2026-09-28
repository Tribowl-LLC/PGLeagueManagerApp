/**
 * Component test for the forced-rotation page (task #455).
 *
 * Pins the three behaviours the manual smoke test can't catch:
 *   1. The page mounts with the change-password form already
 *      expanded — there is no "Change Password" toggle button to
 *      click first. A user who landed here after an admin reset
 *      can fill the form immediately.
 *   2. There is no "Cancel" button to dismiss the form. The whole
 *      point of the page is that the user can't bypass the
 *      rotation, so giving them a way to collapse the form back
 *      into nothing would be a footgun.
 *   3. On a successful submit, the page invalidates the
 *      `/api/user` query (refreshes the route guard's view of
 *      `mustChangePassword`), and the form stays mounted instead
 *      of collapsing back into a toggle that can't exist on this
 *      page anyway.
 *
 * `apiRequest` is mocked at the module boundary so the test
 * deterministically choreographs the success path without a real
 * fetch.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/hooks/use-business-context', () => ({ useBusinessContext: () => ({ business: null }) }));

vi.mock('@/lib/queryClient', async () => {
  const actual = await vi.importActual<typeof import('../../client/src/lib/queryClient')>(
    '../../client/src/lib/queryClient',
  );
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, queryClient as realQueryClient } from '@/lib/queryClient';
import ChangePasswordRequiredPage from '@/pages/change-password-required-page';

const mockedApiRequest = vi.mocked(apiRequest);

function renderPage() {
  // Use a fresh QueryClient per test so the invalidate-on-success
  // assertion doesn't bleed across tests, and so retries are off
  // (we want errors to surface immediately).
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <ChangePasswordRequiredPage />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  mockedApiRequest.mockReset();
  // Default: every successful submit returns a generic { success: true }.
  mockedApiRequest.mockResolvedValue({ success: true } as never);
});

describe('ChangePasswordRequiredPage (task #455)', () => {
  it('mounts the page wrapper and the change-password form already expanded — no toggle button', async () => {
    renderPage();

    // The page wrapper renders so the route guard knows the user
    // landed here (vs. e.g. a stuck loading state).
    expect(screen.getByTestId('page-change-password-required')).toBeInTheDocument();

    // The form is open from first paint. The "Update Password"
    // submit button is the form's tell.
    expect(
      await screen.findByTestId('button-change-password-submit'),
    ).toBeInTheDocument();

    // The toggle button that the non-forced card uses must NOT be
    // rendered — otherwise an admin-reset user would have to click
    // a button to start the form they were already pinned to.
    expect(
      screen.queryByTestId('button-change-password-toggle'),
    ).not.toBeInTheDocument();
  });

  it('does NOT render the Cancel button (the user cannot bypass the rotation)', async () => {
    renderPage();
    await screen.findByTestId('button-change-password-submit');

    // No Cancel — the form has nowhere to collapse back to. This
    // is the visible UX guarantee of the `forced` prop.
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
  });

  it('lets the bowler reveal and hide a password without clearing it', async () => {
    const user = userEvent.setup();
    renderPage();

    const currentPassword = await screen.findByLabelText(/^current password$/i);
    await user.type(currentPassword, 'AdminSetPw1!');
    await user.click(screen.getByRole('button', { name: 'Show current password' }));
    expect(currentPassword).toHaveAttribute('type', 'text');
    expect(currentPassword).toHaveValue('AdminSetPw1!');

    await user.click(screen.getByRole('button', { name: 'Hide current password' }));
    expect(currentPassword).toHaveAttribute('type', 'password');
    expect(currentPassword).toHaveValue('AdminSetPw1!');
  });

  it('shows the explanatory copy so the user understands why they are here', () => {
    renderPage();

    // Headline tells them WHAT to do.
    expect(screen.getByRole('heading', { name: /choose a new password/i })).toBeInTheDocument();
    // Body tells them WHY (and which password is the "current" one).
    expect(screen.getByText(/administrator reset your password/i)).toBeInTheDocument();
    expect(
      screen.getByText(/temporary password as your current password/i),
    ).toBeInTheDocument();
  });

  it('submits the form, invalidates /api/user on success, and keeps the form mounted', async () => {
    const user = userEvent.setup();
    const { qc } = renderPage();

    // Spy on invalidate so we can assert the refetch trigger that
    // releases the route guard. We attach AFTER render so we don't
    // catch any unrelated startup invalidations.
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    // The card uses the SHARED queryClient (re-exported from
    // @/lib/queryClient), not the per-test client passed via
    // QueryClientProvider. Spy on that one too so the assertion is
    // robust to the implementation detail.
    const sharedInvalidateSpy = vi.spyOn(realQueryClient, 'invalidateQueries');

    const currentPw = await screen.findByLabelText(/^current password$/i);
    const newPw = await screen.findByLabelText(/^new password$/i);
    const confirmPw = await screen.findByLabelText(/^confirm new password$/i);
    await user.type(currentPw, 'AdminSetPw1!');
    await user.type(newPw, 'BrandNewPw1!');
    await user.type(confirmPw, 'BrandNewPw1!');
    await user.click(screen.getByTestId('button-change-password-submit'));

    // The mutation hits the right endpoint with the right payload.
    await waitFor(() => expect(mockedApiRequest).toHaveBeenCalledTimes(1));
    expect(mockedApiRequest).toHaveBeenCalledWith(
      '/api/account/change-password',
      'POST',
      { currentPassword: 'AdminSetPw1!', newPassword: 'BrandNewPw1!' },
    );

    // /api/user gets invalidated so the route guard's
    // mustChangePassword view refreshes and the user stops being
    // pinned to this page.
    await waitFor(() => {
      const invalidated = [
        ...invalidateSpy.mock.calls,
        ...sharedInvalidateSpy.mock.calls,
      ].some(
        ([arg]) =>
          arg &&
          typeof arg === 'object' &&
          'queryKey' in (arg as Record<string, unknown>) &&
          Array.isArray((arg as { queryKey: unknown }).queryKey) &&
          ((arg as { queryKey: unknown[] }).queryKey[0] === '/api/user'),
      );
      expect(invalidated).toBe(true);
    });

    // The form must NOT collapse back to the toggle on the forced
    // page (which has no toggle to collapse to). The submit button
    // should still be in the DOM after success.
    expect(screen.getByTestId('button-change-password-submit')).toBeInTheDocument();
    expect(
      screen.queryByTestId('button-change-password-toggle'),
    ).not.toBeInTheDocument();
  });
});
