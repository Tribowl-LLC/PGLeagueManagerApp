/**
 * Regression test for the Weekly Payments page back-link wiring.
 *
 * `PaymentHistoryTable` exposes a `bowlerHrefSuffix` prop so callers
 * can append context (e.g. `?from=weekly-payments&fromLeagueId=N`) to
 * the bowler links it renders. The `WeeklyPaymentsPage` is the only
 * caller that needs the suffix today; this test pins the table's
 * behavior so a future caller change cannot silently regress the
 * Weekly Payments → Bowler back-link path.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaymentHistoryTable } from '@/components/payment-history-table';
import type { Payment } from '@shared/schema';

const PAYMENTS: Payment[] = [
  {
    id: 1,
    bowlerId: 42,
    leagueId: 7,
    type: 'cash',
    amount: 2500,
    date: '2026-04-28',
    checkNumber: null,
    createdById: null,
    organizationId: 1,
    metadata: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any,
];

const BOWLERS = [{ id: 42, name: 'Jane Doe', email: 'jane@example.com' }];

describe('PaymentHistoryTable bowler link', () => {
  it('appends bowlerHrefSuffix to the bowler link when provided', () => {
    render(
      <PaymentHistoryTable
        payments={PAYMENTS}
        bowlers={BOWLERS}
        onStartEdit={() => {}}
        onDelete={() => {}}
        isDeletePending={false}
        bowlerHrefSuffix="?from=weekly-payments&fromLeagueId=99"
      />,
    );

    const link = screen.getByRole('link', { name: /jane doe/i });
    expect(link).toHaveAttribute('href', '/bowlers/42?from=weekly-payments&fromLeagueId=99');
  });

  it('renders a plain bowler link when no suffix is provided', () => {
    render(
      <PaymentHistoryTable
        payments={PAYMENTS}
        bowlers={BOWLERS}
        onStartEdit={() => {}}
        onDelete={() => {}}
        isDeletePending={false}
      />,
    );

    const link = screen.getByRole('link', { name: /jane doe/i });
    expect(link).toHaveAttribute('href', '/bowlers/42');
  });

  it('hides every payment mutation affordance for a read-only archive', () => {
    render(
      <PaymentHistoryTable
        payments={PAYMENTS}
        bowlers={BOWLERS}
        onStartEdit={() => {}}
        onDelete={() => {}}
        isDeletePending={false}
        isAdmin
        readOnly
      />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
