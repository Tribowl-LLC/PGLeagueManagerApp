import sgMail from '@sendgrid/mail';
import type { MailDataRequired } from '@sendgrid/helpers/classes/mail';
import sanitizeHtml from 'sanitize-html';
import { storage } from '../storage';
import { env, isDev } from '../config';
import { createLogger } from '../logger';
import { maskEmail } from '../utils/pii';
import { captureEmail } from './_internal/email-outbox';

export const log = createLogger("Email");

// ---------------------------------------------------------------------------
// SendGrid dispatch guard (task #593).
//
// Every outbound message in this file flows through `dispatchMail` instead of
// calling `sgMail.send` directly. The dispatcher checks recipient domains
// against the configured `BLOCK_EMAIL_DOMAINS` list (default: `vitest.local`)
// and refuses to hand the message to SendGrid when every recipient is on
// that list. This stops integration tests — which create real users at
// `@vitest.local` — from generating SendGrid bounces that count against our
// daily quota and damage sender reputation.
//
// Why a domain block instead of a global "skip in tests" flag?
//   - The full email pipeline (template lookup, variable substitution,
//     HTML sanitization, From/To assembly) still runs, so a bug in any
//     of those layers still surfaces in tests exactly as it does today.
//   - A render/sanitize error throws *before* the guard short-circuits,
//     so it bubbles up to the test as a failure rather than being swallowed.
//   - Tests that want to assert on a captured email can use the helpers in
//     `server/services/_internal/email-outbox.ts` (`getCapturedEmails`,
//     `clearCapturedEmails`) without needing per-test `vi.mock` of SendGrid.
//
// To add another blocked domain, set `BLOCK_EMAIL_DOMAINS` in the env to a
// comma-separated list (e.g. `BLOCK_EMAIL_DOMAINS=vitest.local,example.test`).
// To disable the guard entirely (NOT recommended in dev/CI), set it to "".
// ---------------------------------------------------------------------------

type EmailAddress = string | { email: string; name?: string };
type Recipients = EmailAddress | EmailAddress[] | undefined;

function addressOf(entry: EmailAddress): string {
  return typeof entry === 'string' ? entry : entry.email;
}

function domainOf(entry: EmailAddress): string {
  const addr = addressOf(entry);
  const at = addr.lastIndexOf('@');
  return at < 0 ? '' : addr.slice(at + 1).toLowerCase();
}

interface PartitionResult {
  kept: EmailAddress[];
  dropped: EmailAddress[];
  droppedDomains: string[];
}

function partitionRecipients(field: Recipients, blocked: string[]): PartitionResult {
  if (field === undefined) return { kept: [], dropped: [], droppedDomains: [] };
  const list = Array.isArray(field) ? field : [field];
  const kept: EmailAddress[] = [];
  const dropped: EmailAddress[] = [];
  const droppedDomains: string[] = [];
  for (const entry of list) {
    const dom = domainOf(entry);
    if (dom && blocked.includes(dom)) {
      dropped.push(entry);
      if (!droppedDomains.includes(dom)) droppedDomains.push(dom);
    } else {
      kept.push(entry);
    }
  }
  return { kept, dropped, droppedDomains };
}

function rewriteRecipients(field: Recipients, kept: EmailAddress[]): Recipients {
  if (field === undefined) return undefined;
  if (kept.length === 0) return undefined;
  // Preserve the original shape: scalar in → scalar out (when only one
  // recipient remains AND the original was scalar), array in → array out.
  if (!Array.isArray(field) && kept.length === 1) return kept[0];
  return kept;
}

function describeSubject(msg: MailDataRequired): string {
  const s = msg.subject;
  return typeof s === 'string' ? s : '<no subject>';
}

export interface EmailDispatchResult {
  accepted: boolean;
  providerMessageId?: string | null;
  failureReason?: "not_configured" | "template_missing" | "provider_error" | "provider_rejected" | "provider_rate_limited" | "render_error";
}

