import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { and, eq, inArray, sql } from 'drizzle-orm';

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
import { accountActionRequests, bowlers, emailTemplates, identityLinkEvents, organizations, users } from '@shared/schema';
import { clearCapturedEmails, getCapturedEmails } from '../../server/services/_internal/email-outbox';

const ORGANIZATION_SLUG = 'email-first-browser-fixture';
const ORGANIZATION_SUBDOMAIN = 'emailfirstbrowser';
const ROOT_HOST = 'leaguevault.test';
const EXPECTED_HOST = ROOT_HOST;
const MATCH_EMAIL = 'matched-registration@vitest.local';
const NO_MATCH_EMAIL = 'waiting-registration@vitest.local';
const ROOT_EMAIL = 'root-waiting-registration@vitest.local';
const SIGNUP_PHONE = '555-111-2222';
const MATCH_BOWLER_PHONE = '555-000-0000';
const SETUP_PASSWORD = 'BrowserSetup9!';

const createdUserIds: number[] = [];
let organizationId: number;
let matchedBowlerId: number;
let app: CreatedApp;
let browser: Browser;

type BrowserRouteState = {
  tearingDown: boolean;
  pendingFetchPort?: number;
  activeHandlers: Set<Promise<void>>;
  unexpectedErrors: unknown[];
};

type RegistrationBrowserDiagnostics = {
  phase?: string;
  url?: string;
  readyState?: string;
  title?: string;
  bodyText?: string;
  labels?: string[];
  buttons?: string[];
  availability?: unknown;
  pageErrors: string[];
  consoleErrors: string[];
  failedRequests: string[];
  responses: string[];
  registrationResponse?: { status: number; body: string };
  activeOrganizations?: {
    beforeCallback?: unknown;
    beforePost?: unknown;
    afterPost?: unknown;
  };
  screenshot?: string;
};

type BrowserOrganizationIsolationDiagnostics = {
  beforeCallback?: unknown;
};

function diagnosticPath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/([?&](?:token|key|secret|code|signature)=)[^&\s"']+/gi, '$1<redacted>')
    .slice(0, 4_000);
}

function appendDiagnostic(values: string[], value: string): void {
  if (values.length < 50) values.push(value);
}

function installRegistrationDiagnostics(page: Page): {
  diagnostics: Pick<RegistrationBrowserDiagnostics, 'pageErrors' | 'consoleErrors' | 'failedRequests' | 'responses'>;
  dispose: () => void;
} {
  const diagnostics = {
    pageErrors: [] as string[],
    consoleErrors: [] as string[],
    failedRequests: [] as string[],
    responses: [] as string[],
  };
  const onPageError = (error: Error) => {
    appendDiagnostic(diagnostics.pageErrors, redactDiagnosticText(error.message));
  };
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      appendDiagnostic(diagnostics.consoleErrors, redactDiagnosticText(`${message.type()}: ${message.text()}`));
    }
  };
  const onRequestFailed = (request: { method(): string; url(): string; failure(): { errorText?: string } | null }) => {
    const failure = request.failure()?.errorText ?? 'unknown';
    appendDiagnostic(diagnostics.failedRequests, `${request.method()} ${diagnosticPath(request.url())} — ${redactDiagnosticText(failure)}`);
  };
  const onResponse = (response: { status(): number; url(): string; request(): { resourceType(): string; method(): string } }) => {
    const request = response.request();
    const path = diagnosticPath(response.url());
    if (request.resourceType() === 'document' || path.includes('/api/auth/')) {
      appendDiagnostic(diagnostics.responses, `${request.method()} ${path} → ${response.status()}`);
    }
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);
  return {
    diagnostics,
    dispose: () => {
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    },
  };
}

