import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { and, eq, inArray } from 'drizzle-orm';

// Exercise the real registration renderer and blocked-recipient outbox. No
// provider credentials or production recipients are used, even when the
// shell has them.
vi.hoisted(() => {
  vi.stubEnv('SENDGRID_API_KEY', 'SG.synthetic-browser-test-only');
  vi.stubEnv('BLOCK_EMAIL_DOMAINS', 'vitest.local');
  vi.stubEnv('APP_DOMAIN', 'leaguevault.test');
});

import { createApp, type CreatedApp } from '../../server/app';
import { db, pool } from '../../server/db';
import { accountActionRequests, bowlers, emailTemplates, identityLinkEvents, leagues, organizations, users } from '@shared/schema';
import { clearCapturedEmails, getCapturedEmails } from '../../server/services/_internal/email-outbox';

const ORGANIZATION_SLUG = 'email-first-browser-fixture';
const ORGANIZATION_SUBDOMAIN = 'emailfirstbrowser';
const EXPECTED_HOST = `${ORGANIZATION_SUBDOMAIN}.leaguevault.test`;
const ROOT_HOST = 'leaguevault.test';
const LEAGUE_NAME = 'Email-first browser league';
const MATCH_EMAIL = 'matched-registration@vitest.local';
const NO_MATCH_EMAIL = 'waiting-registration@vitest.local';
const ROOT_EMAIL = 'root-waiting-registration@vitest.local';
const SIGNUP_PHONE = '555-111-2222';
const MATCH_BOWLER_PHONE = '555-000-0000';
const SETUP_PASSWORD = 'BrowserSetup9!';

const createdUserIds: number[] = [];
let organizationId: number;
let leagueId: number;
let matchedBowlerId: number;
let app: CreatedApp;
let browser: Browser;

async function createBrowserContext(): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // Keep the exact HTTPS URL from the email while routing its real HTTP
  // traffic to this isolated app. This supplies transport, not API mocks.
  await context.route('**/*', async (route) => {
    const incoming = new URL(route.request().url());
    if (![EXPECTED_HOST, ROOT_HOST].includes(incoming.hostname)) return route.abort();
    const response = await route.fetch({
      url: `http://127.0.0.1:${app.port}${incoming.pathname}${incoming.search}`,
      headers: { ...route.request().headers(), host: incoming.hostname },
      maxRedirects: 0,
    });
    await route.fulfill({ response });
  });
  return context;
}

async function installRegistrationTemplate(): Promise<void> {
  await db.insert(emailTemplates).values({
    slug: 'account_registration',
    name: 'Finish registration',
    subject: 'Finish setting up your LeagueVault account',
    body: '<p>Hi {{bowler_name}}</p><a href="{{invite_link}}">Set up your account</a>',
    active: true,
  }).onConflictDoUpdate({
    target: emailTemplates.slug,
    set: { active: true },
  });
}

async function waitForUser(email: string) {
  let user: typeof users.$inferSelect | undefined;
  await expect.poll(async () => {
    [user] = await db.select().from(users).where(and(
      eq(users.email, email),
      eq(users.organizationId, organizationId),
    )).limit(1);
    return user?.id ?? 0;
  }, { timeout: 15_000 }).toBeGreaterThan(0);
  if (!user) throw new Error(`Registration user ${email} was not created`);
  createdUserIds.push(user.id);
  return user;
}

function capturedEmailHasRecipient(entry: ReturnType<typeof getCapturedEmails>[number], email: string): boolean {
  const recipients = entry.msg.to;
  if (!recipients) return false;
  const values = Array.isArray(recipients) ? recipients : [recipients];
  return values.some((value) => (typeof value === 'string' ? value : value.email) === email);
}

async function waitForSetupUrl(email: string): Promise<URL> {
  await expect.poll(() => {
    const captured = getCapturedEmails().find((entry) => {
      const html = entry.msg.html;
      return capturedEmailHasRecipient(entry, email)
        && typeof html === 'string'
        && /href="https:[^"]*\/set-password\?token=[^"]+"/.test(html);
    });
    return typeof captured?.msg.html === 'string' ? captured.msg.html : '';
  }, { timeout: 15_000 }).toMatch(/href="https:[^"]*\/set-password\?token=[^"]+"/);
  const captured = getCapturedEmails().find((entry) => {
    const html = entry.msg.html;
    return capturedEmailHasRecipient(entry, email)
      && typeof html === 'string'
      && /href="https:[^"]*\/set-password\?token=[^"]+"/.test(html);
  });
  const html = captured?.msg.html;
  if (typeof html !== 'string') throw new Error('Registration email HTML was not captured');
  const href = /href="(https:[^"]*\/set-password\?token=[^"]+)"/.exec(html)?.[1];
  if (!href) throw new Error('Rendered registration email did not contain a setup link');
  const setupUrl = new URL(href.replaceAll('&amp;', '&'));
  expect(setupUrl.hostname).toBe(EXPECTED_HOST);
  expect(captured?.blockedDomains).toContain('vitest.local');
  return setupUrl;
}

