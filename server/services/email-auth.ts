import { storage } from '../storage';
import { isDev } from '../config';
import { maskEmail } from '../utils/pii';
import { pickPasswordChangedLocale } from './email-i18n/password-changed';
import { pickAccountLockoutLocale } from './email-i18n/account-lockout';
import {
  log,
  SENDGRID_API_KEY,
  FROM_EMAIL,
  FROM_NAME,
  dispatchMail,
  describeMailError,
  describeEmailDeliveryError,
  escapeHtml,
  getBaseUrl,
  getOrgLogoUrl,
  sendTemplatedEmail,
  safeAccountEmailDeliveryCustomArgs,
  type EmailDispatchResult,
  type EmailSendOptions,
} from './email-core';

function emailReturnValue(
  value: EmailDispatchResult | undefined,
  options: EmailSendOptions | undefined,
): boolean | EmailDispatchResult {
  const normalized = value && typeof value.accepted === 'boolean'
    ? value
    : { accepted: true };
  return options?.returnDetails ? normalized : normalized.accepted;
}

export async function sendInviteEmail(
  toEmail: string,
  userName: string,
  inviteToken: string,
  organizationName?: string,
  organizationId?: number,
  orgSlug?: string | null
): Promise<boolean> {
  const baseUrl = getBaseUrl(orgSlug);
  const setupUrl = `${baseUrl}/set-password?token=${inviteToken}`;

  const variables: Record<string, string> = {
    bowler_name: userName,
    invite_link: setupUrl,
  };
  if (organizationName) {
    variables.organization_name = organizationName;
  }
  if (organizationId) {
    const orgForLogo = await storage.getOrganization(
      typeof organizationId === 'number' ? organizationId : parseInt(String(organizationId), 10),
    );
    if (orgForLogo) {
      variables.organization_logo_url = getOrgLogoUrl(orgForLogo);
    }
  }

  const sent = await sendTemplatedEmail('bulk_invite', toEmail, variables);
  if (sent) return true;

  if (!SENDGRID_API_KEY) {
    log.error('Cannot send invite — SENDGRID_API_KEY not configured');
    return false;
  }

  // Escape every interpolated value before splicing it into the raw
  // fallback HTML. userName / organizationName are user- and
  // org-controlled; the URL is server-generated but escaped for
  // consistency with the other senders (see escapeHtml usage in
  // sendEmailChangeConfirmation et al.).
  const safeName = escapeHtml(userName);
  const safeOrgName = organizationName ? escapeHtml(organizationName) : '';
  const safeSetupUrl = escapeHtml(setupUrl);

  const msg = {
    to: toEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Welcome to LeagueVault — Set Up Your Account',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1a1a2e; margin: 0;">LeagueVault</h1>
        </div>
        
        <p style="font-size: 16px; color: #333;">Hi ${safeName},</p>
        
        <p style="font-size: 16px; color: #333;">
          You've been invited to join ${safeOrgName ? `<strong>${safeOrgName}</strong> on ` : ''}LeagueVault. 
          To get started, please set up your password by clicking the button below.
        </p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${safeSetupUrl}" 
             style="background-color: #1a1a2e; color: #ffffff; padding: 14px 28px; 
                    text-decoration: none; border-radius: 6px; font-size: 16px; 
                    display: inline-block; font-weight: bold;">
            Set Up Your Password
          </a>
        </div>
        
        <p style="font-size: 14px; color: #666;">
          If the button doesn't work, copy and paste this link into your browser:
        </p>
        <p style="font-size: 14px; color: #666; word-break: break-all;">
          <a href="${safeSetupUrl}" style="color: #1a1a2e;">${safeSetupUrl}</a>
        </p>
        
        <p style="font-size: 14px; color: #666;">
          This link will expire in 7 days. If you didn't expect this invitation, you can safely ignore this email.
        </p>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        
        <p style="font-size: 12px; color: #999; text-align: center;">
          Powered by LeagueVault
        </p>
      </div>
    `,
    trackingSettings: {
      clickTracking: { enable: false, enableText: false },
    },
  };

  try {
    await dispatchMail(msg);
    log.info('Invite email sent to:', isDev ? toEmail : maskEmail(toEmail));
    return true;
  } catch (error) {
    log.error('Failed to send invite email:', describeMailError(error));
    return false;
  }
}

export async function sendPasswordResetFallbackEmail(
  toEmail: string,
  userName: string,
  resetToken: string,
  orgSlug?: string | null,
): Promise<boolean>;
export function sendPasswordResetFallbackEmail(
  toEmail: string,
  userName: string,
  resetToken: string,
  orgSlug: string | null | undefined,
  options: EmailSendOptions & { returnDetails: true },
): Promise<EmailDispatchResult>;
export function sendPasswordResetFallbackEmail(
  toEmail: string,
  userName: string,
  resetToken: string,
  orgSlug: string | null | undefined,
  options: EmailSendOptions,
): Promise<boolean | EmailDispatchResult>;
export async function sendPasswordResetFallbackEmail(
  toEmail: string,
  userName: string,
  resetToken: string,
  orgSlug?: string | null,
  options?: EmailSendOptions,
): Promise<boolean | EmailDispatchResult> {
  if (!SENDGRID_API_KEY) {
    log.error('Cannot send password reset email — SENDGRID_API_KEY not configured');
    return emailReturnValue({ accepted: false, failureReason: "not_configured" }, options);
  }

  const baseUrl = getBaseUrl(orgSlug);
  const resetUrl = `${baseUrl}/set-password?token=${resetToken}`;

  // Escape interpolated values before splicing into raw fallback HTML.
  // userName is user-controlled; the URL is server-generated but
  // escaped for consistency with the other senders.
  const safeName = escapeHtml(userName);
  const safeResetUrl = escapeHtml(resetUrl);
  const customArgs = safeAccountEmailDeliveryCustomArgs(options?.customArgs);

  const msg = {
    to: toEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Reset Your Password — LeagueVault',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1a1a2e; margin: 0;">LeagueVault</h1>
        </div>
        <p style="font-size: 16px; color: #333;">Hi ${safeName},</p>
        <p style="font-size: 16px; color: #333;">
          We received a request to reset your password. Click the button below to choose a new password.
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${safeResetUrl}"
             style="background-color: #1a1a2e; color: #ffffff; padding: 14px 28px;
                    text-decoration: none; border-radius: 6px; font-size: 16px;
                    display: inline-block; font-weight: bold;">
            Reset Password
          </a>
        </div>
        <p style="font-size: 14px; color: #666;">
          If the button doesn't work, copy and paste this link into your browser:
        </p>
        <p style="font-size: 14px; color: #666; word-break: break-all;">
          <a href="${safeResetUrl}">${safeResetUrl}</a>
        </p>
        <p style="font-size: 14px; color: #666;">
          This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="font-size: 12px; color: #999; text-align: center;">
          &copy; LeagueVault. All rights reserved.
        </p>
      </div>
    `,
    ...(customArgs ? { customArgs } : {}),
    trackingSettings: {
      clickTracking: { enable: false, enableText: false },
    },
  };

  try {
    const result = await dispatchMail(msg);
    if (customArgs) {
      // Recovery sends carry only the non-PII action/job correlation in logs;
      // do not include even a masked recipient address.
      log.info('Password reset email sent', customArgs);
    } else if (options?.customArgs) {
      log.info('Password reset email sent', { deliveryCorrelation: "invalid" });
    } else {
      log.info('Password reset email sent to:', maskEmail(toEmail));
    }
    return emailReturnValue(result, options);
  } catch (error) {
    log.error('Failed to send password reset email:', describeEmailDeliveryError(error));
    return emailReturnValue({ accepted: false, failureReason: "provider_error" }, options);
  }
}

