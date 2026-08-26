import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LeagueSchedulePreview } from '@/components/league-schedule-preview';

describe('LeagueSchedulePreview accessibility state', () => {
  it('exposes expanded, date, and independent double-pay state semantics', () => {
    const setShowSchedule = vi.fn();
    const toggleDateType = vi.fn();
    const toggleDoublePayDate = vi.fn();
    const props = {
      scheduleDates: [{
        date: new Date('2026-09-07T00:00:00.000Z'),
        isoDate: '2026-09-07',
        type: 'normal' as const,
        bowlingWeekNumber: 1,
      }],
      showSchedule: false,
      setShowSchedule,
      bowlingWeeks: 1,
      skipDates: [],
      cancelledDates: [],
      doublePayDates: ['2026-09-07'],
      effectiveBowlingWeeks: 1,
      computedSeasonEnd: null,
      toggleDateType,
      toggleDoublePayDate,
      allowCancelled: false,
      allowDoublePay: true,
    };

    const view = render(<LeagueSchedulePreview {...props} />);
    const header = screen.getByRole('button', { name: /bowling schedule/i });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header).toHaveAttribute('aria-controls', 'league-schedule-preview');

    view.rerender(<LeagueSchedulePreview {...props} showSchedule />);
    const date = screen.getByTestId('schedule-week-2026-09-07');
    const doublePay = screen.getByTestId('schedule-double-pay-2026-09-07');
    expect(date).toHaveAttribute('aria-pressed', 'false');
    expect(date).toHaveAccessibleName(/September 7, 2026: Bowling/);
    expect(doublePay).toHaveAttribute('aria-pressed', 'true');
    expect(doublePay).toHaveAccessibleName(/Remove double pay for September 7, 2026/);
  });
});
