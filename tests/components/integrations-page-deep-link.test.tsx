/**
 * Component test for the `?location=<id>` deep link on the Integrations
 * page (task #584).
 *
 * Background: tasks #582 / #583 added an "Open Settings" action on the
 * checkout's not-configured alert / toast that navigates to
 * `/integrations?location=<id>`. Before #584 the page ignored the param,
 * so admins still had to find the right location card by hand.
 *
 * This test pins the closed loop:
 *   1. With a valid `?location=<id>`, the matching PaymentLocationCard
 *      is scrolled into view and visually highlighted (data attribute
 *      + ring class) once the locations API responds.
 *   2. With an invalid / non-numeric `?location=...`, the page renders
 *      cleanly with no scroll, no highlight, and no thrown error — the
 *      task spec explicitly calls out this graceful-degradation case.
 *   3. For a system admin, the location lookup auto-selects the org
 *      that owns the location so the right card is even rendered to
 *      begin with.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Several Radix primitives reach for ResizeObserver via `react-use-size`
// — jsdom doesn't ship one, so polyfill a no-op before any component
// code runs (mirrors the other component tests in this folder).
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = NoopResizeObserver;
}

// Strip the heavy chrome — Layout pulls in the full app sidebar, theme
// provider, etc. We only care about what IntegrationsPage itself renders.
vi.mock('@/components/layout', () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Drive the wouter `useSearch()` hook from the test so each case can
// pick its own query string.
let currentSearch = '';
vi.mock('wouter', async () => {
  const actual = await vi.importActual<typeof import('wouter')>('wouter');
  return {
    ...actual,
    useSearch: () => currentSearch,
  };
});

const { scrollIntoViewSpy } = vi.hoisted(() => ({
  scrollIntoViewSpy: vi.fn(),
}));

import IntegrationsPage from '@/pages/integrations-page';

const ORG_ID = 9;
const HIGHLIGHT_LOCATION_ID = 42;

const LOCATIONS = [
  {
    id: 11,
    organizationId: ORG_ID,
    name: 'Lakeside Lanes',
    active: true,
    paymentProvider: 'square',
  },
  {
    id: HIGHLIGHT_LOCATION_ID,
    organizationId: ORG_ID,
    name: 'Northside Bowl',
    active: true,
    paymentProvider: 'square',
  },
  {
    id: 99,
    organizationId: ORG_ID,
    name: 'Westside Strikes',
    active: true,
    paymentProvider: 'clover',
  },
];

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_SCROLL_INTO_VIEW =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.HTMLElement.prototype as any).scrollIntoView;

function installFetch(opts: { locationLookupStatus?: number } = {}) {
  const { locationLookupStatus = 200 } = opts;

  global.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.endsWith('/api/user')) {
      return jsonResponse({
        success: true,
        data: { id: 1, role: 'org_admin', organizationId: ORG_ID },
      });
    }

    if (url.startsWith(`/api/locations?organizationId=${ORG_ID}`)) {
      return jsonResponse({ success: true, data: LOCATIONS });
    }

    // Single-location lookup driven by the deep link. The page uses this
    // to (a) discover a location's org for system admins and (b) keep
    // working gracefully when the id is invalid / inaccessible.
    if (url.match(/\/api\/locations\/\d+$/)) {
      if (locationLookupStatus !== 200) {
        return jsonResponse(
          { success: false, error: { code: 'NOT_FOUND', message: 'no' } },
          locationLookupStatus,
        );
      }
      return jsonResponse({
        success: true,
        data: LOCATIONS.find((l) => l.id === HIGHLIGHT_LOCATION_ID),
      });
    }

    // Per-card config fetches — return "not configured" so the cards
    // render quickly without any further branching.
    if (url.match(/\/api\/locations\/\d+\/square-config$/)) {
      return jsonResponse({
        success: true,
        data: { appId: null, accessTokenConfigured: false, locationId: null },
      });
    }
    if (url.match(/\/api\/locations\/\d+\/clover-config$/)) {
      return jsonResponse({
        success: true,
        data: {
          merchantId: null,
          apiTokenConfigured: false,
          publicTokenizerKey: null,
          environment: null,
        },
      });
    }

    return jsonResponse({ success: true, data: null });
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Mirror the project's default queryFn (queryClient.ts) so
        // queries that rely on the cached fetcher — `/api/user`,
        // `/api/organizations` — work in this test without each one
        // having to declare its own queryFn.
        queryFn: async ({ queryKey }) => {
          const url = queryKey[0] as string;
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        },
      },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <IntegrationsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  scrollIntoViewSpy.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.HTMLElement.prototype as any).scrollIntoView = scrollIntoViewSpy;
  currentSearch = '';
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.HTMLElement.prototype as any).scrollIntoView = ORIGINAL_SCROLL_INTO_VIEW;
  vi.restoreAllMocks();
});

describe('<IntegrationsPage /> — `?location=<id>` deep link (#584)', () => {
  it('scrolls to and highlights the requested location card', async () => {
    currentSearch = `location=${HIGHLIGHT_LOCATION_ID}`;
    installFetch();

    renderPage();

    const targetCard = await screen.findByTestId(
      `payment-location-card-${HIGHLIGHT_LOCATION_ID}`,
    );

    // Highlight ring + data attribute land on the right card.
    await waitFor(() => {
      expect(targetCard).toHaveAttribute('data-highlighted', 'true');
    });
    expect(targetCard.className).toContain('ring-2');
    expect(targetCard.className).toContain('ring-primary');

    // scrollIntoView was called exactly once, and on the matching card
    // — not on the unrelated location cards on the page.
    await waitFor(() => {
      expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
    });
    const scrollCall = scrollIntoViewSpy.mock.instances[0];
    expect(scrollCall).toBe(targetCard);
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });

    // Sibling cards must NOT be flagged as highlighted — otherwise we'd
    // be lighting up every card and burying the actual target.
    const sibling = await screen.findByTestId('payment-location-card-11');
    expect(sibling).not.toHaveAttribute('data-highlighted');
    expect(sibling.className).not.toContain('ring-2');
  });

  it('renders cleanly with no scroll / no highlight when the location id is invalid', async () => {
    // Non-numeric param — the page must reject it, render every card
    // without a highlight, and never call scrollIntoView.
    currentSearch = 'location=not-a-number';
    installFetch();

    renderPage();

    await screen.findByTestId('payment-location-card-11');
    await screen.findByTestId(`payment-location-card-${HIGHLIGHT_LOCATION_ID}`);
    await screen.findByTestId('payment-location-card-99');

    // Give the component plenty of time to (incorrectly) trigger a
    // scroll if the guard regressed.
    await new Promise((r) => setTimeout(r, 50));

    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId(`payment-location-card-${HIGHLIGHT_LOCATION_ID}`),
    ).not.toHaveAttribute('data-highlighted');
  });

  it('still loads the page when the deep-linked location is inaccessible (404)', async () => {
    // Numeric but unknown / forbidden id: the lookup endpoint returns
    // 404, but the page must still render the locations the admin can
    // see and not blow up on the missing target.
    currentSearch = 'location=999999';
    installFetch({ locationLookupStatus: 404 });

    renderPage();

    await screen.findByTestId('payment-location-card-11');
    await screen.findByTestId(`payment-location-card-${HIGHLIGHT_LOCATION_ID}`);

    await new Promise((r) => setTimeout(r, 50));

    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    // None of the cards on the page match the requested id, so none
    // should be flagged as highlighted.
    expect(
      screen.queryByTestId('payment-location-card-11'),
    ).not.toHaveAttribute('data-highlighted');
  });
});