export interface AccountEmailDeliveryCustomArgs {
  account_action_id: number | string;
  account_delivery_job_id: number | string;
}

export interface AccountGuidanceEmailDeliveryCustomArgs {
  account_guidance_job_id: number | string;
}

export type EmailDeliveryCustomArgs =
  | AccountEmailDeliveryCustomArgs
  | AccountGuidanceEmailDeliveryCustomArgs;

export interface EmailSendOptions {
  /** Only these validated, non-PII correlation fields may reach SendGrid custom_args. */
  customArgs?: EmailDeliveryCustomArgs;
  /** Return provider metadata while preserving boolean results for old callers. */
  returnDetails?: boolean;
}

function safeCorrelationId(value: number | string): string | null {
  const text = typeof value === 'number'
    ? Number.isSafeInteger(value) ? String(value) : ''
    : value.trim();
  if (!/^\d{1,12}$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? text : null;
}

/**
 * Convert durable job IDs to the string values required by SendGrid.
 * A partial or malformed correlation is dropped as a unit so arbitrary
 * provider custom arguments can never be smuggled through this shared sender.
 */
export function safeAccountEmailDeliveryCustomArgs(
  value: EmailDeliveryCustomArgs | undefined,
): { account_action_id: string; account_delivery_job_id: string } | { account_guidance_job_id: string } | undefined {
  if (!value) return undefined;
  if ('account_guidance_job_id' in value) {
    const jobId = safeCorrelationId(value.account_guidance_job_id);
    return jobId ? { account_guidance_job_id: jobId } : undefined;
  }
  const actionId = safeCorrelationId(value.account_action_id);
  const jobId = safeCorrelationId(value.account_delivery_job_id);
  return actionId && jobId
    ? { account_action_id: actionId, account_delivery_job_id: jobId }
    : undefined;
}

/** Guidance notices carry only their durable, non-secret job correlation. */
export function safeAccountGuidanceDeliveryCustomArgs(
  jobId: number,
): { account_guidance_job_id: string } | undefined {
  return Number.isSafeInteger(jobId) && jobId > 0 && jobId <= 999_999_999_999
    ? { account_guidance_job_id: String(jobId) }
    : undefined;
}

function providerMessageIdFromResponse(value: unknown): string | null {
  const response = Array.isArray(value) ? value[0] : value;
  if (!response || typeof response !== 'object') return null;
  const headers = (response as { headers?: unknown }).headers;
  if (!headers) return null;
  let headerValue: unknown;
  if (typeof headers === 'object' && headers !== null && 'get' in headers
    && typeof (headers as { get?: unknown }).get === 'function') {
    headerValue = (headers as { get(name: string): unknown }).get('x-message-id');
  } else if (typeof headers === 'object' && headers !== null) {
    const record = headers as Record<string, unknown>;
    headerValue = record['x-message-id'] ?? record['X-Message-Id'] ?? record['X-Message-ID'];
  }
  if (typeof headerValue !== 'string') return null;
  const id = headerValue.trim();
  return id.length > 0 && id.length <= 255 ? id : null;
}

async function sendToProvider(msg: MailDataRequired, isMultiple: boolean): Promise<EmailDispatchResult> {
  const response = await sgMail.send(msg, isMultiple);
  return { accepted: true, providerMessageId: providerMessageIdFromResponse(response) };
}

export function classifyEmailProviderFailure(error: unknown): "provider_rejected" | "provider_rate_limited" | "provider_error" {
  // SendGrid's SDK exposes HTTP status under response.statusCode. Keep this
  // classifier deliberately narrow and persist only a stable category, never
  // provider response bodies or reason text.
  if (!error || typeof error !== "object") return "provider_error";
  const response = (error as { response?: unknown }).response;
  const responseStatus = response && typeof response === "object"
    ? (response as { statusCode?: unknown }).statusCode
    : undefined;
  const directStatus = (error as { statusCode?: unknown }).statusCode;
  // @sendgrid/helpers ResponseError stores the HTTP status in `code` and
  // puts headers/body under `response`; accept only a bounded numeric code.
  const sdkCode = (error as { code?: unknown }).code;
  const status = typeof responseStatus === "number" ? responseStatus
    : typeof directStatus === "number" ? directStatus
      : typeof sdkCode === "number" ? sdkCode
        : undefined;
  if (status === 429) return "provider_rate_limited";
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500 && status !== 408) {
    return "provider_rejected";
  }
  return "provider_error";
}