function watchForbiddenProfileRequests(page: Page): string[] {
  const forbidden: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/claim-bowler') || path.includes('/api/bowlers/unlinked')) {
      forbidden.push(path);
    }
  });
  return forbidden;
}

async function startRegistration(
  context: BrowserContext,
  input: { email: string; name: string; host?: string },
): Promise<{ page: Page; forbiddenRequests: string[]; user: typeof users.$inferSelect }> {
  const page = await context.newPage();
  const forbiddenRequests = watchForbiddenProfileRequests(page);
  const host = input.host ?? EXPECTED_HOST;
  const signupPath = host === ROOT_HOST ? '/signup' : `/signup?org=${ORGANIZATION_SLUG}`;
  await page.goto(`https://${host}${signupPath}`);
  await page.getByLabel('Full Name', { exact: true }).fill(input.name);
  await page.getByLabel('Email Address', { exact: true }).fill(input.email);
  await page.getByLabel('Phone Number', { exact: true }).fill(SIGNUP_PHONE);
  await page.getByRole('combobox', { name: /league/i }).click();
  await page.getByRole('option', { name: new RegExp(LEAGUE_NAME), exact: host !== ROOT_HOST }).click();

  const requestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return request.method() === 'POST' && url.pathname === '/api/auth/register';
  });
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/auth/register';
  });
  await page.getByRole('button', { name: /create account/i }).click();
  const [request, response] = await Promise.all([requestPromise, responsePromise]);
  expect(response.status()).toBe(202);

  const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
  expect(body).toEqual({
    name: input.name,
    email: input.email,
    phone: SIGNUP_PHONE,
    leagueId: String(leagueId),
    organizationId,
  });
  expect(body).not.toHaveProperty('password');

  // The response is a check-email success state, not an authenticated app
  // session. The anonymous session itself is the capability for status/resend.
  await page.getByText('Check your email', { exact: true }).waitFor();
  // Exercise a fresh document/query cache on the waiting URL for both the
  // organization and canonical-root hosts. The background /api/user request
  // is naturally unauthenticated and must not redirect this public page.
  await page.goto(`https://${host}/registration-email`);
  await page.getByText('Check your email', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Check your email', { exact: true }).waitFor();
  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.name === 'connect.sid')).toBe(true);
  const authBeforeSetup = await page.evaluate(async () => (
    await fetch('/api/auth/user', { credentials: 'include' })
  ).status);
  expect(authBeforeSetup).toBe(401);
  const registrationStatus = await page.evaluate(async () => {
    const response = await fetch('/api/auth/registration/status', { credentials: 'include' });
    return { status: response.status, body: await response.json() as { data?: { status?: unknown } } };
  });
  expect(registrationStatus.status).toBe(200);
  expect(registrationStatus.body.data?.status).toBe('pending');

  const user = await waitForUser(input.email);
  expect(user.password).toEqual(expect.any(String));
  expect(user.bowlerId).toBeNull();
  expect(user.phone).toBe(SIGNUP_PHONE);
  return { page, forbiddenRequests, user };
}

async function openAndReloadSetup(page: Page, setupUrl: URL, userId: number): Promise<void> {
  const landing = await page.goto(setupUrl.toString());
  expect(landing?.headers()['referrer-policy']).toBe('no-referrer');
  expect(landing?.headers()['cache-control']).toBe('no-store');
  await page.getByLabel('Password', { exact: true }).waitFor();

  // A preview/open/reload must leave the credential pending and usable.
  await page.reload();
  await page.getByLabel('Password', { exact: true }).waitFor();
  const [pending] = await db.select({ status: accountActionRequests.status })
    .from(accountActionRequests)
    .where(eq(accountActionRequests.userId, userId));
  expect(pending?.status).toBe('pending');
}

async function setPassword(page: Page): Promise<number> {
  await page.getByLabel('Password', { exact: true }).fill(SETUP_PASSWORD);
  await page.getByLabel('Confirm Password', { exact: true }).fill(SETUP_PASSWORD);
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/auth/set-password';
  });
  await page.getByTestId('button-set-password-submit').click();
  const response = await responsePromise;
  return response.status();
}

async function waitForAuthenticatedLanding(page: Page, expectedPath: '/bowler-dashboard' | '/registration-complete'): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(expectedPath);
  const authAfterSetup = await page.evaluate(async () => (
    await fetch('/api/auth/user', { credentials: 'include' })
  ).status);
  expect(authAfterSetup).toBe(200);
}

