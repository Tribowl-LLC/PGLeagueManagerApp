/**
 * End-to-end test for the `/integrations?location=<id>` deep link
 * (task #586).
 *
 * The component-level test (`tests/components/integrations-page-deep-link.test.tsx`,
 * task #584) runs in jsdom with a stubbed fetch and a mocked `useSearch`
 * — so it verifies the React component reacts correctly when the right
 * data is fed into it, but it does NOT exercise:
 *
 *   - the real wouter router parsing the URL,
 *   - the real `/api/locations/:id` endpoint (auth + org guard),
 *   - the real org auto-select for system_admins, or
 *   - a real browser layout / scroll.
 *
 * This file boots the actual dev server (the one already running in the
 * `Start application` workflow), drives a real Chromium via Playwright,
 * and asserts the full stack still wires the deep link end-to-end.
 *
 * The Replit sandbox ships a Chromium binary at
 * `REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE` — if that env var is missing
 * (e.g. running this suite outside Replit) the whole describe block is
 * skipped instead of failing, mirroring the opt-in pattern used by
 * `scripts/test-race.sh`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import {
  apiDelete,
  apiGet,
  apiPost,
  BASE_URL,
  login,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ORG_B_EMAIL,
  TEST_ORG_PASSWORD,
  type AuthSession,
} from '../helpers';

const CHROMIUM_PATH = process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
// The per-worker test app serves the prebuilt React bundle from
// `dist/public/` (server/app.ts → `serveStaticFrontend`). If
// `npm run build` hasn't run, the bundle is missing and Playwright
// would just time out waiting for the React-rendered <h1> — skip
// instead of producing a misleading red.
const HAS_FRONTEND_BUILD = existsSync(
  path.join(process.cwd(), 'dist', 'public', 'index.html'),
);
// express-session's default cookie name. Confirmed in `server/auth.ts` —
// no `name:` override is set on the session middleware.
const SESSION_COOKIE_NAME = 'connect.sid';

// Unique per-run tag so concurrent vitest runs against a shared dev DB
// don't fight over location names, and so the cleanup pass in afterAll
// only touches rows this run created.
const SUITE_TAG = `e2e-deep-link-${process.pid}-${Date.now()}`;

interface SeededLocation {
  id: number;
  organizationId: number;
  name: string;
}

interface OrgRow {
  id: number;
  slug: string;
}

let browser: Browser | null = null;
let adminSession: AuthSession;
let orgBSession: AuthSession;
let orgAId = 0;
let orgBId = 0;
const seededLocations: SeededLocation[] = [];
let highlightLocationId = 0;

function parseSessionCookie(cookieHeader: string): { name: string; value: string } | null {
  for (const part of cookieHeader.split(';').map((p) => p.trim())) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq);
    if (name === SESSION_COOKIE_NAME) {
      return { name, value: part.slice(eq + 1) };
    }
  }
  return null;
}

async function createLocation(orgId: number, name: string): Promise<SeededLocation> {
  const { status, data } = await apiPost<SeededLocation>(
    '/api/locations',
    {
      name,
      organizationId: orgId,
      active: true,
    },
    adminSession,
  );
  if (status !== 201 || !data.success || !data.data) {
    throw new Error(
      `Failed to create location ${name} in org ${orgId}: HTTP ${status} ${JSON.stringify(data)}`,
    );
  }
  return data.data;
}

async function newPageWithSession(session: AuthSession): Promise<BrowserContext> {
  if (!browser) throw new Error('browser not launched');
  const cookie = parseSessionCookie(session.cookies);
  if (!cookie) {
    throw new Error(
      `Could not extract a "${SESSION_COOKIE_NAME}" cookie from the test login session`,
    );
  }
  const url = new URL(BASE_URL);
  const isHttps = url.protocol === 'https:';
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addCookies([
    {
      name: cookie.name,
      value: cookie.value,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      // Mirror the dev-server cookie flags from `server/auth.ts`. On
      // Replit the dev server sets `Secure; SameSite=None` because the
      // cookie has to survive the HTTPS edge → HTTP loopback hop.
      secure: isHttps,
      sameSite: isHttps ? 'None' : 'Lax',
    },
  ]);
  return ctx;
}

describe.skipIf(!CHROMIUM_PATH || !HAS_FRONTEND_BUILD)(
  'Integrations deep link — real browser e2e (#586)',
  () => {
    beforeAll(async () => {
      adminSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
      orgBSession = await login(TEST_ORG_B_EMAIL, TEST_ORG_PASSWORD);

      const orgs = await apiGet<OrgRow[]>('/api/organizations', adminSession);
      if (!orgs.data.success || !orgs.data.data) {
        throw new Error(`Failed to list organizations: ${JSON.stringify(orgs.data)}`);
      }
      const slugA = process.env.TEST_ORG_A_SLUG || 'vitest-org-a';
      const slugB = process.env.TEST_ORG_B_SLUG || 'vitest-org-b';
      const orgA = orgs.data.data.find((o) => o.slug === slugA);
      const orgB = orgs.data.data.find((o) => o.slug === slugB);
      if (!orgA || !orgB) {
        throw new Error(`Could not find seeded vitest orgs ${slugA}/${slugB}`);
      }
      orgAId = orgA.id;
      orgBId = orgB.id;

      // Seed several Org A locations so the highlighted card (last one)
      // starts well below the fold of a 1280x720 viewport — that way
      // the post-load `scrollIntoView` actually has somewhere to scroll
      // *to*, and the assertion that `window.scrollY > 0` is a
      // meaningful proof the browser scrolled.
      const orgANames = [
        `${SUITE_TAG}-A1`,
        `${SUITE_TAG}-A2`,
        `${SUITE_TAG}-A3`,
        `${SUITE_TAG}-A4`,
        `${SUITE_TAG}-A5`,
        `${SUITE_TAG}-A6-target`,
      ];
      for (const name of orgANames) {
        seededLocations.push(await createLocation(orgAId, name));
      }
      highlightLocationId = seededLocations[seededLocations.length - 1].id;

      // One Org B location so the second test case (org_admin from the
      // other org) has a card to render — proves "page renders cleanly"
      // is real success, not just an empty-state code path that would
      // mask a real crash.
      seededLocations.push(await createLocation(orgBId, `${SUITE_TAG}-B1`));

      if (!CHROMIUM_PATH) {
        // describe.skipIf above already filters this out — this is a
        // type-narrowing guard for TS, not a real runtime branch.
        throw new Error('REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE not set');
      }
      browser = await chromium.launch({
        executablePath: CHROMIUM_PATH,
        headless: true,
      });
    }, 60_000);

    afterAll(async () => {
      // Cleanup contract (#630): every location this suite seeded in
      // `beforeAll` must be deleted here. The previous
      // `catch { /* swallow */ }` pattern silently leaked location
      // rows into the shared dev DB on every run — names are unique
      // per process+timestamp, so a swallowed delete failure was
      // invisible AND permanent. Failures are now logged with id
      // context AND collected so the suite fails at the end. All
      // deletes are still attempted even when one fails, so a single
      // bad row doesn't block the rest of cleanup. The browser is
      // always closed regardless.
      const failures: Array<{ label: string; error: unknown }> = [];
      try {
        for (const loc of seededLocations) {
          try {
            await apiDelete(`/api/locations/${loc.id}`, adminSession);
          } catch (error) {
            failures.push({ label: `locations:${loc.id}`, error });
            console.error(
              `[integrations-deep-link cleanup] locations:${loc.id} failed:`,
              error,
            );
          }
        }
      } finally {
        if (browser) await browser.close();
      }
      if (failures.length > 0) {
        const summary = failures
          .map((f) => `  - ${f.label}: ${(f.error as Error)?.message ?? String(f.error)}`)
          .join('\n');
        throw new Error(
          `integrations-deep-link afterAll cleanup had ${failures.length} failure(s):\n${summary}`,
        );
      }
    }, 30_000);

    it(
      'system_admin: highlighted card receives data-highlighted=true and is scrolled into view',
      async () => {
        const ctx = await newPageWithSession(adminSession);
        try {
          const page = await ctx.newPage();

          const pageErrors: Error[] = [];
          page.on('pageerror', (err) => pageErrors.push(err));

          await page.goto(`${BASE_URL}/integrations?location=${highlightLocationId}`, {
            waitUntil: 'domcontentloaded',
          });

          // Wait for the page heading to be sure the React app booted.
          await page.waitForSelector('h1:has-text("Integrations")', { timeout: 20_000 });

          // The deep-link side effect — wait for the card to actually
          // get the highlighted data attribute (covers the org
          // auto-select + locations fetch + highlight effect chain).
          const cardSelector = `[data-testid="payment-location-card-${highlightLocationId}"]`;
          await page.waitForSelector(`${cardSelector}[data-highlighted="true"]`, {
            timeout: 20_000,
          });

          const card = page.locator(cardSelector);
          expect(await card.getAttribute('data-highlighted')).toBe('true');

          // Smooth scroll has to actually finish before we measure
          // — wait until the card has *some* portion inside the
          // viewport. We can't require it be fully contained because
          // a payment-location card can easily be taller than 720px
          // once expanded with controls; what matters for the deep
          // link is that the user can see it.
          await page.waitForFunction(
            (sel) => {
              const el = document.querySelector(sel);
              if (!el) return false;
              const r = el.getBoundingClientRect();
              return r.bottom > 0 && r.top < window.innerHeight;
            },
            cardSelector,
            { timeout: 10_000 },
          );
          // Let the smooth-scroll animation actually settle so the
          // assertion below isn't measuring a transient mid-scroll
          // position.
          await page.waitForTimeout(500);

          // Real browser scroll proof #1 — the highlighted card has
          // landed at least partially inside the viewport.
          const isInViewport = await card.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.bottom > 0 && r.top < window.innerHeight;
          });
          expect(isInViewport).toBe(true);

          // Real browser scroll proof #2 — the page actually scrolled
          // (it didn't if the highlighted card had been at the top
          // already). We seed enough cards above to make this a
          // meaningful check.
          const scrollY = await page.evaluate(() => window.scrollY);
          expect(scrollY).toBeGreaterThan(0);

          // Sibling Org A cards must NOT be flagged as highlighted —
          // proves the highlight is targeted, not blanket-applied.
          const siblings = seededLocations.filter(
            (l) => l.organizationId === orgAId && l.id !== highlightLocationId,
          );
          for (const sib of siblings) {
            const sibLoc = page.locator(
              `[data-testid="payment-location-card-${sib.id}"]`,
            );
            // The card must exist (Org A admin/admin can see all Org A
            // locations) but must not be highlighted.
            expect(await sibLoc.count()).toBeGreaterThan(0);
            expect(await sibLoc.first().getAttribute('data-highlighted')).toBeNull();
          }

          if (pageErrors.length > 0) {
            throw new Error(
              `Unexpected page errors: ${pageErrors.map((e) => e.message).join('; ')}`,
            );
          }
        } finally {
          await ctx.close();
        }
      },
      60_000,
    );

    it(
      'org_admin from a different org: page renders cleanly with no highlight when the deep-linked location is inaccessible',
      async () => {
        const ctx = await newPageWithSession(orgBSession);
        try {
          const page = await ctx.newPage();

          const pageErrors: Error[] = [];
          page.on('pageerror', (err) => pageErrors.push(err));

          await page.goto(`${BASE_URL}/integrations?location=${highlightLocationId}`, {
            waitUntil: 'domcontentloaded',
          });

          // Page rendered (didn't crash on the inaccessible deep link).
          await page.waitForSelector('h1:has-text("Integrations")', { timeout: 20_000 });

          // Wait for the org_admin's own location card to render —
          // proves the locations query resolved against the real
          // backend (i.e. we're past loading state, not racing it).
          const orgBLoc = seededLocations.find((l) => l.organizationId === orgBId);
          if (!orgBLoc) throw new Error('expected at least one Org B seed location');
          await page.waitForSelector(
            `[data-testid="payment-location-card-${orgBLoc.id}"]`,
            { timeout: 20_000 },
          );

          // Give the highlight effect plenty of time to (incorrectly)
          // light something up if a regression ever flipped the
          // org-isolation guard on `/api/locations/:id`.
          await page.waitForTimeout(750);

          // Crash check — no uncaught errors hit the page.
          if (pageErrors.length > 0) {
            throw new Error(
              `Unexpected page errors: ${pageErrors.map((e) => e.message).join('; ')}`,
            );
          }

          // No card on the page is flagged as highlighted.
          expect(await page.locator('[data-highlighted="true"]').count()).toBe(0);

          // The Org A target location is not visible to the Org B
          // admin at all — proves the inaccessible-deep-link branch
          // really is exercised here (not just "the card happens to
          // not be highlighted").
          expect(
            await page
              .locator(`[data-testid="payment-location-card-${highlightLocationId}"]`)
              .count(),
          ).toBe(0);
        } finally {
          await ctx.close();
        }
      },
      60_000,
    );
  },
);
