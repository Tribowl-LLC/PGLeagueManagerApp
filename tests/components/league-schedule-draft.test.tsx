import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useLeagueScheduleDraft } from '@/hooks/use-league-schedule-draft';

function Harness() {
  const draft = useLeagueScheduleDraft({
    initialSeasonStart: '2026-09-07',
    initialBowlingWeeks: 2,
    initialWeekDay: 'Monday',
    initialPaymentMode: 'weekly',
  });
  const first = draft.scheduleDates[0];
  return (
    <>
      <button type="button" onClick={() => draft.toggleDoublePayDate('2026-09-07')}>double</button>
      <button type="button" onClick={() => first && draft.toggleDateType(first.isoDate, first.type)}>base</button>
      <button type="button" onClick={() => draft.setPaymentMode('upfront')}>upfront</button>
      <output data-testid="draft-state">{JSON.stringify({ skip: draft.skipDates, double: draft.doublePayDates })}</output>
    </>
  );
}

describe('shared league schedule draft contract', () => {
  it('keeps Bowling/No Bowling and double-pay transitions atomic and clears upfront doubles', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'double' }));
    expect(screen.getByTestId('draft-state')).toHaveTextContent('"double":["2026-09-07"]');
    await user.click(screen.getByRole('button', { name: 'base' }));
    expect(screen.getByTestId('draft-state')).toHaveTextContent('"skip":["2026-09-07"]');
    expect(screen.getByTestId('draft-state')).toHaveTextContent('"double":[]');
    await user.click(screen.getByRole('button', { name: 'upfront' }));
    expect(screen.getByTestId('draft-state')).toHaveTextContent('"double":[]');
  });
});