describe('Email-first registration — real browser, outbox, and setup link', () => {
  beforeAll(async () => {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
    if (!existsSync(executablePath) || !existsSync('dist/public/index.html')) {
      throw new Error('Email-first registration browser test requires npm run build and npx playwright install chromium.');
    }

    const [organization] = await db.insert(organizations).values({
      name: 'Email-first browser fixture',
      slug: ORGANIZATION_SLUG,
      subdomain: ORGANIZATION_SUBDOMAIN,
      active: true,
    }).returning();
    organizationId = organization.id;

    const [league] = await db.insert(leagues).values({
      name: LEAGUE_NAME,
      organizationId,
      active: true,
      allowPublicSignup: true,
      seasonStart: '2030-01-07',
      seasonEnd: '2030-04-29',
      weekDay: 'Monday',
      paymentMode: 'weekly',
    }).returning();
    leagueId = league.id;

    const [matchedBowler] = await db.insert(bowlers).values({
      name: 'Roster email match',
      email: ` ${MATCH_EMAIL.toUpperCase()} `,
      phone: MATCH_BOWLER_PHONE,
      organizationId,
    }).returning();
    matchedBowlerId = matchedBowler.id;

    app = await createApp({
      port: 0,
      suppressBackgroundWorkers: true,
      enableAccountActionDeliveryWorker: true,
      serveStaticFrontend: true,
    });
    browser = await chromium.launch({ executablePath, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (createdUserIds.length) {
      await db.update(users).set({ bowlerId: null }).where(inArray(users.id, createdUserIds));
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    if (organizationId) await db.delete(identityLinkEvents).where(eq(identityLinkEvents.organizationId, organizationId));
    if (matchedBowlerId) await db.delete(bowlers).where(eq(bowlers.id, matchedBowlerId));
    if (leagueId) await db.delete(leagues).where(eq(leagues.id, leagueId));
    if (organizationId) await db.delete(organizations).where(eq(organizations.id, organizationId));
    await app?.close();
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('proves unique same-org normalized email ownership before dashboard access', async () => {
    clearCapturedEmails();
    await installRegistrationTemplate();
    const context = await createBrowserContext();
    try {
      const { page, forbiddenRequests, user } = await startRegistration(context, {
        email: MATCH_EMAIL,
        name: 'Matched Browser User',
      });
      const setupUrl = await waitForSetupUrl(MATCH_EMAIL);
      await openAndReloadSetup(page, setupUrl, user.id);
      expect(await setPassword(page)).toBe(200);
      await waitForAuthenticatedLanding(page, '/bowler-dashboard');

      await expect.poll(async () => {
        const [updated] = await db.select({ bowlerId: users.bowlerId })
          .from(users).where(eq(users.id, user.id));
        return updated?.bowlerId ?? null;
      }, { timeout: 15_000 }).toBe(matchedBowlerId);
      const [bowler] = await db.select({ phone: bowlers.phone })
        .from(bowlers).where(eq(bowlers.id, matchedBowlerId));
      // Registration deliberately does not overwrite the roster phone.
      expect(bowler?.phone).toBe(MATCH_BOWLER_PHONE);
      expect(forbiddenRequests).toEqual([]);
      expect(page.url()).not.toContain('/claim-bowler');
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps an unmatched account authenticated but waiting for administrator setup', async () => {
    clearCapturedEmails();
    await installRegistrationTemplate();
    const context = await createBrowserContext();
    try {
      const { page, forbiddenRequests, user } = await startRegistration(context, {
        email: NO_MATCH_EMAIL,
        name: 'Waiting Browser User',
      });
      const setupUrl = await waitForSetupUrl(NO_MATCH_EMAIL);
      await openAndReloadSetup(page, setupUrl, user.id);
      expect(await setPassword(page)).toBe(200);
      await waitForAuthenticatedLanding(page, '/registration-complete');
      await page.getByText(/administrator setup|registration in progress/i).first().waitFor();

      const [updated] = await db.select({ bowlerId: users.bowlerId })
        .from(users).where(eq(users.id, user.id));
      expect(updated?.bowlerId).toBeNull();
      expect(forbiddenRequests).toEqual([]);
      expect(page.url()).not.toContain('/claim-bowler');
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps a canonical-root waiting page usable on direct navigation and reload', async () => {
    clearCapturedEmails();
    await installRegistrationTemplate();
    const context = await createBrowserContext();
    try {
      const { page } = await startRegistration(context, {
        email: ROOT_EMAIL,
        name: 'Root Waiting User',
        host: ROOT_HOST,
      });
      const directPage = await context.newPage();
      try {
        await directPage.goto(`https://${ROOT_HOST}/registration-email`);
        await directPage.getByText('Check your email', { exact: true }).waitFor();
        await directPage.reload();
        await directPage.getByText('Check your email', { exact: true }).waitFor();
        expect(new URL(directPage.url()).pathname).toBe('/registration-email');
        const status = await directPage.evaluate(async () => {
          const response = await fetch('/api/auth/registration/status', { credentials: 'include' });
          return { status: response.status, body: await response.json() as { data?: { status?: unknown } } };
        });
        expect(status.status).toBe(200);
        expect(status.body.data?.status).toBe('pending');
      } finally {
        await directPage.close();
      }
      await page.close();
    } finally {
      await context.close();
    }
  }, 60_000);
});
