/**
 * Component test for SquareSection's deep-link highlight behavior
 * (task #584).
 *
 * Background: the integrations page can be deep-linked with a
 * `?location=<id>` query param so an admin lands directly on the
 * payment card they need to fix. SquareSection forwards that id as
 * `highlightLocationId`; the matching PaymentLocationCard then
 * (a) scrolls itself into view and (b) flashes a temporary ring that
 * auto-fades after 2.5s so the page settles once attention is captured.
 *
 * This is the one effect in square-integration-section.tsx that is a
 * legitimate DOM side-effect (imperative scrollIntoView + a timed
 * highlight), so it can't be reduced to a render-time computation. The
 * behaviors pinned here:
 *   1. Only the highlighted card scrolls into view (exactly once) and
 *      gets the ring + data-highlighted attribute; siblings do not.
 *   2. The ring auto-fades after 2.5s while the card stays mounted.
 *
 * jsdom stubs scrollIntoView to a no-op in component-test-setup.ts, so
 * we spy on the prototype method. Fake timers (scoped to the wall-clock
 * primitives the effect touches) let us assert the 2.5s fade
 * deterministically; the `flush` helper mirrors the sibling
 * profile-info-card tests so react-query's promise chain settles under
 * fake timers.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SquareSection } from '@/components/square-integration-section';

const ORG_ID = 1;

// Plain object literals (not annotated as `Location`) — they are
// serialized through `jsonResponse(body: unknown)` exactly as the API
// would, so the component only ever sees parsed JSON. This mirrors the
// sibling integrations-page-deep-link test and avoids laundering a
// partial fixture past the type checker with a double cast.
const LOCATIONS = [
  { id: 1, organizationId: ORG_ID, name: 'Lanes A', active: true },
  { id: 2, organizationId: ORG_ID, name: 'Lanes B', active: true },
];

const ORIGINAL_FETCH = global.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchMock() {
  global.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes(`/api/locations?organizationId=${ORG_ID}`)) {
      return jsonResponse({ success: true, data: LOCATIONS });
    }
    if (url.includes('/square-config')) {
      return jsonResponse({
        success: true,
        data: { appId: null, accessTokenConfigured: false, locationId: null },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function setup(highlightLocationId: number | null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SquareSection orgId={1} highlightLocationId={highlightLocationId} />
    </QueryClientProvider>,
  );
}

/**
 * Drain microtasks + zero-delay timers so the next assertion observes
 * the post-query, post-effect DOM. Same pattern as the sibling
 * profile-info-card tests — `waitFor` can't be used under fake timers.
 */
async function flush(): Promise<void> {
  let lastHtml = document.body.innerHTML;
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const nextHtml = document.body.innerHTML;
    if (nextHtml === lastHtml && document.body.querySelector('[data-testid^="payment-location-card-"]')) {
      return;
    }
    lastHtml = nextHtml;
  }
}

let scrollSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  installFetchMock();
  scrollSpy = vi.spyOn(window.HTMLElement.prototype, 'scrollIntoView');
});

afterEach(() => {
  scrollSpy.mockRestore();
  vi.useRealTimers();
  global.fetch = ORIGINAL_FETCH;
});

describe('SquareSection deep-link highlight (#584)', () => {
  it('scrolls the highlighted card into view exactly once and rings it; siblings are untouched', async () => {
    setup(2);
    await flush();

    const card1 = screen.getByTestId('payment-location-card-1');
    const card2 = screen.getByTestId('payment-location-card-2');

    // Only the matching card is flagged + ringed.
    expect(card2).toHaveAttribute('data-highlighted', 'true');
    expect(card2.className).toContain('ring-2');
    expect(card1).not.toHaveAttribute('data-highlighted');
    expect(card1.className).not.toContain('ring-2');

    // Exactly one scrollIntoView — the highlighted card only.
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it('fades the highlight ring after 2.5s while keeping the card mounted', async () => {
    setup(2);
    await flush();

    const card2 = screen.getByTestId('payment-location-card-2');
    expect(card2.className).toContain('ring-2');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    const stillThere = screen.getByTestId('payment-location-card-2');
    expect(stillThere).toBeInTheDocument();
    expect(stillThere.className).not.toContain('ring-2');
  });

  it('does not scroll or ring any card when no highlight id is provided', async () => {
    setup(null);
    await flush();

    const card1 = screen.getByTestId('payment-location-card-1');
    const card2 = screen.getByTestId('payment-location-card-2');

    expect(card1.className).not.toContain('ring-2');
    expect(card2.className).not.toContain('ring-2');
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
