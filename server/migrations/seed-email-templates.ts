import { db } from "../db.js";
import { emailTemplates, type InsertEmailTemplate } from "@shared/schema/email-templates";
import { createLogger } from "../logger";

const log = createLogger("SeedEmailTemplates");

/**
 * The complete catalog of LeagueVault-authored messages. Keep this list in
 * lockstep with calls to sendTemplatedEmail: startup seeding is deliberately
 * additive, so an administrator's edits are never overwritten on restart.
 *
 * Missing rows have a sender-specific bootstrap fallback where a message must
 * continue to work during a rolling deployment. An explicitly inactive row is
 * always a no-op (see sendTemplatedEmail), which lets system administrators
 * intentionally disable that message.
 */
export const DEFAULT_TEMPLATES: InsertEmailTemplate[] = [
  {
    slug: "bowler_payment_link_invite",
    name: "Bowler Payment Partner Invite",
    description:
      "Sent when a bowler invites another bowler to be a payment partner. Includes one-click Accept and Decline links plus an in-app deep link.",
    subject: "{{inviter_name}} invited you to be a payment partner",
    body:
      "Hi {{invitee_name}},\n\n" +
      "{{inviter_name}} invited you to be a payment partner on {{organization_name}}. " +
      "Payment partners can pay each other's league fees from their own saved cards.\n\n" +
      "Accept the invite:\n{{accept_link}}\n\n" +
      "Decline the invite:\n{{decline_link}}\n\n" +
      "Open in app:\n{{app_link}}\n\n" +
      "These links expire in 14 days.",
    active: true,
  },
  {
    slug: "bulk_invite",
    name: "Bulk Account Invitation",
    description: "Sent when an administrator invites a user to join LeagueVault.",
    subject: "Welcome to LeagueVault — Set Up Your Account",
    body: "<p>Hi {{bowler_name}},</p><p>You've been invited to join {{organization_name}} on LeagueVault. To get started, set up your password here: <a href=\"{{invite_link}}\">{{invite_link}}</a></p><p>This link will expire in 7 days. If you didn't expect this invitation, you can safely ignore this email.</p>",
    active: true,
  },
  {
    slug: "org_admin_invite",
    name: "Organization Administrator Invitation",
    description: "Sent when a new organization administrator account is created.",
    subject: "You're invited to administer {{organization_name}} on LeagueVault",
    body: "<p>Hi {{admin_name}},</p><p>You've been invited to administer <strong>{{organization_name}}</strong> on LeagueVault.</p><p><a href=\"{{invite_link}}\">Set up your password</a></p>",
    active: true,
  },
  {
    slug: "org_end_user_invite",
    name: "Organization User Invitation",
    description: "Sent when an organization administrator invites a bowler or staff user.",
    subject: "You're invited to join {{organization_name}} on LeagueVault",
    body: "<p>Hi {{user_name}},</p><p>You've been invited to join <strong>{{organization_name}}</strong> on LeagueVault.</p><p><a href=\"{{invite_link}}\">Set up your account</a></p>",
    active: true,
  },
  {
    slug: "bowler_claimed",
    name: "Bowler Profile Claimed",
    description: "Sent after a user claims and links a bowler profile.",
    subject: "Your {{organization_name}} bowler profile is ready",
    body: "<p>Hi {{bowler_name}},</p><p>Your bowler profile in <strong>{{organization_name}}</strong> is now connected to your LeagueVault account for {{league_name}}.</p><p><a href=\"{{dashboard_link}}\">Open your dashboard</a></p>",
    active: true,
  },
  {
    slug: "account_guidance_exists",
    name: "Account Already Exists Guidance",
    description: "Sent when registration finds an existing LeagueVault account.",
    subject: "You already have a LeagueVault account",
    body: "<p>Hi {{user_name}},</p><p>This email address is already connected to a LeagueVault login account.</p><p><a href=\"{{reset_link}}\">Reset your password</a></p><p>Or <a href=\"{{login_link}}\">log in</a>.</p><p>If you remember your password, you can log in directly.</p>",
    active: true,
  },
  {
    slug: "admin_claim_complete",
    name: "Account Ready Notification",
    description: "Sent after an administrator links a user account to a bowler profile.",
    subject: "Your LeagueVault account is ready",
    body: "<p>Hi {{user_name}},</p><p>Your LeagueVault account is connected to your bowler profile in <strong>{{organization_name}}</strong>. Sign in to view your leagues and pay available balances.</p><p><a href=\"{{login_link}}\">Sign in to LeagueVault</a></p><p>If the button does not work, sign in here: <a href=\"{{login_link}}\">{{login_link}}</a></p>",
    active: true,
  },
  {
    slug: "account_guidance_missing",
    name: "Account Missing Guidance",
    description: "Sent when account guidance finds no LeagueVault account for the address.",
    subject: "There is no LeagueVault login account for this email address yet",
    body: "<p>Hi {{user_name}},</p><p>This email address does not have a LeagueVault login account yet.</p><p><a href=\"{{register_link}}\">Register</a></p><p>Use the registration page to create your LeagueVault account.</p>",
    active: true,
  },
  {
    slug: "password_reset",
    name: "Password Reset",
    description: "Sent when a user requests a password reset.",
    subject: "Reset Your Password — LeagueVault",
    body: "<p>Hi {{bowler_name}},</p><p>We received a request to reset your password. Click below to choose a new password.</p><p><a href=\"{{reset_link}}\">Reset Password</a></p><p>This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>",
    active: true,
  },
  {
    slug: "account_registration",
    name: "Account Registration",
    description: "Sent to finish setting up a newly registered LeagueVault account.",
    subject: "Finish setting up your LeagueVault account",
    body: "<p>Hi {{bowler_name}},</p><p>Click below to verify your email and set your LeagueVault password.</p><p><a href=\"{{invite_link}}\">Set up your account</a></p><p>This link expires in 7 days. If you did not request an account, you can ignore this message.</p>",
    active: true,
  },
  {
    slug: "email_change_confirmation",
    name: "Email Change Confirmation",
    description: "Sent to the new address to confirm a requested login-email change.",
    subject: "Confirm your new LeagueVault email address",
    body: "<p>Hi {{user_name}},</p><p>We received a request to use this address as the login email for your LeagueVault account. Please confirm by clicking the button below. Your login email will <strong>not</strong> change until you confirm.</p><p><a href=\"{{confirm_link}}\">Confirm Email Change</a></p><p>This link expires in 24 hours and can be used only once. If you didn't request this change, you can safely ignore this email.</p>",
    active: true,
  },
  {
    slug: "email_change_notification",
    name: "Email Change Notification",
    description: "Sent to the current address after someone requests a login-email change.",
    subject: "Email change requested on your LeagueVault account",
    body: "<p>Hi {{user_name}},</p><p>Someone — most likely you — requested to change the login email on your LeagueVault account to <strong>{{new_email_masked}}</strong>.</p><p>Your login email has <strong>not</strong> changed yet. It will only change once the new address confirms ownership via the link sent to them.</p><p><strong>If this wasn't you</strong>, please change your password immediately and contact support — someone may have access to your account.</p><p><a href=\"{{support_link}}\">{{support_link}}</a></p>",
    active: true,
  },
  {
    slug: "password_changed",
    name: "Password Changed Notification",
    description: "Security notice sent after a successful password change; locale text is supplied by the sender.",
    subject: "{{subject}}",
    body: "<p>{{greeting}}</p><p>{{intro}}</p><p>{{performed_by_admin}}</p><table><tr><td>{{when_label}}</td><td>{{changed_at}}</td></tr><tr><td>{{from_ip_label}}</td><td>{{ip_address}}</td></tr><tr><td>{{browser_label}}</td><td>{{user_agent}}</td></tr></table><p>{{if_this_was_you}}</p><p>{{if_this_wasnt_you}}</p><p><a href=\"{{support_link}}\">{{support_link}}</a></p><p>{{footer}}</p>",
    active: true,
  },
  {
    slug: "account_deletion_confirmation",
    name: "Account Deletion Confirmation",
    description: "Sent after a submitted account-data deletion request is processed.",
    subject: "Your LeagueVault account data has been deleted",
    body: "<p>Hello,</p><p>We're confirming that the account-deletion request you submitted for <strong>{{email}}</strong> has been processed on <strong>{{executed_at}}</strong>.</p><ul><li><strong>{{bowlers_anonymized}}</strong> bowler record(s) anonymized.</li><li>{{account_status}}</li><li><strong>{{payment_records_deleted}}</strong> saved payment-method record(s) removed at the payment processor.</li><li><strong>{{email_change_requests_deleted}}</strong> pending email-change request(s) deleted.</li></ul><p>Some records that contain other people's data were preserved with identifying information about you removed.</p><p>If you didn't request this, please contact support: <a href=\"{{support_link}}\">{{support_link}}</a></p>",
    active: true,
  },
  {
    slug: "account_lockout",
    name: "Account Lockout Alert",
    description: "Security notice sent after repeated failed current-password attempts; locale text is supplied by the sender.",
    subject: "{{subject}}",
    body: "<p>{{greeting}}</p><p>{{intro}}</p><table><tr><td>{{when_label}}</td><td>{{locked_at}}</td></tr><tr><td>{{from_ip_label}}</td><td>{{ip_address}}</td></tr><tr><td>{{browser_label}}</td><td>{{user_agent}}</td></tr><tr><td>{{unlocks_at_label}}</td><td>{{unlocks_at}}</td></tr></table><p>{{if_this_was_you}}</p><p>{{if_this_wasnt_you}}</p><p><a href=\"{{forgot_link}}\">{{reset_cta}}</a></p><p><a href=\"{{support_link}}\">{{support_link}}</a></p><p>{{footer}}</p>",
    active: true,
  },
  {
    slug: "payment_receipt_resend",
    name: "Payment Receipt Resend",
    description: "Sent when a user requests a new link to a Square-hosted payment receipt.",
    subject: "Your receipt for {{organization_name}}{{receipt_label}}",
    body: "<p>Hi,</p><p>Here is your receipt for the {{amount}} payment to <strong>{{organization_name}}</strong> for {{league_name}} {{receipt_label}}.</p><p><a href=\"{{receipt_url}}\">View Receipt</a></p><p>If the button doesn't work, copy and paste this link into your browser: <a href=\"{{receipt_url}}\">{{receipt_url}}</a></p>",
    active: true,
  },
  {
    slug: "deletion_request_notification",
    name: "Account Deletion Request Notification",
    description: "Sent to system administrators when a user submits an account deletion request.",
    subject: "[LeagueVault] New account deletion request from {{request_email}}",
    body: "<h2>New account deletion request</h2><p>A user has requested account deletion.</p><table><tr><td>Email</td><td><strong>{{request_email}}</strong></td></tr><tr><td>Submitted</td><td>{{created_at}}</td></tr><tr><td>Reason</td><td>{{reason}}</td></tr></table><p><a href=\"{{review_link}}\">Review request</a></p>",
    active: true,
  },
  {
    slug: "apple_pay_recovery_alert",
    name: "Apple Pay Recovery Alert",
    description: "Operational alert sent to system administrators when stalled Apple Pay jobs are recovered.",
    subject: "[LeagueVault] Apple Pay worker recovered {{item_count}} stalled item(s)",
    body: "<h2>Apple Pay items revived after stall</h2><p>The Apple Pay worker revived <strong>{{item_count}}</strong> item(s) whose pre-call lease had expired. Please investigate.</p><table><tr><td>Items recovered</td><td><strong>{{item_count}}</strong></td></tr><tr><td>Affected job IDs</td><td>{{job_ids}}</td></tr><tr><td>Item IDs</td><td>{{item_ids}}</td></tr></table><p>{{suppressed_line}}</p><p><a href=\"{{review_link}}\">Open Apple Pay Jobs</a></p>",
    active: true,
  },
  {
    slug: "square_catalog_cap_alert",
    name: "Square Catalog Capacity Alert",
    description: "Operational alert sent to administrators when a Square catalog pagination safety cap is reached.",
    subject: "[LeagueVault] Square catalog hit pagination cap (org {{organization_id}}, location {{location_id}})",
    body: "<h2>Square catalog too large to fully load</h2><p>A request to list this organization's Square catalog tripped our pagination safety cap. The visible list is incomplete.</p><table><tr><td>Organization ID</td><td><strong>{{organization_id}}</strong></td></tr><tr><td>Location ID</td><td><strong>{{location_id}}</strong></td></tr><tr><td>Cap that fired</td><td>{{reason}}</td></tr><tr><td>Call site</td><td>{{context}}</td></tr></table><p>{{suppressed_line}}</p><p><a href=\"{{review_link}}\">Open Location</a></p>",
    active: true,
  },
  {
    slug: "square_catalog_missing_alert",
    name: "Square Catalog Item Missing Alert",
    description: "Sent to league administrators when a referenced Square catalog item disappears.",
    subject: "[LeagueVault] Square item missing for league \"{{league_name}}\"",
    body: "<h2>A Square item used by your league is no longer available</h2><p>The league <strong>{{league_name}}</strong> in {{organization_name}} references one or more Square catalog items that can no longer be found. New bowler payments for this league will fail until the league is re-pointed.</p><table>{{missing_items}}</table><p><a href=\"{{edit_link}}\">Open league settings</a></p><p>You're receiving this because you're an admin for {{organization_name}}. We will not re-send this alert for the same league for at least 24 hours.</p>",
    active: true,
  },
];

export async function seedDefaultEmailTemplates(): Promise<void> {
  for (const tpl of DEFAULT_TEMPLATES) {
    const result = await db
      .insert(emailTemplates)
      .values(tpl)
      .onConflictDoNothing({ target: emailTemplates.slug })
      .returning({ id: emailTemplates.id });
    if (result.length > 0) {
      log.info(`Seeded email template '${tpl.slug}'`);
    }
  }
}
