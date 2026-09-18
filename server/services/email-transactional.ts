import { isDev } from '../config';
import { maskEmail } from '../utils/pii';
import {
  log,
  SENDGRID_API_KEY,
  FROM_EMAIL,
  FROM_NAME,
  dispatchMail,
  describeMailError,
  escapeHtml,
  replaceVariablesPlainText,
  sendTemplatedEmail,
} from './email-core';

/**
 * Resend a Square hosted-receipt link. Tries the DB-driven
 * 'payment_receipt_resend' template first, falling back to the
 * inline HTML below on fresh installs.
 */
export async function sendReceiptResendEmail(
  toEmail: string,
  context: {
    receiptUrl: string;
    receiptNumber?: string | null;
    amountCents: number;
    leagueName?: string | null;
    organizationName?: string | null;
  },
): Promise<boolean> {
  const dollars = (context.amountCents / 100).toFixed(2);

  const templateVars: Record<string, string> = {
    receipt_url: context.receiptUrl,
    receipt_number: context.receiptNumber || '',
    receipt_label: context.receiptNumber ? `(receipt #${context.receiptNumber})` : '',
    amount: `$${dollars}`,
    league_name: context.leagueName || 'your league',
    organization_name: context.organizationName || 'LeagueVault',
  };
  const sentViaTemplate = await sendTemplatedEmail(
    'payment_receipt_resend',
    toEmail,
    templateVars,
    { returnDetails: true },
  );
  if (typeof sentViaTemplate !== 'boolean' && sentViaTemplate.accepted) return true;
  if (typeof sentViaTemplate !== 'boolean' && sentViaTemplate.failureReason !== 'template_missing') return false;

  if (!SENDGRID_API_KEY) {
    log.error('Cannot send receipt resend — SENDGRID_API_KEY not configured');
    return false;
  }

  const safeUrl = escapeHtml(context.receiptUrl);
  const safeNumber = escapeHtml(context.receiptNumber || '');
  const safeLeague = escapeHtml(context.leagueName || 'your league');
  const safeOrg = escapeHtml(context.organizationName || 'LeagueVault');

  const msg = {
    to: toEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: replaceVariablesPlainText(
      'Your receipt for {{organization_name}}{{receipt_suffix}}',
      {
        organization_name: context.organizationName || 'LeagueVault',
        receipt_suffix: context.receiptNumber ? ` (#${context.receiptNumber})` : '',
      },
    ),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <p style="font-size: 16px; color: #333;">Hi,</p>
        <p style="font-size: 16px; color: #333;">
          Here is your receipt for the $${dollars} payment to
          <strong>${safeOrg}</strong> for ${safeLeague}${safeNumber ? ` (receipt #${safeNumber})` : ''}.
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${safeUrl}"
             style="background-color: #1a1a2e; color: #ffffff; padding: 14px 28px;
                    text-decoration: none; border-radius: 6px; font-size: 16px;
                    display: inline-block; font-weight: bold;">
            View Receipt
          </a>
        </div>
        <p style="font-size: 14px; color: #666;">
          If the button doesn't work, copy and paste this link into your browser:
        </p>
        <p style="font-size: 14px; color: #666; word-break: break-all;">
          <a href="${safeUrl}">${safeUrl}</a>
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="font-size: 12px; color: #999; text-align: center;">Powered by LeagueVault</p>
      </div>
    `,
    trackingSettings: { clickTracking: { enable: false, enableText: false } },
  };

  try {
    await dispatchMail(msg);
    log.info('Receipt resend sent to:', isDev ? toEmail : maskEmail(toEmail));
    return true;
  } catch (error) {
    log.error('Failed to send receipt resend:', describeMailError(error));
    return false;
  }
}
