import type {
  EmailDeliveryAlertBounceClassification,
  EmailDeliveryAlertEventType,
  EmailDeliveryAlertFailureType,
  EmailDeliveryAlertReasonCode,
} from "./schema/email-delivery-alerts";

/** Safe reason labels for the system-admin UI; provider text stays server-side. */
export const EMAIL_DELIVERY_ALERT_REASON_LABELS: Record<EmailDeliveryAlertReasonCode, string> = {
  sending_ip_blocklisted: "Sending IP is blocklisted",
  recipient_address_invalid: "Recipient address is invalid",
  mailbox_full: "Recipient mailbox is full",
  policy_rejection: "Provider policy rejected the message",
  temporary_failure: "Temporary delivery failure",
  provider_dropped: "Provider dropped the message",
  unknown_failure: "Unclassified delivery failure",
};

/** Allowlisted projection returned by system-admin email alert endpoints. */
export interface EmailDeliveryAlertDto {
  id: number;
  recipientEmail: string;
  eventType: EmailDeliveryAlertEventType;
  failureType: EmailDeliveryAlertFailureType;
  reasonCode: EmailDeliveryAlertReasonCode;
  bounceClassification: EmailDeliveryAlertBounceClassification | null;
  smtpStatus: string | null;
  sendingIp: string | null;
  providerEventAt: string;
  receivedAt: string;
  acknowledgedAt: string | null;
}

export interface EmailDeliveryAlertsResponse {
  alerts: EmailDeliveryAlertDto[];
  unacknowledgedCount: number;
  webhookConfigured: boolean;
}
