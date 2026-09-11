/**
 * Security regression test for the raw-HTML fallback auth emails in
 * `server/services/email-auth.ts` (P2 — HTML injection).
 *
 * `sendInviteEmail` and `sendPasswordResetFallbackEmail` assemble
 * their HTML by string interpolation when the SendGrid *template*
 * path is unavailable. Before this fix they spliced the
 * user-controlled `userName` and org-controlled `organizationName`
 * (and the URL) into the markup unescaped, so a display name like
 * `<img src=x onerror=...>` would land as live HTML in an outbound
 * security email.
 *
 * These tests force the fallback path (templated send returns false)
 * and assert that a malicious `userName` / `organizationName` is
 * rendered HTML-escaped in BOTH senders. The real `escapeHtml` is
 * kept; only the SendGrid dispatch + template lookup are mocked so we
 * can capture the assembled HTML.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatched: Array<{ html: string; customArgs?: Record<string, string> }> = [];
const infoLogs: unknown[][] = [];
const mockDispatchMail = vi.fn(async (msg: { html: string; customArgs?: Record<string, string> }): Promise<unknown> => {
  dispatched.push(msg);
  return undefined;
});
// Force the raw-HTML fallback branch: the templated send "fails".
const mockSendTemplatedEmail = vi.fn(async () => false);

vi.mock('../../server/services/email-core', async (importActual) => {
  const actual = await importActual<typeof import('../../server/services/email-core')>();
  return {
    ...actual,
    // Truthy key so the fallback senders proceed past their
    // `if (!SENDGRID_API_KEY)` guard.
    SENDGRID_API_KEY: 'SG.test-key',
    FROM_EMAIL: 'noreply@test.example',
    FROM_NAME: 'LeagueVault',
    getBaseUrl: () => 'https://test.example',
    log: {
      info: (...args: unknown[]) => { infoLogs.push(args); },
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    sendTemplatedEmail: (...a: unknown[]) => mockSendTemplatedEmail.apply(null, a as never),
    dispatchMail: (...a: unknown[]) => mockDispatchMail.apply(null, a as never),
    // escapeHtml / describeMailError / log / getOrgLogoUrl come from `actual`.
  };
});

// email-auth imports `storage` (used only when organizationId is
// passed). Stub it so the module loads without a DB connection.
vi.mock('../../server/storage', () => ({
  storage: { getOrganization: vi.fn(async () => undefined) },
}));

const { sendInviteEmail, sendPasswordResetFallbackEmail } = await import(
  '../../server/services/email-auth'
);

const XSS = '<img src=x onerror="alert(1)">';
const XSS_ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;';

beforeEach(() => {
  dispatched.length = 0;
  infoLogs.length = 0;
  mockDispatchMail.mockClear();
  mockSendTemplatedEmail.mockClear();
  mockSendTemplatedEmail.mockResolvedValue(false);
});

describe('email-auth fallback senders — HTML injection guard', () => {
  it('sendInviteEmail escapes a malicious userName and organizationName in the fallback HTML', async () => {
    const ok = await sendInviteEmail(
      'recipient@test.example',
      XSS,
      'invite-token-123',
      '<b>EvilOrg</b>',
    );

    expect(ok).toBe(true);
    // We must have gone through the raw-HTML fallback, not the template.
    expect(mockSendTemplatedEmail).toHaveBeenCalledTimes(1);
    expect(mockDispatchMail).toHaveBeenCalledTimes(1);

    const { html } = dispatched[0];
    // The raw payload must NOT appear verbatim …
    expect(html).not.toContain('<img src=x onerror=');
    expect(html).not.toContain('<b>EvilOrg</b>');
    // … it must appear escaped instead.
    expect(html).toContain(XSS_ESCAPED);
    expect(html).toContain('&lt;b&gt;EvilOrg&lt;/b&gt;');
  });

  it('sendPasswordResetFallbackEmail escapes a malicious userName in the fallback HTML', async () => {
    const ok = await sendPasswordResetFallbackEmail(
      'recipient@test.example',
      XSS,
      'reset-token-456',
    );

    expect(ok).toBe(true);
    expect(mockDispatchMail).toHaveBeenCalledTimes(1);

    const { html } = dispatched[0];
    expect(html).not.toContain('<img src=x onerror=');
    expect(html).toContain(XSS_ESCAPED);
  });

  it('adds only string action/job correlation IDs and returns provider metadata on request', async () => {
    mockDispatchMail.mockImplementationOnce(async (msg: { html: string; customArgs?: Record<string, string> }): Promise<unknown> => {
      dispatched.push(msg);
      return { accepted: true, providerMessageId: 'sg-message-fixture' };
    });

    const result = await sendPasswordResetFallbackEmail(
      'recipient@test.example',
      'there',
      'reset-token-789',
      null,
      {
        returnDetails: true,
        customArgs: { account_action_id: 41, account_delivery_job_id: 7 },
      },
    );

    expect(result).toEqual({ accepted: true, providerMessageId: 'sg-message-fixture' });
    expect(dispatched[0]?.customArgs).toEqual({
      account_action_id: '41',
      account_delivery_job_id: '7',
    });
    expect(JSON.stringify(infoLogs)).toContain('account_action_id');
    expect(JSON.stringify(infoLogs)).toContain('account_delivery_job_id');
    expect(JSON.stringify(infoLogs)).not.toContain('recipient@test.example');
  });
});
