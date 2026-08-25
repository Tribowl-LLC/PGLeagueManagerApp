import { z } from "zod";

export const STANDING_AUTOPAY_CONSENT_CONTRACT = "standing-autopay-consent/1" as const;
export const STANDING_AUTOPAY_STATUS_CONTRACT = "standing-autopay-status/1" as const;
export const STANDING_AUTOPAY_QUOTE_CONTRACT = "standing-autopay-quote/1" as const;
export const STANDING_AUTOPAY_OPERATION_CONTRACT = "standing-autopay-operation/1" as const;

const commandKey = z.string().trim().min(16).max(109).regex(/^[A-Za-z0-9_-]+$/);

/** A standing consent only binds a saved, tenant-owned provider card. */
export const standingAutopayConsentRequestSchema = z.object({
  commandKey,
  sourceId: z.string().trim().min(1).max(255),
  partnerBowlerIds: z.array(z.number().int().positive()).max(32).default([]),
}).strict();

export const standingAutopayRevokeRequestSchema = z.object({ commandKey }).strict();
export const standingAutopayQuoteRequestSchema = z.object({ commandKey: commandKey.optional() }).strict();

export type StandingAutopayConsentRequest = z.infer<typeof standingAutopayConsentRequestSchema>;
export type StandingAutopayRevokeRequest = z.infer<typeof standingAutopayRevokeRequestSchema>;

export type StandingAutopayConsentWire = {
  contractVersion: typeof STANDING_AUTOPAY_CONSENT_CONTRACT;
  organizationId: number;
  leagueId: number;
  payerBowlerId: number;
  consentId: string | null;
  consentVersion: number | null;
  state: "pending" | "active" | "revoked" | "expired" | "none";
  paymentMode: "weekly";
  partnerBowlerIds: number[];
};

export type StandingAutopayQuoteWire = {
  contractVersion: typeof STANDING_AUTOPAY_QUOTE_CONTRACT;
  organizationId: number;
  leagueId: number;
  consentId: string;
  consentVersion: number;
  cutoffAt: string | null;
  collectionMode: "weekly" | "double_pay" | null;
  amountMinor: number;
  obligations: Array<{
    obligationId: string;
    occurrenceId: string;
    payerBowlerId: number;
    amountMinor: number;
    outstandingMinor: number;
    dueAt: string;
    collectionGroupId: string | null;
  }>;
  fingerprint: string;
};

export type StandingAutopayOperationWire = {
  contractVersion: typeof STANDING_AUTOPAY_OPERATION_CONTRACT;
  operationId: string;
  status: string;
  providerPaymentId: string | null;
};