export async function dispatchMail(msg: MailDataRequired, isMultiple = false): Promise<EmailDispatchResult> {
  // `?? []` defends against test files that vi.mock('../../server/config')
  // and forget to surface the new field — those mocks pre-date task #593.
  const blocked = env.BLOCK_EMAIL_DOMAINS ?? [];
  if (blocked.length === 0) {
    // Guard fully disabled — go straight to SendGrid.
    return sendToProvider(msg, isMultiple);
  }

  const to = partitionRecipients(msg.to, blocked);
  const cc = partitionRecipients(msg.cc, blocked);
  const bcc = partitionRecipients(msg.bcc, blocked);

  const totalRecipients = to.kept.length + to.dropped.length
    + cc.kept.length + cc.dropped.length
    + bcc.kept.length + bcc.dropped.length;
  const totalKept = to.kept.length + cc.kept.length + bcc.kept.length;
  const allBlocked = totalRecipients > 0 && totalKept === 0;
  const someBlocked = to.dropped.length + cc.dropped.length + bcc.dropped.length > 0;

  if (allBlocked) {
    const droppedDomains = Array.from(
      new Set([...to.droppedDomains, ...cc.droppedDomains, ...bcc.droppedDomains]),
    );
    captureEmail({
      msg: { ...msg },
      blockedDomains: droppedDomains,
      capturedAt: new Date(),
    });
    const sample = [...to.dropped, ...cc.dropped, ...bcc.dropped]
      .map((r) => maskEmail(addressOf(r)))
      .slice(0, 5)
      .join(', ');
    log.info(
      `Blocked SendGrid send to test-only domain(s) [${droppedDomains.join(', ')}] — captured in outbox. Subject: "${describeSubject(msg)}", recipients: ${sample}`,
    );
    return { accepted: true, providerMessageId: null };
  }

  if (someBlocked) {
    // Mixed recipient list. Rewrite each list to keep only the safe
    // recipients and forward the trimmed message. Never silently drop
    // a legitimate recipient — only the blocked ones go away.
    const rewritten: MailDataRequired = { ...msg };
    if (msg.to !== undefined) rewritten.to = rewriteRecipients(msg.to, to.kept);
    if (msg.cc !== undefined) rewritten.cc = rewriteRecipients(msg.cc, cc.kept);
    if (msg.bcc !== undefined) rewritten.bcc = rewriteRecipients(msg.bcc, bcc.kept);
    const droppedDomains = Array.from(
      new Set([...to.droppedDomains, ...cc.droppedDomains, ...bcc.droppedDomains]),
    );
    log.info(
      `Stripped blocked recipient(s) on domain(s) [${droppedDomains.join(', ')}] from SendGrid message. Subject: "${describeSubject(msg)}"`,
    );
    return sendToProvider(rewritten, isMultiple);
  }

  return sendToProvider(msg, isMultiple);
}

type SendgridLikeError = {
  response?: { body?: unknown };
  message?: string;
};

export function describeMailError(error: unknown): unknown {
  if (error && typeof error === 'object') {
    const e = error as SendgridLikeError;
    if (e.response?.body !== undefined) return e.response.body;
    if (typeof e.message === 'string') return e.message;
  }
  return error;
}

