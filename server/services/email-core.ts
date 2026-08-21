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

export async function dispatchMail(msg: MailDataRequired, isMultiple = false): Promise<void> {
  // `?? []` defends against test files that vi.mock('../../server/config')
  // and forget to surface the new field — those mocks pre-date task #593.
  const blocked = env.BLOCK_EMAIL_DOMAINS ?? [];
  if (blocked.length === 0) {
    // Guard fully disabled — go straight to SendGrid.
    await sgMail.send(msg, isMultiple);
    return;
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
    return;
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
    await sgMail.send(rewritten, isMultiple);
    return;
  }

  await sgMail.send(msg, isMultiple);
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

export const SENDGRID_API_KEY = env.SENDGRID_API_KEY;
// safe: APP_DOMAIN is normalised to lowercase at parse-time (task #335).
// The domain part of an email address is case-insensitive per RFC 5321
// §2.4, but we still want a canonical lowercase From: address so SPF /
// DKIM logs and bounce records read uniformly.
export const FROM_EMAIL = `noreply@${env.APP_DOMAIN}`;
export const FROM_NAME = 'LeagueVault';

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  log.info('SendGrid initialized');
}

export function getBaseUrl(
  orgOrSlug?: string | { subdomain?: string | null; slug?: string | null } | null,
): string {
  // Prefer the org's `subdomain` field (the actual DNS host) over `slug`
  // (an internal identifier that may contain hyphens not present in DNS).
  // Falls back to slug for legacy orgs that haven't been assigned a
  // subdomain yet.
  let host: string | null | undefined;
  if (typeof orgOrSlug === 'string') {
    host = orgOrSlug;
  } else if (orgOrSlug) {
    host = orgOrSlug.subdomain || orgOrSlug.slug || null;
  }
  // safe: APP_DOMAIN is normalised to lowercase at parse-time (task #335).
  // Hostnames in URLs are case-insensitive but we want a canonical
  // lowercase URL in outgoing emails so links don't look mangled.
  if (host) {
    return `https://${host}.${env.APP_DOMAIN}`;
  }
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
    return variables[key] !== undefined ? variables[key] : match;
  });
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

export async function sendTemplatedEmail(
  slug: string,
  toEmail: string,
  variables: Record<string, string>
): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    log.error('Cannot send email — SENDGRID_API_KEY not configured');
    return false;
  }

  try {
    const template = await storage.getEmailTemplateBySlug(slug);
    if (!template || !template.active) {
      log.info(`Template '${slug}' not found or inactive, skipping`);
      return false;
    }

    const subject = replaceVariablesPlainText(template.subject, variables);
    const body = replaceVariables(template.body, variables);
    const html = wrapInHtmlLayout(sanitizeTemplateBody(body), variables);

    const msg = {
      to: toEmail,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      html,
      trackingSettings: {
        clickTracking: { enable: false, enableText: false },
      },
    };

    await dispatchMail(msg);
    log.info(`Templated email '${slug}' sent to:`, isDev ? toEmail : maskEmail(toEmail));
    return true;
  } catch (error) {
    log.error(`Failed to send templated email '${slug}':`, describeMailError(error));
    return false;
  }
}