export async function sendEmailChangeConfirmation(
  toEmail: string,
  userName: string,
  confirmUrl: string,
): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    log.error('Cannot send email-change confirmation — SENDGRID_API_KEY not configured');
    return false;
  }

  const safeName = escapeHtml(userName || 'there');
  const safeUrl = escapeHtml(confirmUrl);

  const msg = {
    to: toEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Confirm your new LeagueVault email address',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <p style="font-size: 16px; color: #333;">Hi ${safeName},</p>
        <p style="font-size: 16px; color: #333;">
          We received a request to use this address as the login email for your
          LeagueVault account. Please confirm by clicking the button below.
          Your login email will <strong>not</strong> change until you confirm.
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${safeUrl}"
             style="background-color: #1a1a2e; color: #ffffff; padding: 14px 28px;
                    text-decoration: none; border-radius: 6px; font-size: 16px;
                    display: inline-block; font-weight: bold;">
            Confirm Email Change
          </a>
        </div>
        <p style="font-size: 14px; color: #666;">
          If the button doesn't work, copy and paste this link into your browser:
        </p>
        <p style="font-size: 14px; color: #666; word-break: break-all;">
          <a href="${safeUrl}">${safeUrl}</a>
        </p>
        <p style="font-size: 14px; color: #666;">
          This link expires in 24 hours and can be used only once. If you didn't
          request this change, you can safely ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="font-size: 12px; color: #999; text-align: center;">Powered by LeagueVault</p>
      </div>
    `,
    trackingSettings: { clickTracking: { enable: false, enableText: false } },
  };

  try {
    await dispatchMail(msg);
    log.info('Email-change confirmation sent to:', isDev ? toEmail : maskEmail(toEmail));
    return true;
  } catch (error) {
    log.error('Failed to send email-change confirmation:', describeMailError(error));
    return false;
  }
}

export async function sendEmailChangeNotification(
  toEmail: string,
  userName: string,
  newEmailMasked: string,
): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    log.error('Cannot send email-change notification — SENDGRID_API_KEY not configured');
    return false;
  }

  const safeName = escapeHtml(userName || 'there');
  const safeMasked = escapeHtml(newEmailMasked);
  const supportUrl = `${getBaseUrl()}/support`;

  const msg = {
    to: toEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Email change requested on your LeagueVault account',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <p style="font-size: 16px; color: #333;">Hi ${safeName},</p>
        <p style="font-size: 16px; color: #333;">
          Someone — most likely you — requested to change the login email on
          your LeagueVault account to <strong>${safeMasked}</strong>.
        </p>
        <p style="font-size: 16px; color: #333;">
          Your login email has <strong>not</strong> changed yet. It will only
          change once the new address confirms ownership via the link sent to
          them.
        </p>
        <p style="font-size: 16px; color: #333;">
          <strong>If this wasn't you</strong>, please change your password
          immediately and contact support — someone may have access to your
          account.
        </p>
        <p style="font-size: 14px; color: #666; word-break: break-all;">
          <a href="${escapeHtml(supportUrl)}">${escapeHtml(supportUrl)}</a>
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="font-size: 12px; color: #999; text-align: center;">Powered by LeagueVault</p>
      </div>
    `,
    trackingSettings: { clickTracking: { enable: false, enableText: false } },
  };

  try {
    await dispatchMail(msg);
    log.info('Email-change notification sent to:', isDev ? toEmail : maskEmail(toEmail));
    return true;
  } catch (error) {
    log.error('Failed to send email-change notification:', describeMailError(error));
    return false;
  }
}