/** Safe metadata for account-action delivery logs; never includes provider bodies or messages. */
export function describeEmailDeliveryError(error: unknown): {
  kind: string;
  providerStatus?: number;
} {
  const providerStatus = error && typeof error === 'object'
    ? (error as { response?: { statusCode?: unknown } }).response?.statusCode
    : undefined;
  if (typeof providerStatus === 'number' && Number.isInteger(providerStatus)) {
    return { kind: 'provider_error', providerStatus };
  }
  if (error instanceof Error) return { kind: error.name || 'error' };
  return { kind: typeof error === 'object' && error !== null ? 'object_error' : typeof error };
}

// Account-ready notifications are user-triggered and may contain recipient
// addresses, template content, or provider response payloads in the thrown
// value. Keep this path deliberately bounded and metadata-only: the provider
// status is useful for operations, while response bodies and error messages
// are not safe to put in application logs.
function describeAccountReadyEmailError(error: unknown): {
  kind: string;
  providerStatus?: number;
} {
  const providerStatus = error && typeof error === 'object'
    ? (error as { response?: { statusCode?: unknown } }).response?.statusCode
    : undefined;
  if (typeof providerStatus === 'number' && Number.isInteger(providerStatus)) {
    return { kind: 'provider_error', providerStatus };
  }
  if (error instanceof Error) {
    return { kind: error.name || 'error' };
  }
  return { kind: typeof error === 'object' && error !== null ? 'object_error' : typeof error };
}

export const SENDGRID_API_KEY = env.SENDGRID_API_KEY;
// safe: APP_DOMAIN is normalised to lowercase at parse-time (task #335).
// The domain part of an email address is case-insensitive per RFC 5321
// §2.4, but we still want a canonical lowercase From: address so SPF /
// DKIM logs and bounce records read uniformly.
export const FROM_EMAIL = `noreply@${env.APP_DOMAIN}`;
export const FROM_NAME = 'Perfect Game';

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  log.info('SendGrid initialized');
}

export function getBaseUrl(
  orgOrSlug?: string | { subdomain?: string | null; slug?: string | null } | null,
): string {
  // All emailed links use the deployment's canonical host.  Organization
  // subdomains are tenant selectors only when the request middleware has
  // explicitly enabled them; production singleton deployments reject those
  // hosts with HTTP 421.  Using a canonical link keeps registration,
  // password recovery, and profile-claim reporting reachable in every
  // supported deployment.  The trusted organization argument remains part
  // of the API for callers that need organization metadata for templates,
  // but it is never interpolated into a host here.
  void orgOrSlug;
  return `https://${env.APP_DOMAIN}`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function replaceVariables(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] !== undefined ? escapeHtml(variables[key]) : match;
  });
}

export function replaceVariablesPlainText(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    // Subjects are handed to SendGrid as mail headers. Keep their normal
    // human-readable form, but remove header-breaking control characters from
    // values that originate in user or organization data.
    return variables[key] !== undefined
      ? variables[key].replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
      : match;
  }).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ');
}

export function sanitizeTemplateBody(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'a',
      'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'span', 'div',
      'table', 'thead', 'tbody', 'tr', 'td', 'th',
      'img', 'hr', 'blockquote', 'pre', 'code',
    ],
    allowedAttributes: {
      'a': ['href', 'target', 'rel'],
      'img': ['src', 'alt', 'width', 'height'],
      'td': ['align', 'valign', 'width', 'style'],
      'th': ['align', 'valign', 'width', 'style'],
      'table': ['width', 'cellpadding', 'cellspacing', 'border', 'style'],
      'tr': ['style'],
      'div': ['style'],
      'span': ['style'],
      'p': ['style'],
      'h1': ['style'],
      'h2': ['style'],
      'h3': ['style'],
      'h4': ['style'],
      'h5': ['style'],
      'h6': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    disallowedTagsMode: 'discard',
  });
}

export function getOrgLogoUrl(org: { slug: string } | null | undefined): string {
  if (!org?.slug) return '';
  const baseUrl = getBaseUrl();
  return `${baseUrl}/api/organizations/slug/${org.slug}/logo`;
}

