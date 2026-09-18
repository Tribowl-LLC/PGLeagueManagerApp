/**
 * Unit tests for the SendGrid dispatch guard added in task #593.
 *
 * Verifies that `server/services/email.ts` refuses to hand messages to
 * `sgMail.send` when every recipient is on the configured
 * `BLOCK_EMAIL_DOMAINS` list (default: `vitest.local`), while still
 * running the full template/sanitize/assemble pipeline so any bug in
 * those layers continues to surface in tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectErrorLog } from '../helpers/expected-error-logs';

type SendArgs = [
  msg: {
    to?: string | string[] | { email: string } | { email: string }[];
    cc?: string | string[] | { email: string } | { email: string }[];
    bcc?: string | string[] | { email: string } | { email: string }[];
    subject?: string;
    html?: string;
    text?: string;
  },
  isMultiple?: boolean,
];

const sendMock = vi.fn<(...args: SendArgs) => Promise<void>>(async () => {});

vi.mock('@sendgrid/mail', () => ({
  default: {
    setApiKey: vi.fn(),
    send: (...a: SendArgs) => sendMock(...a),
  },
}));

vi.mock('../../server/config', () => ({
  env: {
    SENDGRID_API_KEY: 'sg-test',
    APP_DOMAIN: 'leaguevault.test',
    BLOCK_EMAIL_DOMAINS: ['vitest.local'],
  },
  isDev: false,
  isProdLike: false,
}));

vi.mock('../../server/storage', () => ({
  storage: {
    // sendTemplatedEmail looks up the template by slug. Returning
    // undefined/inactive short-circuits before the dispatcher runs,
    // which would defeat the test — return a real-looking template
    // so the full render path executes.
    getEmailTemplateBySlug: vi.fn(async (slug: string) => ({
      slug,
      subject: 'Hello {{bowler_name}}',
      body: '<p>Hi {{bowler_name}}, click {{invite_link}}</p>',
      active: true,
    })),
  },
}));

vi.mock('../../server/utils/pii', () => ({ maskEmail: (e: string) => e }));

import {
  getCapturedEmails,
  clearCapturedEmails,
} from '../../server/services/_internal/email-outbox';

beforeEach(() => {
  sendMock.mockClear();
  clearCapturedEmails();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('dispatchMail (task #593) — recipient-domain guard', () => {
  it('does NOT call sgMail.send when every recipient is on the blocked list', async () => {
    const { sendDeletionRequestNotification } = await import(
      '../../server/services/email'
    );
    const ok = await sendDeletionRequestNotification(
      ['admin@vitest.local', 'compliance@vitest.local'],
      {
        id: 1,
        email: 'user@vitest.local',
        reason: 'wants out',
        createdAt: '2026-04-29T10:00:00Z',
      },
    );
    expect(ok).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('DOES call sgMail.send when no recipient is on the blocked list', async () => {
    const { sendDeletionRequestNotification } = await import(
      '../../server/services/email'
    );
    const ok = await sendDeletionRequestNotification(
      ['admin@example.com', 'compliance@example.com'],
      {
        id: 2,
        email: 'user@example.com',
        reason: null,
        createdAt: '2026-04-29T10:00:00Z',
      },
    );
    expect(ok).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0][0];
    expect(msg.to).toEqual(['admin@example.com', 'compliance@example.com']);
  });

  it('rewrites a mixed-recipient message so only safe recipients reach SendGrid', async () => {
    const { sendDeletionRequestNotification } = await import(
      '../../server/services/email'
    );
    const ok = await sendDeletionRequestNotification(
      ['admin@example.com', 'leak@vitest.local', 'compliance@example.com'],
      {
        id: 3,
        email: 'user@example.com',
        reason: null,
        createdAt: '2026-04-29T10:00:00Z',
      },
    );
    expect(ok).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0][0];
    expect(msg.to).toEqual(['admin@example.com', 'compliance@example.com']);
    // The blocked address must NOT have leaked into the SendGrid call.
    expect(JSON.stringify(msg)).not.toContain('leak@vitest.local');
  });

  it('still throws on a render/sanitize error even when the recipient would be blocked', async () => {
    // The render/sanitize failure is logged at [ERROR] before it rethrows.
    expectErrorLog(/Failed to send templated email 'bulk_invite':/);
    // Force the template lookup to throw — the dispatcher must NEVER
    // see this message because the render pipeline aborts first. This
    // pins the contract that a bug in templating/rendering still
    // surfaces in tests instead of being silently swallowed by the
    // domain guard.
    const storageMod = await import('../../server/storage');
    const spy = vi
      .spyOn(storageMod.storage, 'getEmailTemplateBySlug')
      .mockRejectedValueOnce(new Error('template lookup boom'));

    const { sendTemplatedEmail } = await import('../../server/services/email');
    // sendTemplatedEmail catches and returns false on render failure
    // (current shape of the helper), so the contract we pin is:
    //   - the failure path executed (storage was hit and threw)
    //   - SendGrid was NOT called
    //   - nothing was captured to the outbox (the message never
    //     reached the dispatch step)
    const ok = await sendTemplatedEmail('bulk_invite', 'someone@vitest.local', {
      bowler_name: 'Pat',
      invite_link: 'https://example.test/x',
    });
    expect(ok).toBe(false);
    expect(spy).toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(getCapturedEmails()).toHaveLength(0);
    spy.mockRestore();
  });

  it('captures blocked sends in the outbox and clearCapturedEmails empties it', async () => {
    const { sendTemplatedEmail } = await import('../../server/services/email');
    const ok = await sendTemplatedEmail('bulk_invite', 'pat@vitest.local', {
      bowler_name: 'Pat',
      invite_link: 'https://example.test/invite/abc',
    });
    expect(ok).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();

    const captured = getCapturedEmails();
    expect(captured).toHaveLength(1);
    expect(captured[0].blockedDomains).toEqual(['vitest.local']);
    const msg = captured[0].msg as {
      to: string;
      from: { email: string; name?: string };
      subject: string;
      html: string;
    };
    expect(msg.to).toBe('pat@vitest.local');
    expect(msg.from).toEqual({ email: 'noreply@leaguevault.test', name: 'Perfect Game' });
    // Subject and body went through the variable-substitution pass.
    expect(msg.subject).toContain('Pat');
    expect(msg.html).toContain('Pat');
    expect(msg.html).toContain('https://example.test/invite/abc');

    clearCapturedEmails();
    expect(getCapturedEmails()).toHaveLength(0);
  });
});
