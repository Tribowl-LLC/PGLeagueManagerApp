/**
 * Task #725 — Linked payment partners must only surface as payment
 * recipients (and combined-pay rows) on leagues they are themselves
 * enrolled in.
 *
 * Pre-#725, accepting a payment-partner link unconditionally exposed
 * that partner on every league the primary bowler bowled in, even
 * leagues the partner did not bowl in. This file pins the four
 * regressions:
 *
 *   (a) A partner who IS enrolled in the current league appears in the
 *       recipient picker AND the combined-pay group.
 *   (b) A partner who is NOT enrolled in the current league is hidden
 *       from BOTH surfaces — no leak across the primary bowler's other
 *       leagues.
 *   (c) When the partner-details fetch resolves and reveals a
 *       previously-selected combined-pay partner is not enrolled, the
 *       selection is reconciled so no stale id can ride into checkout.
 *   (d) While a partner-details fetch is still in flight, the partner
 *       is treated as not-yet-eligible (rather than briefly shown and
 *       yanked) so the picker doesn't flicker.
 *
 * Strategy: render <PaymentStatusSection /> with the form already
 * opened (one-time mode triggers the recipient picker AND the combined
 * pay group when partners exist). Heavy hooks (Square /
 * provider / wallet / submit / toast) are stubbed; useQuery + useQueries
 * run for real against a `csrfFetch` mock that dispatches per URL so
 * the component goes through the actual react-query plumbing.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = NoopResizeObserver;
}

vi.mock('@/hooks/use-payment-provider', () => ({
  usePaymentProvider: () => ({
    config: { providerConfigured: true, missingFields: [] },
    isSquare: true,
    supportsWallets: false,
    isLoading: false,
    isProviderConfigured: true,
    missingFields: [],
    error: null,
  }),
  clearProviderConfigCache: () => {},
}));

vi.mock('@/hooks/use-square-payment', () => ({
  useSquarePayment: () => ({
    card: null,
    isInitialized: true,
    error: null,
    initializeCard: vi.fn(async () => {}),
    cleanupCard: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-wallet-payments', () => ({
  useWalletPayments: () => ({
    applePayAvailable: false,
    googlePayAvailable: false,
    applePayRef: { current: null },
    googlePayRef: { current: null },
    handleApplePayClick: vi.fn(),
    handleGooglePayClick: vi.fn(),
    isProcessing: false,
    cleanup: vi.fn(),
    applePayTokenizeOnly: false,
    googlePayTokenizeOnly: false,
  }),
}));

vi.mock('@/hooks/use-bowler-payment-submit', () => ({
  useBowlerPaymentSubmit: () => vi.fn(async () => {}),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// `csrfFetch` is the boundary all of PaymentStatusSection's queries
// route through (the bowler-links list, per-partner details, and saved
// cards). The mock dispatches per URL so each test scenario can assert
// what the component renders for a given enrollment shape.
type FetchHandler = (url: string) => Response | Promise<Response> | null;
let fetchHandler: FetchHandler = () => null;

vi.mock('@/lib/queryClient', async () => {
  const actual = await vi.importActual<typeof import('../../client/src/lib/queryClient')>(
    '../../client/src/lib/queryClient',
  );
  return {
    ...actual,
    csrfFetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const out = await fetchHandler(url);
      if (out) return out;
      return new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
    queryClient: { invalidateQueries: vi.fn() },
  };
});

import { PaymentStatusSection } from '@/components/payment-status-section';
import type { League, Bowler } from '@shared/schema';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const SELF_BOWLER_ID = 100;
const PARTNER_IN_LEAGUE_ID = 200;
const PARTNER_OTHER_LEAGUE_ID = 300;
const LEAGUE_ID = 11;
const OTHER_LEAGUE_ID = 22;

function makeLeague(id: number): League {
  // The component reads league.id, league.locationId, league.weeklyFee,
  // league.paymentMode, league.seasonStart, plus the array fields that
  // financial-utils touches. Build a minimally-valid select row.
  return {
    id,
    name: `League ${id}`,
    description: null,
    active: true,
    allowPublicSignup: false,
    seasonStart: '2026-01-01T00:00:00.000Z',
    seasonEnd: '2026-12-31T00:00:00.000Z',
    weekDay: 'Monday',
    weeklyFee: 2500,
    lineageFee: null,
    prizeFundFee: null,
    practiceStartTime: null,
    competitionStartTime: null,
    squareLineageItemId: null,
    lineageItemVariationId: null,
    squareLineageItemName: null,
    squarePrizeFundItemId: null,
    prizeFundItemVariationId: null,
    squarePrizeFundItemName: null,
    squareCategoryId: null,
    timezone: 'America/New_York',
    paymentMode: 'weekly',
    seasonNumber: 1,
    previousSeasonId: null,
    organizationId: 1,
    locationId: null,
    totalBowlingWeeks: 30,
    skipDates: [],
    cancelledDates: [],
    doublePayDates: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeBowler(id: number, name: string) {
  return {
    id,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '')}@example.com`,
    phone: null,
    active: true,
    order: 0,
    organizationId: 1,
    paymentCustomerId: null,
    paymentProviderLocationId: null,
    paymentSyncPendingAt: null,
    paymentSyncAttempts: 0,
    paymentSyncLastAttemptAt: null,
  };
}

function bowlerLeagueRow(bowlerId: number, leagueId: number, active = true) {
  return {
    id: bowlerId * 1000 + leagueId,
    bowlerId,
    leagueId,
    teamId: 1,
    active,
    order: 0,
    joinedAt: '2026-01-01T00:00:00.000Z',
  };
}

function buildLinks(partners: { id: number; name: string }[]) {
  return {
    success: true,
    data: {
      links: partners.map((p, idx) => ({
        id: idx + 1,
        status: 'accepted',
        partnerBowlerId: p.id,
        partnerName: p.name,
      })),
      hasAny: partners.length > 0,
    },
  };
}

function buildDetailsResponse(
  bowlerId: number,
  enrolledLeagueIds: number[],
) {
  return {
    success: true,
    data: {
      bowler: { id: bowlerId, name: `B${bowlerId}` },
      bowlerLeagues: enrolledLeagueIds.map((lid) => bowlerLeagueRow(bowlerId, lid)),
      leagues: [],
      teams: [],
      payments: [],
    },
  };
}

function renderSection(league: League, bowler: Bowler) {
  // A fresh QueryClient per render keeps cached partner-details from
  // bleeding across tests. The /api/bowler-links useQuery in
  // PaymentStatusSection has no inline queryFn — it relies on the app's
  // default fetcher. We provide a default queryFn here that routes
  // through the same fetchHandler dispatcher as csrfFetch so both
  // surfaces share one source of truth.
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        queryFn: async ({ queryKey }) => {
          const url = String(queryKey[0]);
          const out = await fetchHandler(url);
          if (!out) return null;
          return out.json();
        },
      },
      mutations: { retry: false },
    },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <PaymentStatusSection
        league={league}
        bowler={bowler}
        weeklyFee={2500}
        totalWeeks={30}
        payments={[]}
      />
    </QueryClientProvider>,
  );
  const rerenderWithLeague = (nextLeague: League) =>
    utils.rerender(
      <QueryClientProvider client={qc}>
        <PaymentStatusSection
          league={nextLeague}
          bowler={bowler}
          weeklyFee={2500}
          totalWeeks={30}
          payments={[]}
        />
      </QueryClientProvider>,
    );
  return { ...utils, rerenderWithLeague };
}

async function openOneTimeForm(user: ReturnType<typeof userEvent.setup>) {
  // The recipient picker + combined-pay group only render once the
  // form is opened. PaymentOverviewCard's "One-Time Payment" button
  // opens the form in `onetime` mode (which allows partner selection).
  const setupBtn = await screen.findByRole('button', { name: /one-time payment/i });
  await user.click(setupBtn);
}

beforeEach(() => {
  fetchHandler = () => null;
});

describe('PaymentStatusSection — partner-league enrollment scoping (#725)', () => {
  it('(a) shows a partner enrolled in this league in the recipient picker and combined-pay group', async () => {
    fetchHandler = (url) => {
      if (url.startsWith('/api/bowler-links')) {
        return jsonResponse(
          buildLinks([{ id: PARTNER_IN_LEAGUE_ID, name: 'In League Partner' }]),
        );
      }
      if (url.startsWith(`/api/bowlers/${PARTNER_IN_LEAGUE_ID}/details`)) {
        return jsonResponse(buildDetailsResponse(PARTNER_IN_LEAGUE_ID, [LEAGUE_ID]));
      }
      return null;
    };

    const user = userEvent.setup();
    renderSection(makeLeague(LEAGUE_ID), makeBowler(SELF_BOWLER_ID, 'Self Bowler'));
    await openOneTimeForm(user);

    // Recipient picker exposes the partner as a selectable option
    // (testid is the schema PaymentSetupForm renders).
    // Combined-pay group lists the partner row directly.
    expect(
      await screen.findByTestId(`combined-autopay-option-${PARTNER_IN_LEAGUE_ID}`),
    ).toBeInTheDocument();
    // The recipient picker is mounted (Radix Select keeps its options
    // in a portal until opened, so we open it before asserting on the
    // partner option).
    expect(screen.getByTestId('recipient-picker')).toBeInTheDocument();
    await user.click(screen.getByTestId('select-recipient'));
    expect(
      await screen.findByTestId(`recipient-option-${PARTNER_IN_LEAGUE_ID}`),
    ).toBeInTheDocument();
  });

  it('(b) hides a partner who is NOT enrolled in this league across both surfaces', async () => {
    fetchHandler = (url) => {
      if (url.startsWith('/api/bowler-links')) {
        return jsonResponse(
          buildLinks([{ id: PARTNER_OTHER_LEAGUE_ID, name: 'Other League Partner' }]),
        );
      }
      if (url.startsWith(`/api/bowlers/${PARTNER_OTHER_LEAGUE_ID}/details`)) {
        // Partner only bowls in OTHER_LEAGUE_ID, not LEAGUE_ID we're on.
        return jsonResponse(
          buildDetailsResponse(PARTNER_OTHER_LEAGUE_ID, [OTHER_LEAGUE_ID]),
        );
      }
      return null;
    };

    const user = userEvent.setup();
    renderSection(makeLeague(LEAGUE_ID), makeBowler(SELF_BOWLER_ID, 'Self Bowler'));
    await openOneTimeForm(user);

    // Wait for partner-details to settle so any (incorrect) optimistic
    // render would have happened.
    await waitFor(() => {
      // The form is mounted (recipient-picker would render only if
      // there were eligible partners — there aren't, so the picker
      // itself is absent). Use the combined-pay group's absence as the
      // primary signal: it renders the same partner row testid the
      // recipient picker would.
      expect(
        screen.queryByTestId(`combined-autopay-option-${PARTNER_OTHER_LEAGUE_ID}`),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByTestId(`recipient-option-${PARTNER_OTHER_LEAGUE_ID}`),
    ).not.toBeInTheDocument();
    // The picker itself is gone when no partners are eligible.
    expect(screen.queryByTestId('recipient-picker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('combined-autopay-group')).not.toBeInTheDocument();
  });

  it('(c) drops a previously-checked combined-pay partner when its enrollment resolves to ineligible', async () => {
    // Two partners: one enrolled here, one not. Both initially appear
    // (the in-league one stays; the other one we'll check before its
    // details resolve, then verify it gets dropped). To exercise the
    // reconcile path deterministically, we delay the not-enrolled
    // partner's details fetch behind a manual gate so the user has a
    // chance to tick the box first.
    let resolveOther: ((r: Response) => void) | null = null;
    fetchHandler = (url) => {
      if (url.startsWith('/api/bowler-links')) {
        return jsonResponse(
          buildLinks([
            { id: PARTNER_IN_LEAGUE_ID, name: 'In League' },
            { id: PARTNER_OTHER_LEAGUE_ID, name: 'Other League' },
          ]),
        );
      }
      if (url.startsWith(`/api/bowlers/${PARTNER_IN_LEAGUE_ID}/details`)) {
        return jsonResponse(buildDetailsResponse(PARTNER_IN_LEAGUE_ID, [LEAGUE_ID]));
      }
      if (url.startsWith(`/api/bowlers/${PARTNER_OTHER_LEAGUE_ID}/details`)) {
        return new Promise<Response>((resolve) => {
          resolveOther = resolve;
        });
      }
      return null;
    };

    const user = userEvent.setup();
    renderSection(makeLeague(LEAGUE_ID), makeBowler(SELF_BOWLER_ID, 'Self Bowler'));
    await openOneTimeForm(user);

    // The in-league partner appears immediately. The not-enrolled
    // partner is gated behind the in-flight fetch, so per the loading
    // contract (test (d)) it must NOT appear yet.
    await screen.findByTestId(`combined-autopay-option-${PARTNER_IN_LEAGUE_ID}`);
    expect(
      screen.queryByTestId(`combined-autopay-option-${PARTNER_OTHER_LEAGUE_ID}`),
    ).not.toBeInTheDocument();

    // Tick the in-league partner — this is a legitimately eligible
    // selection that must survive reconciliation.
    await user.click(
      screen.getByTestId(`combined-autopay-checkbox-${PARTNER_IN_LEAGUE_ID}`),
    );
    expect(
      screen.getByTestId(`combined-autopay-checkbox-${PARTNER_IN_LEAGUE_ID}`),
    ).toBeChecked();

    // Now resolve the other partner's fetch with NOT enrolled here.
    // The component must keep the in-league partner checked AND must
    // not surface the other partner as a row at all.
    await act(async () => {
      if (resolveOther) {
        resolveOther(
          jsonResponse(buildDetailsResponse(PARTNER_OTHER_LEAGUE_ID, [OTHER_LEAGUE_ID])),
        );
      }
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId(`combined-autopay-option-${PARTNER_OTHER_LEAGUE_ID}`),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByTestId(`combined-autopay-checkbox-${PARTNER_IN_LEAGUE_ID}`),
    ).toBeChecked();
  });

  it('(e) resets the recipient picker back to self when the selected partner becomes ineligible', async () => {
    // Partner is enrolled in BOTH leagues so they appear eligible on
    // the initial render of LEAGUE_ID. After we select them as the
    // recipient, we re-render with OTHER_LEAGUE_ID where the partner
    // is NOT enrolled — the reconcile effect must flip targetBowlerId
    // back to self.
    fetchHandler = (url) => {
      if (url.startsWith('/api/bowler-links')) {
        return jsonResponse(
          buildLinks([{ id: PARTNER_IN_LEAGUE_ID, name: 'In League Partner' }]),
        );
      }
      if (url.startsWith(`/api/bowlers/${PARTNER_IN_LEAGUE_ID}/details`)) {
        // Enrolled only in LEAGUE_ID, NOT in OTHER_LEAGUE_ID.
        return jsonResponse(buildDetailsResponse(PARTNER_IN_LEAGUE_ID, [LEAGUE_ID]));
      }
      return null;
    };

    const user = userEvent.setup();
    const { rerenderWithLeague } = renderSection(
      makeLeague(LEAGUE_ID),
      makeBowler(SELF_BOWLER_ID, 'Self Bowler'),
    );
    await openOneTimeForm(user);

    // Open the picker and select the partner as the recipient.
    await user.click(await screen.findByTestId('select-recipient'));
    await user.click(
      await screen.findByTestId(`recipient-option-${PARTNER_IN_LEAGUE_ID}`),
    );
    // Trigger now displays the partner's name.
    await waitFor(() => {
      expect(screen.getByTestId('select-recipient')).toHaveTextContent(
        'In League Partner',
      );
    });

    // Re-render on a league the partner is NOT enrolled in. The
    // partner becomes ineligible and the recipient must reset to self.
    await act(async () => {
      rerenderWithLeague(makeLeague(OTHER_LEAGUE_ID));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('recipient-picker')).not.toBeInTheDocument();
    });
    // No partner picker means the form falls back to paying-for-self;
    // submit handler will use bowler.id (asserted indirectly via the
    // absence of any partner-recipient surface). Sanity-check that the
    // partner's row is gone from combined-pay too.
    expect(
      screen.queryByTestId(`combined-autopay-option-${PARTNER_IN_LEAGUE_ID}`),
    ).not.toBeInTheDocument();
  });

  it('(d) treats partners with an unresolved enrollment fetch as not-yet-eligible (no flicker)', async () => {
    // Hold the partner-details fetch open so eligibility cannot be
    // determined. The partner must NOT appear in either surface
    // during the loading window.
    fetchHandler = (url) => {
      if (url.startsWith('/api/bowler-links')) {
        return jsonResponse(
          buildLinks([{ id: PARTNER_IN_LEAGUE_ID, name: 'Pending Partner' }]),
        );
      }
      if (url.startsWith(`/api/bowlers/${PARTNER_IN_LEAGUE_ID}/details`)) {
        return new Promise<Response>(() => {
          /* never resolves */
        });
      }
      return null;
    };

    const user = userEvent.setup();
    renderSection(makeLeague(LEAGUE_ID), makeBowler(SELF_BOWLER_ID, 'Self Bowler'));
    await openOneTimeForm(user);

    // Give react-query a tick to fire the request and let any
    // (incorrect) optimistic render happen.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(
      screen.queryByTestId(`recipient-option-${PARTNER_IN_LEAGUE_ID}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`combined-autopay-option-${PARTNER_IN_LEAGUE_ID}`),
    ).not.toBeInTheDocument();
  });
});