export type EmailNotification = 'accepted' | 'not_sent';

export interface AccountReadyEmailOptions {
  toEmail: string;
  toName: string;
  bowlerName: string;
  organization: {
    name?: string | null;
    slug?: string | null;
    subdomain?: string | null;
    logo?: string | null;
  } | null;
  leagueName?: string;
  teamName?: string;
}

export interface ProfileClaimNotificationEmailOptions {
  toEmail: string;
  toName: string;
  bowlerName: string;
  organizationName?: string | null;
  reportUrl: string;
  /** Include the account-ready sign-in section when both notices share a mailbox. */
  includeAccountReady?: boolean;
  loginUrl?: string;
  dashboardUrl?: string;
}

/**
 * Notify the address that was on a roster before an account was linked to
 * that profile. This sender never derives its recipient from the current user
 * row; the durable job owns the immutable recipient snapshot.
 */
export async function sendProfileClaimNotificationEmail(
  options: ProfileClaimNotificationEmailOptions,
): Promise<EmailDispatchResult> {
  const variables = {
    user_name: options.toName,
    bowler_name: options.bowlerName,
    organization_name: options.organizationName ?? "your league",
    report_link: options.reportUrl,
    login_link: options.loginUrl ?? "",
    dashboard_link: options.dashboardUrl ?? options.loginUrl ?? "",
  };
  const templated = await sendTemplatedEmail(
    options.includeAccountReady ? "profile_claim_account_ready" : "profile_claim_notification",
    options.toEmail,
    variables,
    { returnDetails: true },
  );
  if (templated.accepted || templated.failureReason !== "template_missing") return templated;

  if (!SENDGRID_API_KEY) return { accepted: false, failureReason: "not_configured" };
  try {
    const safeName = escapeHtml(options.toName || "there");
    const safeBowler = escapeHtml(options.bowlerName || "your roster profile");
    const safeOrganization = escapeHtml(options.organizationName || "your league");
    const safeReport = escapeHtml(options.reportUrl);
    const safeLogin = escapeHtml(options.loginUrl || "");
    const safeDashboard = escapeHtml(options.dashboardUrl || options.loginUrl || "");
    const accountReadySection = options.includeAccountReady
      ? `<p>Your LeagueVault account is ready. <a href="${safeLogin}">Sign in</a> or open your <a href="${safeDashboard}">bowler dashboard</a>.</p>`
      : "";
    const html = wrapInHtmlLayout(sanitizeTemplateBody(`
      <p>Hi ${safeName},</p>
      <p>An account was connected to <strong>${safeBowler}</strong> in ${safeOrganization}.</p>
      ${accountReadySection}
      <p>If you did not make or authorize this connection, use the secure report link below:</p>
      <p><a href="${safeReport}">This wasn't me</a></p>
      <p>If you recognize this activity, no action is needed.</p>
    `), variables);
    return dispatchMail({
      to: options.toEmail,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: "A LeagueVault profile was connected",
      html,
      trackingSettings: { clickTracking: { enable: false, enableText: false } },
    });
  } catch (error) {
    log.error("Profile-claim notification fallback failed:", describeEmailDeliveryError(error));
    return { accepted: false, failureReason: classifyEmailProviderFailure(error) };
  }
}

/**
 * Notify an ordinary user after their first account-to-bowler link commits.
 *
 * The template decision is deliberately made before dispatching anything:
 * an active `admin_claim_complete` template is used as-is, a missing template
 * selects the built-in message, and an explicitly inactive template is a
 * deliberate no-op. Once dispatch starts, a failure is reported as
 * `not_sent`; the fallback is never attempted after an uncertain provider
 * result, which prevents duplicate messages.
 */