async function collectRegistrationDiagnostics(
  page: Page,
  captured: Pick<RegistrationBrowserDiagnostics, 'pageErrors' | 'consoleErrors' | 'failedRequests' | 'responses'>,
  extra: Pick<RegistrationBrowserDiagnostics, 'phase' | 'registrationResponse' | 'activeOrganizations'> = {},
): Promise<RegistrationBrowserDiagnostics> {
  const diagnostics: RegistrationBrowserDiagnostics = {
    ...captured,
    ...extra,
  };
  try {
    diagnostics.url = diagnosticPath(page.url());
    const pageState = await page.evaluate(() => ({
      readyState: document.readyState,
      title: document.title,
      bodyText: document.body?.innerText ?? '',
      labels: Array.from(document.querySelectorAll('label')).map((element) => element.textContent?.trim() ?? '').filter(Boolean),
      buttons: Array.from(document.querySelectorAll('button')).map((element) => element.textContent?.trim() ?? '').filter(Boolean),
    }));
    diagnostics.readyState = pageState.readyState;
    diagnostics.title = pageState.title;
    diagnostics.bodyText = redactDiagnosticText(pageState.bodyText);
    diagnostics.labels = pageState.labels.slice(0, 50);
    diagnostics.buttons = pageState.buttons.slice(0, 50);
  } catch (error) {
    diagnostics.bodyText = `<page inspection failed: ${error instanceof Error ? error.message : String(error)}>`;
  }
  try {
    diagnostics.availability = await page.evaluate(async () => {
      const response = await fetch('/api/auth/registration/availability', {
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(3_000),
      });
      const body = await response.text();
      return { status: response.status, body: body.slice(0, 1_000) };
    });
    if (diagnostics.availability && typeof diagnostics.availability === 'object' && 'body' in diagnostics.availability) {
      const availability = diagnostics.availability as { body?: unknown };
      if (typeof availability.body === 'string') {
        availability.body = redactDiagnosticText(availability.body).slice(0, 1_000);
      }
    }
  } catch (error) {
    diagnostics.availability = { error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const screenshot = `.local/email-first-registration-failure-${process.pid}-${Date.now()}.png`;
    await page.screenshot({ path: screenshot, fullPage: true, timeout: 3_000 });
    diagnostics.screenshot = screenshot;
  } catch (error) {
    diagnostics.screenshot = `<screenshot failed: ${error instanceof Error ? error.message : String(error)}>`;
  }
  return diagnostics;
}

async function activeOrganizationRows(): Promise<unknown> {
  try {
    const rows = (await db.select({
      id: organizations.id,
      slug: organizations.slug,
      subdomain: organizations.subdomain,
      active: organizations.active,
    }).from(organizations).where(eq(organizations.active, true)).limit(50))
      .map((row) => ({ ...row }));
    const databaseResult = await db.execute(sql`SELECT current_database() AS database_name`);
    const databaseName = (databaseResult.rows[0] as { database_name?: unknown } | undefined)?.database_name;
    return {
      currentDatabase: typeof databaseName === 'string' ? databaseName : '<unknown>',
      vitestPoolId: process.env.VITEST_POOL_ID ?? '<unset>',
      activeOrganizations: rows,
    };
  } catch (error) {
    return {
      currentDatabase: '<query-failed>',
      vitestPoolId: process.env.VITEST_POOL_ID ?? '<unset>',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isRouteLifecycleError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('Route is already handled!')
    || error.message.includes('Fetch response has been disposed')
    || error.message.includes('Request context disposed.')
    || error.message.includes('Target page, context or browser has been closed');
}

export function shouldIgnoreRouteLifecycleError(error: unknown, tearingDown: boolean): boolean {
  return tearingDown && isRouteLifecycleError(error);
}

const browserRouteStates = new WeakMap<BrowserContext, BrowserRouteState>();

async function createBrowserContext(options: { pendingFetchPort?: number } = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(15_000);
  const routeState: BrowserRouteState = {
    tearingDown: false,
    pendingFetchPort: options.pendingFetchPort,
    activeHandlers: new Set(),
    unexpectedErrors: [],
  };
  // Keep the exact HTTPS URL from the email while routing its real HTTP
  // traffic to this isolated app. This supplies transport, not API mocks.
  await context.route('**/*', async (route) => {
    const handler = (async () => {
      try {
        const incoming = new URL(route.request().url());
        if (![EXPECTED_HOST, ROOT_HOST].includes(incoming.hostname)) {
          await route.abort();
          return;
        }
        const targetPort = routeState.pendingFetchPort && incoming.pathname === '/__pending-browser-fetch'
          ? routeState.pendingFetchPort
          : app.port;
        const response = await route.fetch({
          url: `http://127.0.0.1:${targetPort}${incoming.pathname}${incoming.search}`,
          headers: { ...route.request().headers(), host: incoming.hostname },
          maxRedirects: 0,
        });
        await route.fulfill({ response });
      } catch (error) {
        // A superseded navigation or browser/context teardown may cancel a
        // route after fetch has started. Only these Playwright lifecycle
        // errors are expected after this context has entered teardown.
        if (!shouldIgnoreRouteLifecycleError(error, routeState.tearingDown)) throw error;
        // route.fetch() is not a route action, so a canceled fetch can leave
        // Playwright's route handling promise unresolved. Complete the route
        // so the context can close; a real abort failure is still surfaced
        // unless it is another known teardown error.
        try {
          await route.abort();
        } catch (abortError) {
          if (!shouldIgnoreRouteLifecycleError(abortError, routeState.tearingDown)) throw abortError;
        }
      }
    })();
    routeState.activeHandlers.add(handler);
    try {
      await handler;
    } catch (error) {
      routeState.unexpectedErrors.push(error);
      throw error;
    } finally {
      routeState.activeHandlers.delete(handler);
    }
  });
  browserRouteStates.set(context, routeState);
  return context;
}

async function closeContextAfterRoutesDrain(context: BrowserContext): Promise<void> {
  const routeState = browserRouteStates.get(context);
  if (routeState) routeState.tearingDown = true;
  const cleanupErrors: unknown[] = [];
  try {
    // Removing routes without waiting lets context.close() dispose the
    // request client that route.fetch() uses. Waiting first can deadlock on a
    // fetch that is still waiting for the app to respond.
    await context.unrouteAll({ behavior: 'default' });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await context.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (routeState) {
    await Promise.allSettled([...routeState.activeHandlers]);
    cleanupErrors.push(...routeState.unexpectedErrors);
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Browser route cleanup failed');
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
  isolationDiagnostics?: BrowserOrganizationIsolationDiagnostics,
): Promise<{ page: Page; forbiddenRequests: string[]; user: typeof users.$inferSelect }> {
  const page = await context.newPage();
  const forbiddenRequests = watchForbiddenProfileRequests(page);
  const browserDiagnostics = installRegistrationDiagnostics(page);
  const host = input.host ?? EXPECTED_HOST;
  let phase = 'load-and-fill';
  let registrationFailureResponse: { status: number; body: string } | undefined;
  let activeOrganizationsBeforePost: unknown;
  let activeOrganizationsAfterPost: unknown;
  try {
    await page.goto(`https://${host}/signup`);
    await page.getByRole('link', { name: 'I Need to Register', exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/register');
    await page.getByRole('heading', { name: 'Create your account.', exact: true }).waitFor();
    await page.getByLabel('Full name', { exact: true }).fill(input.name);
    await page.getByLabel('Email address', { exact: true }).fill(input.email);
    await page.getByLabel('Phone number', { exact: true }).fill(SIGNUP_PHONE);
    phase = 'submit-registration';
    activeOrganizationsBeforePost = await activeOrganizationRows();
    const requestPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'POST' && url.pathname === '/api/auth/register';
    });
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && url.pathname === '/api/auth/register';
    });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const [request, response] = await Promise.all([requestPromise, responsePromise]);
    let registrationResponseBody = '';
    if (response.status() !== 202) {
      try {
        registrationResponseBody = redactDiagnosticText(await response.text());
      } catch (error) {
        registrationResponseBody = `<response body unavailable: ${error instanceof Error ? error.message : String(error)}>`;
      }
      registrationFailureResponse = { status: response.status(), body: registrationResponseBody };
      activeOrganizationsAfterPost = await activeOrganizationRows();
    }
    expect(response.status()).toBe(202);

    const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      name: input.name,
      email: input.email,
      phone: SIGNUP_PHONE,
    });
    expect(body).not.toHaveProperty('password');

    // The response is a check-email success state, not an authenticated app
    // session. The anonymous session itself is the capability for status/resend.
    phase = 'wait-for-registration-email';
    await page.getByRole('heading', { name: 'Check your email.', exact: true }).waitFor();
    // Exercise a fresh document/query cache on the waiting URL for both the
    // organization and canonical-root hosts. The background /api/user request
    // is naturally unauthenticated and must not redirect this public page.
    await page.goto(`https://${host}/registration-email`);
    await page.getByRole('heading', { name: 'Check your email.', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Check your email.', exact: true }).waitFor();
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
  } catch (error) {
    const diagnostics = await collectRegistrationDiagnostics(page, browserDiagnostics.diagnostics, {
      phase,
      registrationResponse: registrationFailureResponse,
      activeOrganizations: {
        beforeCallback: isolationDiagnostics?.beforeCallback,
        beforePost: activeOrganizationsBeforePost,
        afterPost: activeOrganizationsAfterPost,
      },
    });
    throw new Error(`Registration browser flow failed: ${JSON.stringify(diagnostics)}`, { cause: error });
  } finally {
    browserDiagnostics.dispose();
  }
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

async function withOnlyBrowserOrganization<T>(
  callback: () => Promise<T>,
  isolationDiagnostics?: BrowserOrganizationIsolationDiagnostics,
): Promise<T> {
  if (isolationDiagnostics) isolationDiagnostics.beforeCallback = await activeOrganizationRows();
  const activeRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.active, true));
  const otherActiveIds = activeRows
    .map(({ id }) => id)
    .filter((id) => id !== organizationId);
  for (const id of otherActiveIds) {
    await db.update(organizations).set({ active: false }).where(eq(organizations.id, id));
  }
  try {
    return await callback();
  } finally {
    for (const id of otherActiveIds) {
      await db.update(organizations).set({ active: true }).where(eq(organizations.id, id));
    }
  }
}

describe('browser route lifecycle handling', () => {
  it('only ignores known lifecycle errors after teardown begins', () => {
    expect(shouldIgnoreRouteLifecycleError(new Error('Route is already handled!'), false)).toBe(false);
    expect(shouldIgnoreRouteLifecycleError(new Error('Route is already handled!'), true)).toBe(true);
    expect(shouldIgnoreRouteLifecycleError(new Error('Fetch response has been disposed'), true)).toBe(true);
    expect(shouldIgnoreRouteLifecycleError(new Error('Request context disposed.'), false)).toBe(false);
    expect(shouldIgnoreRouteLifecycleError(new Error('Request context disposed.'), true)).toBe(true);
    expect(shouldIgnoreRouteLifecycleError(new Error('synthetic live route failure'), true)).toBe(false);
  });
});

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

  it('cancels a pending intercepted fetch before draining browser routes', async () => {
    let requestSeen = false;
    const pendingServer = createServer((_request, _response) => {
      requestSeen = true;
      // Keep the response open until the browser context request client is
      // disposed by closeContextAfterRoutesDrain.
    });
    await new Promise<void>((resolve, reject) => {
      pendingServer.once('error', reject);
      pendingServer.listen(0, '127.0.0.1', resolve);
    });
    const address = pendingServer.address();
    if (!address || typeof address === 'string') throw new Error('Pending route server did not expose a port');

    const context = await createBrowserContext({ pendingFetchPort: address.port });
    const page = await context.newPage();
    const navigation = page.goto(`https://${EXPECTED_HOST}/__pending-browser-fetch`).catch((error: unknown) => error);
    let contextClosed = false;
    try {
      await expect.poll(() => requestSeen, { timeout: 5_000 }).toBe(true);
      await closeContextAfterRoutesDrain(context);
      contextClosed = true;
      await expect(navigation).resolves.toBeInstanceOf(Error);
    } finally {
      if (!contextClosed) await context.close();
      pendingServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        if (!pendingServer.listening) {
          resolve();
          return;
        }
        pendingServer.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 15_000);

  afterAll(async () => {
    await browser?.close();
    if (createdUserIds.length) {
      await db.update(users).set({ bowlerId: null }).where(inArray(users.id, createdUserIds));
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    if (organizationId) await db.delete(identityLinkEvents).where(eq(identityLinkEvents.organizationId, organizationId));
    if (matchedBowlerId) await db.delete(bowlers).where(eq(bowlers.id, matchedBowlerId));
    if (organizationId) await db.delete(organizations).where(eq(organizations.id, organizationId));
    await app?.close();
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('proves unique same-org normalized email ownership before dashboard access', async () => {
    let phase = 'registration';
    onTestFailed(() => console.info(`[registration-browser] failed phase=${phase}`));
    clearCapturedEmails();
    await installRegistrationTemplate();
    const context = await createBrowserContext();
    try {
      await withOnlyBrowserOrganization(async () => {
        const { page, forbiddenRequests, user } = await startRegistration(context, {
          email: MATCH_EMAIL,
          name: 'Matched Browser User',
        });
        const setupUrl = await waitForSetupUrl(MATCH_EMAIL);
        phase = 'open and reload setup';
        await openAndReloadSetup(page, setupUrl, user.id);
        phase = 'submit password';
        expect(await setPassword(page)).toBe(200);
        phase = 'authenticated landing';
        await waitForAuthenticatedLanding(page, '/bowler-dashboard');

        phase = 'verify roster ownership';
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
      });
    } finally {
      phase = `drain browser routes after ${phase}`;
      await closeContextAfterRoutesDrain(context);
    }
  }, 60_000);

  it('keeps an unmatched account authenticated but waiting for administrator setup', async () => {
    clearCapturedEmails();
    await installRegistrationTemplate();
    const context = await createBrowserContext();
    try {
      await withOnlyBrowserOrganization(async () => {
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
      });
    } finally {
      await closeContextAfterRoutesDrain(context);
    }
  }, 60_000);

  it('keeps a canonical-root waiting page usable on direct navigation and reload', async () => {
    clearCapturedEmails();
    await installRegistrationTemplate();
    const context = await createBrowserContext();
    const isolationDiagnostics: BrowserOrganizationIsolationDiagnostics = {};
    try {
      await withOnlyBrowserOrganization(async () => {
        await startRegistration(context, {
          email: ROOT_EMAIL,
          name: 'Root Waiting User',
          host: ROOT_HOST,
        }, isolationDiagnostics);
        const directPage = await context.newPage();
        await directPage.goto(`https://${ROOT_HOST}/registration-email`);
        await directPage.getByRole('heading', { name: 'Check your email.', exact: true }).waitFor();
        await directPage.reload();
        await directPage.getByRole('heading', { name: 'Check your email.', exact: true }).waitFor();
        expect(new URL(directPage.url()).pathname).toBe('/registration-email');
        const status = await directPage.evaluate(async () => {
          const response = await fetch('/api/auth/registration/status', { credentials: 'include' });
          return { status: response.status, body: await response.json() as { data?: { status?: unknown } } };
        });
        expect(status.status).toBe(200);
        expect(status.body.data?.status).toBe('pending');
      }, isolationDiagnostics);
    } finally {
      await closeContextAfterRoutesDrain(context);
    }
  }, 60_000);
});
