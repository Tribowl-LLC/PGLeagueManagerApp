import { storage } from '../storage';
import { AccountActionDeliveryWorker, type PasswordResetDeliverySenderInput } from './account-action-delivery-worker';
import {
  startAccountActionDeliveryScheduler,
  stopAccountActionDeliveryScheduler,
} from './account-action-delivery-scheduler';
import {
  getBaseUrl,
  sendTemplatedEmail,
  type EmailDispatchResult,
} from './email-core';
import { sendAccountRegistrationFallbackEmail, sendPasswordResetFallbackEmail } from './email-auth';

export function emailProviderOutcome(result: EmailDispatchResult, action: "password_reset" | "account_registration") {
  if (result.accepted) {
    return {
      kind: 'accepted' as const,
      providerMessageId: result.providerMessageId,
    };
  }

  const errorCode = result.failureReason ?? 'provider_not_accepted';
  return {
    kind: 'failed' as const,
    errorCode,
    // A missing configuration or deterministic render failure cannot be
    // repaired by retrying the same provider call. These are known to occur
    // before SendGrid submission, so their newly-created action can be
    // revoked safely. Provider failures remain retryable and retain the
    // action because submission may have happened before the error surfaced.
    retryable: result.failureReason !== 'not_configured'
      && result.failureReason !== 'render_error'
      && (action !== "account_registration" || result.failureReason !== 'provider_rejected'),
    deliveryDisposition: result.failureReason === 'not_configured'
      || result.failureReason === 'render_error'
      || (action === "account_registration" && (result.failureReason === 'provider_rejected'
        || result.failureReason === 'provider_rate_limited'))
      ? 'known_unsent' as const
      : 'uncertain' as const,
  };
}

async function sendAccountActionEmail({ job, target, action }: PasswordResetDeliverySenderInput) {
  const org = target.organizationId ? await storage.getOrganization(target.organizationId) : null;
  const resetUrl = `${getBaseUrl(org)}/set-password?token=${encodeURIComponent(action.token)}`;
  const options = {
    returnDetails: true as const,
    customArgs: { account_action_id: action.request.id, account_delivery_job_id: job.id },
  };
  const slug = job.action === "account_registration" ? "account_registration" : "password_reset";
  const templated = await sendTemplatedEmail(slug, target.email, {
    bowler_name: target.userName,
    reset_link: resetUrl,
    invite_link: resetUrl,
    organization_name: org?.name || 'LeagueVault',
  }, options);
  if (!templated.accepted && templated.failureReason !== 'template_missing') {
    return emailProviderOutcome(templated, job.action);
  }
  const result = templated.accepted
    ? templated
    : job.action === "account_registration"
      ? await sendAccountRegistrationFallbackEmail(
        target.email, target.userName, action.token, org?.subdomain || org?.slug, options,
      )
      : await sendPasswordResetFallbackEmail(
        target.email, target.userName, action.token, org?.subdomain || org?.slug, options,
      );
  return emailProviderOutcome(result as EmailDispatchResult, job.action);
}

export const accountActionDeliveryWorker = new AccountActionDeliveryWorker({
  loadTarget: async (job) => {
    const user = await storage.getUser(job.userId);
    if (!user?.password) return undefined;
    return {
      userId: user.id,
      email: user.email,
      userName: user.name?.split(' ')[0] || 'there',
      organizationId: user.organizationId,
      credentialGeneration: user.credentialGeneration,
    };
  },
  send: sendAccountActionEmail,
});

export async function startAccountActionDelivery(): Promise<void> {
  await accountActionDeliveryWorker.start();
  await startAccountActionDeliveryScheduler(async () => {
    await accountActionDeliveryWorker.recoverOnStartup();
    await accountActionDeliveryWorker.runUntilIdle();
  });
}

export async function stopAccountActionDelivery(): Promise<void> {
  stopAccountActionDeliveryScheduler();
  await accountActionDeliveryWorker.stopAndDrain();
}