/**
 * Best-effort security notification sent after a successful change to
 * the user's password. Mirrors the industry-standard "your password
 * was just changed" email (Google, GitHub, Stripe). The change is
 * already committed by the time we get here — a SendGrid failure
 * MUST NOT roll the password back, so callers should ignore the
 * boolean return value beyond logging.
 *
 * Includes a coarse fingerprint of the request that triggered the
 * change (timestamp, approximate IP, truncated user-agent) so a
 * recipient who DIDN'T initiate the change has enough context to
 * recognize it as suspicious without leaking precise location data.
 */
export async function sendPasswordChangedNotification(
  toEmail: string,
  userName: string,
  context: {
    changedAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
    /**
     * ISO 639-1 two-letter locale (e.g. 'en', 'es') taken from the
     * recipient's `users.preferred_language`. Unknown / null values
     * fall back to English (task #410). Region tags like `es-MX`
     * collapse to their base language inside the resolver.
     */
    locale?: string | null;
    /**
     * Who initiated the password change (task #416). When `'admin'`,
     * the email body includes an extra translator-supplied line
     * stating that the change was performed by an administrator on
     * the recipient's account, so the user can immediately
     * distinguish a legitimate delegated rotation from an attacker
     * who happens to have access to their account. Defaults to
     * `'self'` for backwards compatibility — the existing
     * change-password and set-password call sites stay unchanged.
     */
    actor?: 'self' | 'admin';
  },
): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    log.error('Cannot send password-changed notification — SENDGRID_API_KEY not configured');
    return false;
  }

  const { code: localeCode, strings } = pickPasswordChangedLocale(context.locale);

  const safeName = escapeHtml(userName || 'there');
  // Format the timestamp in UTC with the offset spelled out so the
  // recipient (who could be in any timezone) can sanity-check it.
  const safeChangedAt = escapeHtml(context.changedAt.toUTCString());
  const safeIp = escapeHtml(context.ipAddress?.trim() || strings.unknown);
  // Truncate the UA to keep the email body bounded; full UAs can be
  // hundreds of characters and a coarse hint is all we need for the
  // "was this you?" sniff test.
  const rawUa = (context.userAgent ?? '').trim();
  const safeUa = escapeHtml(rawUa ? (rawUa.length > 120 ? `${rawUa.slice(0, 120)}…` : rawUa) : strings.unknown);
  const supportUrl = `${getBaseUrl()}/support`;
  // Greeting / intro are translator-supplied plain text, so escape
  // them ONCE at splice time. We feed the raw (un-escaped) display
  // name into `strings.greeting` and then escape the resulting
  // sentence — escaping `safeName` first AND then escaping the
  // whole greeting would double-encode (`A&B` → `A&amp;amp;B`).
  // ifThisWasYou / ifThisWasntYou intentionally contain a small
  // <strong> wrapper from the translator and are spliced raw —
  // they MUST NOT include user-controlled data.
  const displayName = userName || 'there';
  const safeGreeting = escapeHtml(strings.greeting(displayName));
  const safeIntro = escapeHtml(strings.intro);
  // Only render the admin-actor line when the caller asked for it
  // (task #416). Defaults to self-service so existing call sites at
  // server/routes/account.ts and server/routes/auth.ts keep their
  // pre-#416 wording verbatim — this prevents the admin sentence
  // from leaking into a normal user-driven password change just
  // because someone forgot to pass the actor flag.
  const adminLineHtml =
    context.actor === 'admin'
      ? `<p style="font-size: 16px; color: #333;">${escapeHtml(strings.performedByAdmin)}</p>`
      : '';

  const msg = {
    to: toEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: strings.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;" lang="${localeCode}">
        <p style="font-size: 16px; color: #333;">${safeGreeting}</p>
        <p style="font-size: 16px; color: #333;">${safeIntro}</p>
        ${adminLineHtml}
        <table style="font-size: 14px; color: #555; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 4px 12px 4px 0; color: #888;">${escapeHtml(strings.whenLabel)}</td>
            <td style="padding: 4px 0;">${safeChangedAt}</td>
          </tr>
          <tr>
            <td style="padding: 4px 12px 4px 0; color: #888;">${escapeHtml(strings.fromIpLabel)}</td>
            <td style="padding: 4px 0;">${safeIp}</td>
          </tr>
          <tr>
            <td style="padding: 4px 12px 4px 0; color: #888;">${escapeHtml(strings.browserLabel)}</td>
            <td style="padding: 4px 0;">${safeUa}</td>
          </tr>
        </table>
        <p style="font-size: 16px; color: #333;">${strings.ifThisWasYou}</p>
        <p style="font-size: 16px; color: #333;">${strings.ifThisWasntYou}</p>
        <p style="font-size: 14px; color: #666; word-break: break-all;">
          <a href="${escapeHtml(supportUrl)}">${escapeHtml(supportUrl)}</a>
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="font-size: 12px; color: #999; text-align: center;">${escapeHtml(strings.footer)}</p>
      </div>
    `,
    trackingSettings: { clickTracking: { enable: false, enableText: false } },
  };

  try {
    await dispatchMail(msg);
    log.info('Password-changed notification sent to:', isDev ? toEmail : maskEmail(toEmail), { locale: localeCode });
    return true;
  } catch (error) {
    log.error('Failed to send password-changed notification:', describeMailError(error));
    return false;
  }
}

/**
 * Confirmation email sent to the original requester after an admin
 * runs the automated account-data deletion. Best-effort: callers
 * should NOT roll back the deletion if this returns false.
 */
export async function sendAccountDeletionConfirmation(
  toEmail: string,
  details: {
    bowlersAnonymized: number;
    userAccountDeleted: boolean;
    paymentProviderRecordsDeleted: number;
    emailChangeRequestsDeleted: number;
    executedAt: string;
  },
): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    log.error('Cannot send account-deletion confirmation — SENDGRID_API_KEY not configured');
    return false;
  }

  const safeEmail = escapeHtml(toEmail);
  const safeExecutedAt = escapeHtml(details.executedAt);
  const supportUrl = `${getBaseUrl()}/support`;

  // Build the "what we removed" list. The verb (anonymized vs deleted)
  // matters for GDPR/CCPA wording — bowler rows are anonymized so the
  // historical scores/payments stay correct, while the user account
  // and ancillary records are removed outright.
  const items: string[] = [];
  items.push(
    `<li><strong>${details.bowlersAnonymized}</strong> bowler record(s) anonymized — your name, email, and contact details were removed; historical scores and league memberships are kept without identifying information.</li>`,
  );
  if (details.userAccountDeleted) {
    items.push(`<li>Your LeagueVault login account was <strong>deleted</strong>.</li>`);
  } else {
    items.push(
      `<li>No LeagueVault login account was found for this email, so nothing was deleted at the account level.</li>`,
    );
  }
  items.push(
    `<li><strong>${details.paymentProviderRecordsDeleted}</strong> saved payment-method record(s) removed at the payment processor.</li>`,
  );
  items.push(
    `<li><strong>${details.emailChangeRequestsDeleted}</strong> pending email-change request(s) deleted.</li>`,
  );

  const msg = {
    to: toEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Your LeagueVault account data has been deleted',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <p style="font-size: 16px; color: #333;">Hello,</p>
        <p style="font-size: 16px; color: #333;">
          We're confirming that the account-deletion request you submitted for
          <strong>${safeEmail}</strong> has been processed on
          <strong>${safeExecutedAt}</strong>. Here's what was removed:
        </p>
        <ul style="font-size: 15px; color: #333; line-height: 1.5;">
          ${items.join('\n          ')}
        </ul>
        <p style="font-size: 14px; color: #555;">
          Some records that contain other people's data — such as team
          rosters or league prize-fund history — were preserved with all
          identifying information about you removed.
        </p>
        <p style="font-size: 14px; color: #555;">
          If you didn't request this, or you believe this happened in
          error, please contact support right away:
        </p>
        <p style="font-size: 14px; color: #555; word-break: break-all;">
          <a href="${escapeHtml(supportUrl)}">${escapeHtml(supportUrl)}</a>
        </p>
        <p style="font-size: 14px; color: #555;">Thanks for using LeagueVault.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="font-size: 12px; color: #999; text-align: center;">Powered by LeagueVault</p>
      </div>
    `,
    trackingSettings: { clickTracking: { enable: false, enableText: false } },
  };

  try {
    await dispatchMail(msg);
    log.info('Account-deletion confirmation sent to:', isDev ? toEmail : maskEmail(toEmail));
    return true;
  } catch (error) {
    log.error(
      'Failed to send account-deletion confirmation:',
      describeMailError(error),
    );
    return false;
  }
}

