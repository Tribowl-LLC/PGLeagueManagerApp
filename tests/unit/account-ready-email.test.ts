import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn<(message: Record<string, unknown>) => Promise<void>>(
  async () => undefined,
);
const getTemplateMock = vi.fn();
const errorLog = vi.fn();

vi.mock('@sendgrid/mail', () => ({
  default: {
    setApiKey: vi.fn(),
    send: (message: Record<string, unknown>) => sendMock(message),
  },
}));

vi.mock('../../server/config', () => ({
  env: {
    SENDGRID_API_KEY: 'sg-test',
    APP_DOMAIN: 'leaguevault.test',
    BLOCK_EMAIL_DOMAINS: [],
  },
  isDev: false,
}));

vi.mock('../../server/storage', () => ({
  storage: {
    getEmailTemplateBySlug: (slug: string) => getTemplateMock(slug),
  },
}));

vi.mock('../../server/utils/pii', () => ({ maskEmail: (email: string) => email }));
vi.mock('../../server/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => errorLog(...args),
    debug: vi.fn(),
  }),
}));

const { sendAccountReadyEmail } = await import('../../server/services/email-core');

const options = {
  toEmail: 'bowler@example.com',
  toName: 'Alex Bowler',
  bowlerName: 'Alex Bowler',
  organization: {
    name: 'Perfect Game',
    slug: 'internal-perfect-game',
    subdomain: 'perfect-game',
    logo: null,
  },
  leagueName: 'Wednesday Night',
  teamName: 'Lane 4',
};

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue(undefined);
  getTemplateMock.mockReset();
  getTemplateMock.mockResolvedValue(undefined);
  errorLog.mockReset();
});

describe('sendAccountReadyEmail', () => {
  it('uses the built-in account-ready message when the template is missing', async () => {
    await expect(sendAccountReadyEmail(options)).resolves.toBe('accepted');

    expect(getTemplateMock).toHaveBeenCalledWith('admin_claim_complete');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const message = sendMock.mock.calls[0][0];
    expect(message.subject).toBe('Your LeagueVault account is ready');
    expect(message.html).toContain('account is connected');
    expect(message.html).toContain('view your leagues');
    expect(message.html).toContain('pay available balances');
    expect(message.html).toContain('https://perfect-game.leaguevault.test/login');
    expect(message.html).not.toContain('password');
    expect(message.html).not.toContain('token');
    expect(message.html).not.toContain('amount');
  });

  it('uses the active template with server-resolved tenant links', async () => {
    getTemplateMock.mockResolvedValue({
      slug: 'admin_claim_complete',
      active: true,
      subject: 'Ready for {{organization_name}}',
      body: 'Dashboard: {{dashboard_link}}; sign in: {{login_link}}',
    });

    await expect(sendAccountReadyEmail(options)).resolves.toBe('accepted');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const message = sendMock.mock.calls[0][0];
    expect(message.subject).toBe('Ready for Perfect Game');
    expect(message.html).toContain('https://perfect-game.leaguevault.test/login');
    expect(message.html).toContain('https://perfect-game.leaguevault.test/bowler-dashboard');
    expect(message.html).not.toContain('internal-perfect-game.leaguevault.test');
  });

  it('does not dispatch when the template is explicitly inactive', async () => {
    getTemplateMock.mockResolvedValue({
      slug: 'admin_claim_complete',
      active: false,
      subject: 'Disabled',
      body: 'Disabled',
    });

    await expect(sendAccountReadyEmail(options)).resolves.toBe('not_sent');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does not fallback-send after a provider dispatch failure', async () => {
    const privateProviderMessage = 'provider-secret-response';
    const privateRecipient = 'private-recipient@example.test';
    sendMock.mockRejectedValueOnce({
      message: privateProviderMessage,
      response: {
        statusCode: 503,
        body: { recipient: privateRecipient, detail: privateProviderMessage },
      },
    });

    await expect(sendAccountReadyEmail(options)).resolves.toBe('not_sent');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toContain(privateProviderMessage);
    expect(logged).not.toContain(privateRecipient);
  });
});