export async function sendAccountReadyEmail(
  options: AccountReadyEmailOptions,
): Promise<EmailNotification> {
  let template: Awaited<ReturnType<typeof storage.getEmailTemplateBySlug>>;
  try {
    template = await storage.getEmailTemplateBySlug('admin_claim_complete');
  } catch (error) {
    log.error('Failed to resolve account-ready email template:', describeAccountReadyEmailError(error));
    return 'not_sent';
  }
  if (template && !template.active) {
    log.info("Template 'admin_claim_complete' is inactive, skipping account-ready email");
    return 'not_sent';
  }

  if (!SENDGRID_API_KEY) {
    log.error('Cannot send account-ready email — SENDGRID_API_KEY not configured');
    return 'not_sent';
  }

  const baseUrl = getBaseUrl(options.organization);
  const loginUrl = `${baseUrl}/login`;
  const variables: Record<string, string> = {
    user_name: options.toName,
    bowler_name: options.bowlerName,
    league_name: options.leagueName ?? '',
    team_name: options.teamName ?? '',
    organization_name: options.organization?.name ?? '',
    organization_logo_url:
      options.organization?.slug && options.organization.logo
        ? getOrgLogoUrl({ slug: options.organization.slug })
        : '',
    // Keep both historical link variable names server-derived. The active
    // admin template uses `dashboard_link` for its existing dashboard CTA,
    // while the new account-ready sign-in CTA uses `login_link`.
    login_link: loginUrl,
    dashboard_link: `${baseUrl}/bowler-dashboard`,
  };

  try {
    let msg: MailDataRequired;
    if (template) {
      const subject = replaceVariablesPlainText(template.subject, variables);
      const body = replaceVariables(template.body, variables);
      msg = {
        to: options.toEmail,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject,
        html: wrapInHtmlLayout(sanitizeTemplateBody(body), variables),
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
        },
      };
    } else {
      // Missing templates can occur on older installations before the seed
      // migration has run. Keep the fallback intentionally free of credentials,
      // tokens, and payment amounts.
      const safeName = escapeHtml(options.toName || 'there');
      const safeOrganization = escapeHtml(options.organization?.name || 'your organization');
      const safeLoginUrl = escapeHtml(loginUrl);
      const fallbackBody = `
        <p style="font-size: 16px; color: #333;">Hi ${safeName},</p>
        <p style="font-size: 16px; color: #333;">
          Your LeagueVault account is connected to your bowler profile in
          <strong>${safeOrganization}</strong>. Sign in to view your leagues and
          pay available balances.
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${safeLoginUrl}"
             style="background-color: #1a1a2e; color: #ffffff; padding: 14px 28px;
                    text-decoration: none; border-radius: 6px; font-size: 16px;
                    display: inline-block; font-weight: bold;">
            Sign in to LeagueVault
          </a>
        </div>
        <p style="font-size: 14px; color: #666; word-break: break-all;">
          If the button doesn't work, sign in here: <a href="${safeLoginUrl}">${safeLoginUrl}</a>
        </p>
      `;
      msg = {
        to: options.toEmail,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: 'Your LeagueVault account is ready',
        html: wrapInHtmlLayout(sanitizeTemplateBody(fallbackBody), variables),
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
        },
      };
    }

    await dispatchMail(msg);
    log.info('Account-ready email accepted by provider');
    return 'accepted';
  } catch (error) {
    log.error('Account-ready email render or dispatch failed:', describeAccountReadyEmailError(error));
    return 'not_sent';
  }
}

function convertLinksToButtons(html: string): string {
  return html.replace(
    /^\s*(https?:\/\/[^\s<]+)\s*$/gm,
    (_match, url) => {
      const safeUrl = escapeHtml(url);
      let label = 'Click Here';
      if (url.includes('/set-password')) label = 'Set Up Your Password';
      else if (url.includes('/bowler-dashboard') || url.includes('/dashboard')) label = 'Go to Dashboard';
      else if (url.includes('/login')) label = 'Log In';
      else if (url.includes('/claim')) label = 'Claim Your Profile';

      return `<div style="margin: 20px 0;"><a href="${safeUrl}" style="display: inline-block; background-color: #1a1a2e; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: bold;">${label}</a></div>`;
    }
  );
}