/**
 * Task #357: alert email sent when an account is auto-locked after
 * repeated failed current-password attempts on /api/account/change-password.
 * Best-effort — caller should NOT roll back the lock if SendGrid throws.
 *
 * The body tells the user (a) why the lock fired, (b) the request that
 * triggered it (when, IP, browser), (c) when the lock lifts, and
 * (d) a CTA to the forgot-password flow so they can recover without
 * waiting out the lock or knowing their old password.
 */
export async function sendAccountLockoutAlert(
  toEmail: string,
  userName: string,
  context: {
    lockedAt: Date;
    unlocksAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
    /**
     * ISO 639-1 two-letter locale (e.g. 'en', 'es') taken from the
     * recipient's `users.preferred_language`. Unknown / null values
     * fall back to English. Region tags like `es-MX` collapse to
     * their base language inside the resolver.
     */
    locale?: string | null;
  },
): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    log.error('Cannot send account-lockout alert — SENDGRID_API_KEY not configured');
    return false;
  }

  const { code: localeCode, strings } = pickAccountLockoutLocale(context.locale);

  const safeLockedAt = escapeHtml(context.lockedAt.toUTCString());
  const safeUnlocksAt = escapeHtml(context.unlocksAt.toUTCString());
  const safeIp = escapeHtml(context.ipAddress?.trim() || strings.unknown);
  const rawUa = (context.userAgent ?? '').trim();
  const safeUa = escapeHtml(rawUa ? (rawUa.length > 120 ? `${rawUa.slice(0, 120)}…` : rawUa) : strings.unknown);
  const forgotUrl = `${getBaseUrl()}/forgot-password`;
  const supportUrl = `${getBaseUrl()}/support`;

  // Greeting / intro are translator-supplied plain text, escape ONCE
  // at splice time. ifThisWasYou / ifThisWasntYou contain a small
  // <strong> wrapper from the translator and are spliced raw — they
  // MUST NOT include user-controlled data.
  const displayName = userName || 'there';
  const safeGreeting = escapeHtml(strings.greeting(displayName));
  const safeIntro = escapeHtml(strings.intro);

  const msg = {
    to: toEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: strings.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;" lang="${localeCode}">
        <p style="font-size: 16px; color: #333;">${safeGreeting}</p>
        <p style="font-size: 16px; color: #333;">${safeIntro}</p>
        <table style="font-size: 14px; color: #555; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 4px 12px 4px 0; color: #888;">${escapeHtml(strings.whenLabel)}</td>
            <td style="padding: 4px 0;">${safeLockedAt}</td>
          </tr>
          <tr>
            <td style="padding: 4px 12px 4px 0; color: #888;">${escapeHtml(strings.fromIpLabel)}</td>
            <td style="padding: 4px 0;">${safeIp}</td>
          </tr>
          <tr>
            <td style="padding: 4px 12px 4px 0; color: #888;">${escapeHtml(strings.browserLabel)}</td>
            <td style="padding: 4px 0;">${safeUa}</td>
          </tr>
          <tr>
            <td style="padding: 4px 12px 4px 0; color: #888;">${escapeHtml(strings.unlocksAtLabel)}</td>
            <td style="padding: 4px 0;">${safeUnlocksAt}</td>
          </tr>
        </table>
        <p style="font-size: 16px; color: #333;">${strings.ifThisWasYou}</p>
        <p style="font-size: 16px; color: #333;">${strings.ifThisWasntYou}</p>
        <div style="margin: 20px 0;">
          <a href="${escapeHtml(forgotUrl)}" style="display: inline-block; background-color: #1a1a2e; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: bold;">${escapeHtml(strings.resetCta)}</a>
        </div>
        <p style="font-size: 14px; color: #666; word-break: break-all;">
          <a href="${escapeHtml(supportUrl)}">${escapeHtml(supportUrl)}</a>
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="font-size: 12px; color: #999; text-align: center;">${escapeHtml(strings.footer)}</p>
      </div>
    `,
    trackingSettings: { clickTracking: { enable: false, enableText: false } },
  };

  try {
    await dispatchMail(msg);
    log.info('Account-lockout alert sent to:', isDev ? toEmail : maskEmail(toEmail), { locale: localeCode });
    return true;
  } catch (error) {
    log.error('Failed to send account-lockout alert:', describeMailError(error));
    return false;
  }
}

export async function resendInviteEmail(
  toEmail: string,
  userName: string,
  inviteToken: string,
  organizationName?: string,
  organizationId?: number,
  orgSlug?: string | null
): Promise<boolean> {
  return sendInviteEmail(toEmail, userName, inviteToken, organizationName, organizationId, orgSlug);
}
