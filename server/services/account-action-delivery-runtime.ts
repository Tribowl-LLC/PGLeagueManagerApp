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
import {
  sendAccountGuidanceEmail,
  sendAccountRegistrationFallbackEmail,
  sendPasswordResetFallbackEmail,
} from './email-auth';
import {
  AccountGuidanceDeliveryWorker,
  runAccountGuidanceFairSweep,
  type AccountGuidanceProviderOutcome,
} from './account-guidance-delivery-worker';
import {
  AccountReadyDeliveryWorker,
  type AccountReadyDeliveryRunResult,
} from './account-ready-delivery-worker';

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

export const accountGuidanceDeliveryWorker = new AccountGuidanceDeliveryWorker({
  send: async ({ job, target }): Promise<AccountGuidanceProviderOutcome> => {
    const result = await sendAccountGuidanceEmail({
      toEmail: target.recipientEmail,
      userName: target.userName,
      noticeType: job.noticeType,
      organization: target.organization,
      guidanceJobId: job.id,
    });
    if (result.accepted) {
      return { kind: "accepted", providerMessageId: result.providerMessageId };
    }
    return {
      kind: "failed",
      errorCode: result.failureReason ?? "provider_not_accepted",
      retryable: result.failureReason !== "not_configured"
        && result.failureReason !== "render_error"
        && result.failureReason !== "provider_rejected",
    };
  },
});

// Guidance notices are lower priority than credential actions. Keep each
// shared scheduler sweep small so a provider outage or recipient flood cannot
// hold a newly queued password reset behind 100 sequential 30-second timeouts.
export const ACCOUNT_GUIDANCE_SWEEP_BATCH_SIZE = 5;
export const ACCOUNT_READY_SWEEP_BATCH_SIZE = 5;

export async function runAccountReadyFairSweep(input: {
  runCredentialOne: () => Promise<unknown>;
  runAccountReadyOne: () => Promise<AccountReadyDeliveryRunResult>;
  maxJobs: number;
}): Promise<AccountReadyDeliveryRunResult[]> {
  if (!Number.isSafeInteger(input.maxJobs) || input.maxJobs < 1 || input.maxJobs > 10_000) {
    throw new Error("maxJobs must be between 1 and 10000");
  }
  const results: AccountReadyDeliveryRunResult[] = [];
  for (let count = 0; count < input.maxJobs; count += 1) {
    await input.runCredentialOne();
    const result = await input.runAccountReadyOne();
    results.push(result);
    if (result.kind === "idle") break;
  }
  return results;
}

export const accountReadyDeliveryWorker = new AccountReadyDeliveryWorker();

export async function startAccountActionDelivery(): Promise<void> {
  await accountActionDeliveryWorker.start();
  await accountGuidanceDeliveryWorker.start();
  await accountReadyDeliveryWorker.start();
  await startAccountActionDeliveryScheduler(async () => {
    await accountActionDeliveryWorker.recoverOnStartup();
    await accountActionDeliveryWorker.runUntilIdle();
    await accountGuidanceDeliveryWorker.recoverOnStartup();
    await runAccountGuidanceFairSweep({
      runCredentialOne: () => accountActionDeliveryWorker.runOne(),
      runGuidanceOne: () => accountGuidanceDeliveryWorker.runOne(),
      maxJobs: ACCOUNT_GUIDANCE_SWEEP_BATCH_SIZE,
    });
    await accountReadyDeliveryWorker.recoverOnStartup();
    await runAccountReadyFairSweep({
      runCredentialOne: () => accountActionDeliveryWorker.runOne(),
      runAccountReadyOne: () => accountReadyDeliveryWorker.runOne(),
      maxJobs: ACCOUNT_READY_SWEEP_BATCH_SIZE,
    });
  });
}

export async function stopAccountActionDelivery(): Promise<void> {
  stopAccountActionDeliveryScheduler();
  await accountActionDeliveryWorker.stopAndDrain();
  await accountGuidanceDeliveryWorker.stopAndDrain();
  await accountReadyDeliveryWorker.stopAndDrain();
}
