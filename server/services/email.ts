// Barrel for the email service. The implementation is split by family to
// keep each module focused (task #763):
//   - `email-core.ts`          core dispatch guard, templating engine, and
//                              shared helpers (getBaseUrl, getOrgLogoUrl,
//                              sendTemplatedEmail).
//   - `email-auth.ts`          auth/account lifecycle senders (invites,
//                              password reset/changed, email change,
//                              account deletion, lockout).
//   - `email-admin-alerts.ts`  admin/ops alert senders (test sends,
//                              deletion-request, Apple Pay recovery,
//                              Square catalog cap/missing).
//   - `email-transactional.ts` transactional senders (receipt resend).
//
// Every previously-exported symbol is re-exported here so existing importers
// (`../services/email` and `../services/email.js`) keep working unchanged.

export {
  getBaseUrl,
  getOrgLogoUrl,
  sendAccountReadyEmail,
  sendTemplatedEmail,
} from './email-core';

export type {
  AccountReadyEmailOptions,
  EmailNotification,
} from './email-core';

export {
  sendInviteEmail,
  sendPasswordResetFallbackEmail,
  sendEmailChangeConfirmation,
  sendEmailChangeNotification,
  sendPasswordChangedNotification,
  sendAccountDeletionConfirmation,
  sendAccountLockoutAlert,
  resendInviteEmail,
} from './email-auth';

export {
  sendTestEmail,
  sendDeletionRequestNotification,
  sendApplePayRecoveryAlert,
  sendSquareCatalogCapAlert,
  sendLeagueSquareCatalogMissingAlert,
} from './email-admin-alerts';

export {
  sendReceiptResendEmail,
} from './email-transactional';
