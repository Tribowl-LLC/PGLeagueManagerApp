/** Runtime drift guards for the Square and SendGrid integrations. */
import { createLogger } from '../logger';
import { registerThirdPartyPin, makeDefaultPinOnResult, type PinProbeResult } from './third-party-pin-verifier';
import './square-provider';

const log = createLogger('ThirdPartyPins');
const SENDGRID_EXPECTED_MAJOR = 8;
const SENDGRID_EXPECTED_BASE_URL = 'https://api.sendgrid.com/';
const SENDGRID_EXPECTED_PIN = `${SENDGRID_EXPECTED_MAJOR}|${SENDGRID_EXPECTED_BASE_URL}`;

registerThirdPartyPin({
  provider: 'sendgrid',
  pinName: 'SDK major + API base URL',
  expected: SENDGRID_EXPECTED_PIN,
  probe: async (): Promise<PinProbeResult> => {
    try {
      const sgMailPkg = await import('@sendgrid/mail/package.json', { with: { type: 'json' } });
      const version: unknown = (sgMailPkg as { default?: { version?: unknown }; version?: unknown }).default?.version
        ?? (sgMailPkg as { version?: unknown }).version;
      if (typeof version !== 'string') return { ok: true, actual: undefined, reason: 'no-captured-request' };
      const majorMatch = /^(\d+)\./.exec(version);
      if (!majorMatch) return { ok: false, actual: version, reason: 'drift' };
      const major = Number(majorMatch[1]);

      type SgMailLike = { client?: { defaultRequest?: { baseUrl?: unknown } } };
      const sgMailModule = (await import('@sendgrid/mail')) as SgMailLike | { default?: SgMailLike };
      const sgMail = (sgMailModule as { default?: SgMailLike }).default ?? (sgMailModule as SgMailLike);
      const baseUrlRaw = sgMail.client?.defaultRequest?.baseUrl;
      const baseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw : undefined;
      const actual = `${major}|${baseUrl ?? 'unknown'}`;

      if (major !== SENDGRID_EXPECTED_MAJOR || baseUrl !== SENDGRID_EXPECTED_BASE_URL) {
        return { ok: false, actual, reason: 'drift' };
      }
      return { ok: true, actual };
    } catch (err) {
      log.warn('SendGrid pin probe could not read SDK metadata', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: true, actual: undefined, reason: 'no-captured-request' };
    }
  },
  runbook: 'docs/third-party-pins.md#sendgrid',
  onResult: makeDefaultPinOnResult({
    loggerName: 'Email',
    runbook: 'docs/third-party-pins.md#sendgrid',
    remediation: 'Pin `@sendgrid/mail` back to the audited major (^8), or review all send sites before updating the pin and audit documentation.',
  }),
});
