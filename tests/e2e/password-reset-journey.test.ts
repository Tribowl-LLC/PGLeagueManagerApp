import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { eq, inArray } from 'drizzle-orm';

// Exercise the real mail renderer and blocked-recipient outbox. No provider
// credentials or production recipients are used, even when the shell has them.
vi.hoisted(() => {
  vi.stubEnv('SENDGRID_API_KEY', 'SG.synthetic-browser-test-only');
  vi.stubEnv('BLOCK_EMAIL_DOMAINS', 'vitest.local');
  vi.stubEnv('APP_DOMAIN', 'leaguevault.test');
});

import { createApp, type CreatedApp } from '../../server/app';
import { db, pool } from '../../server/db';
import { accountActionRequests, emailTemplates, organizations, users } from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import { clearCapturedEmails, getCapturedEmails } from '../../server/services/_internal/email-outbox';

const originalPassword = 'OriginalBrowser1!';
const newPassword = 'RecoveredBrowser2!';
const createdUserIds: number[] = [];
let organizationId: number;
let app: CreatedApp;
let browser: Browser;

describe('Password recovery from the rendered email — real browser and API', () => {
  beforeAll(async () => {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
    if (!existsSync(executablePath) || !existsSync('dist/public/index.html')) {
      throw new Error('Password recovery release test requires npm run build and npx playwright install chromium.');
    }
    const [organization] = await db.insert(organizations).values({
      name: 'Recovery browser fixture', slug: 'recovery-browser-fixture', subdomain: 'recoverybrowser',
    }).returning();
    organizationId = organization.id;
    app = await createApp({ port: 0, suppressBackgroundWorkers: true, serveStaticFrontend: true });
    browser = await chromium.launch({ executablePath, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
    if (organizationId) await db.delete(organizations).where(eq(organizations.id, organizationId));
    await app?.close();
    await pool.end();
    vi.unstubAllEnvs();
  });

  for (const templated of [true, false]) {
    for (const tenantHost of [true, false]) {
      it(`${templated ? 'template' : 'fallback'} email on ${tenantHost ? 'organization' : 'root'} host completes recovery`, async () => {
        clearCapturedEmails();
        await db.insert(emailTemplates).values({
          slug: 'password_reset', name: 'Reset password', subject: 'Reset your password',
          body: '<p>Hi {{bowler_name}}</p><a href="{{reset_link}}">Reset password</a>',
          active: templated,
        }).onConflictDoUpdate({ target: emailTemplates.slug, set: { active: templated } });
        const email = `recovery-${templated}-${tenantHost}@vitest.local`;
        const [user] = await db.insert(users).values({
          email, name: 'Recovery browser user', password: await hashPassword(originalPassword),
          // Only system administrators may be organization-less.
          role: tenantHost ? 'user' : 'system_admin', organizationId: tenantHost ? organizationId : null,
        }).returning();
        createdUserIds.push(user.id);
        const expectedHost = tenantHost ? 'recoverybrowser.leaguevault.test' : 'leaguevault.test';
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        // Keep the exact HTTPS URL from the email while routing its real HTTP
        // traffic to this isolated app. This supplies transport, not API mocks.
        await context.route('**/*', async (route) => {
          const incoming = new URL(route.request().url());
          if (incoming.hostname !== expectedHost) return route.abort();
          const response = await route.fetch({
            url: `http://127.0.0.1:${app.port}${incoming.pathname}${incoming.search}`,
            headers: { ...route.request().headers(), host: expectedHost },
            maxRedirects: 0,
          });
          await route.fulfill({ response });
        });
        try {
          const page = await context.newPage();
          await page.goto(`https://${expectedHost}/forgot-password`);
          await page.getByLabel('Email Address', { exact: true }).fill(email);
          await page.getByTestId('button-forgot-submit').click();
          await page.getByText('Check your email', { exact: true }).waitFor();
          await expect.poll(() => getCapturedEmails().length).toBeGreaterThan(0);
          const html = getCapturedEmails()[0]?.msg.html;
          if (typeof html !== 'string') throw new Error('Reset email HTML was not captured');
          const href = /href="(https:[^"]*\/set-password\?token=[^"]+)"/.exec(html)?.[1];
          if (!href) throw new Error('Rendered reset email did not contain a reset link');
          const resetUrl = new URL(href.replaceAll('&amp;', '&'));
          expect(resetUrl.hostname).toBe(expectedHost);
          const landing = await page.goto(resetUrl.toString());
          expect(landing?.headers()['referrer-policy']).toBe('no-referrer');
          expect(landing?.headers()['cache-control']).toBe('no-store');
          await page.getByLabel('Password', { exact: true }).waitFor();
          // A preview/open/reload must leave the credential pending.
          await page.reload();
          await page.getByLabel('Password', { exact: true }).waitFor();
          const [pending] = await db.select({ status: accountActionRequests.status })
            .from(accountActionRequests).where(eq(accountActionRequests.userId, user.id));
          expect(pending.status).toBe('pending');
          await page.getByLabel('Password', { exact: true }).fill(newPassword);
          await page.getByLabel('Confirm Password', { exact: true }).fill(newPassword);
          await page.getByTestId('button-set-password-submit').click();
          await page.waitForURL(`https://${expectedHost}/login`);
          const authBeforeLogin = await page.evaluate(async () => (await fetch('/api/auth/user')).status);
          expect(authBeforeLogin).toBe(401);
          await page.getByLabel('Email Address', { exact: true }).fill(email);
          await page.getByLabel('Password', { exact: true }).fill(newPassword);
          await page.getByTestId('button-login-submit').click();
          await expect.poll(async () => page.evaluate(async () => (await fetch('/api/auth/user')).status)).toBe(200);
          const oldLogin = await fetch(`http://127.0.0.1:${app.port}/api/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: originalPassword }),
          });
          expect(oldLogin.status).toBe(401);
          await page.goto(resetUrl.toString());
          await page.getByText('Link already used', { exact: false }).waitFor();
          const [completed] = await db.select({ status: accountActionRequests.status })
            .from(accountActionRequests).where(eq(accountActionRequests.userId, user.id));
          expect(completed.status).toBe('consumed');
        } finally {
          await context.close();
        }
      }, 60_000);
    }
  }
});