export function wrapInHtmlLayout(body: string, variables: Record<string, string>): string {
  const styledBody = convertLinksToButtons(body);

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      
      <div style="font-size: 16px; color: #333; white-space: pre-line;">
${styledBody}
      </div>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
      
      <p style="font-size: 12px; color: #999; text-align: center;">
        Powered by LeagueVault
      </p>
    </div>
  `;
}

function formatEmailResult(
  result: EmailDispatchResult | undefined,
  options: EmailSendOptions | undefined,
): boolean | EmailDispatchResult {
  // A few long-lived integrations mock `dispatchMail` as a void function.
  // Preserve that historical behavior while the real dispatcher returns
  // provider metadata.
  const normalized = result && typeof result.accepted === 'boolean'
    ? result
    : { accepted: true };
  return options?.returnDetails ? normalized : normalized.accepted;
}

export function sendTemplatedEmail(
  slug: string,
  toEmail: string | string[],
  variables: Record<string, string>,
): Promise<boolean>;
export function sendTemplatedEmail(
  slug: string,
  toEmail: string | string[],
  variables: Record<string, string>,
  options: EmailSendOptions & { returnDetails: true },
): Promise<EmailDispatchResult>;
export function sendTemplatedEmail(
  slug: string,
  toEmail: string | string[],
  variables: Record<string, string>,
  options: EmailSendOptions,
): Promise<boolean | EmailDispatchResult>;
export async function sendTemplatedEmail(
  slug: string,
  toEmail: string | string[],
  variables: Record<string, string>,
  options?: EmailSendOptions,
): Promise<boolean | EmailDispatchResult> {
  if (!SENDGRID_API_KEY) {
    log.error('Cannot send email — SENDGRID_API_KEY not configured');
    return formatEmailResult({ accepted: false, failureReason: "not_configured" }, options);
  }

  try {
    const template = await storage.getEmailTemplateBySlug(slug);
    if (!template || !template.active) {
      log.info(`Template '${slug}' not found or inactive, skipping`);
      // Preserve the long-standing bootstrap contract: a missing or inactive
      // editable template lets the sender use its built-in fallback. Account-
      // ready notifications intentionally handle inactive templates before
      // reaching this generic helper and remain a deliberate no-op.
      return formatEmailResult({ accepted: false, failureReason: "template_missing" }, options);
    }

    const subject = replaceVariablesPlainText(template.subject, variables);
    const body = replaceVariables(template.body, variables);
    const html = wrapInHtmlLayout(sanitizeTemplateBody(body), variables);

    const customArgs = safeAccountEmailDeliveryCustomArgs(options?.customArgs);
    const msg = {
      to: toEmail,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      html,
      ...(customArgs ? { customArgs } : {}),
      trackingSettings: {
        clickTracking: { enable: false, enableText: false },
      },
    };

    const result = await dispatchMail(msg);
    if (customArgs) {
      // Recovery sends carry only the non-PII action/job correlation in logs;
      // the recipient address is intentionally absent even in masked form.
      log.info(`Templated email '${slug}' sent`, customArgs);
    } else if (options?.customArgs) {
      // Never fall back to a recipient log when a caller intended a recovery
      // correlation but supplied malformed IDs.
      log.info(`Templated email '${slug}' sent`, { deliveryCorrelation: "invalid" });
    } else {
      const recipient = Array.isArray(toEmail)
        ? `${toEmail.length} recipient(s)`
        : maskEmail(toEmail);
      log.info(`Templated email '${slug}' sent to:`, recipient);
    }
    return formatEmailResult(result, options);
  } catch (error) {
    log.error(`Failed to send templated email '${slug}':`, describeEmailDeliveryError(error));
    return formatEmailResult({ accepted: false, failureReason: classifyEmailProviderFailure(error) }, options);
  }
}
