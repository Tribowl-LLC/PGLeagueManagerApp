import type { AccountActionRequest } from "@shared/schema";

/** Public invitation state. Raw tokens and token hashes are never included. */
export interface PublicAccountInvitation {
  id: number;
  action: AccountActionRequest["action"];
  status: AccountActionRequest["status"];
  deliveryStatus: AccountActionRequest["deliveryStatus"];
  expiresAt: string;
  deliveryAttemptedAt: string | null;
  deliveredAt: string | null;
  expiredAt: string | null;
  createdAt: string;
}

export function publicAccountInvitation(
  request: AccountActionRequest | null | undefined,
): PublicAccountInvitation | null {
  if (!request) return null;
  return {
    id: request.id,
    action: request.action,
    status: request.status,
    deliveryStatus: request.deliveryStatus,
    expiresAt: request.expiresAt,
    deliveryAttemptedAt: request.deliveryAttemptedAt,
    deliveredAt: request.deliveredAt,
    expiredAt: request.expiredAt,
    createdAt: request.createdAt,
  };
}
