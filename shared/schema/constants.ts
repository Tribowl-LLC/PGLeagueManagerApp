import { pgEnum } from "drizzle-orm/pg-core";
import { z } from "zod";

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

// League-level setting: how the league collects fees (weekly or upfront)
export const PAYMENT_MODES = ["weekly", "upfront"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const WeekDay = {
  MONDAY: WEEKDAYS[0],
  TUESDAY: WEEKDAYS[1],
  WEDNESDAY: WEEKDAYS[2],
  THURSDAY: WEEKDAYS[3],
  FRIDAY: WEEKDAYS[4],
  SATURDAY: WEEKDAYS[5],
  SUNDAY: WEEKDAYS[6],
} as const;

export const USER_ROLES = ['system_admin', 'org_admin', 'user'] as const;
export const userRoleEnum = pgEnum('user_role', USER_ROLES);
export type UserRole = (typeof USER_ROLES)[number];

// Bowler-level schedule: how often an individual bowler's automatic payment recurs
export const SCHEDULE_FREQUENCIES = ["weekly", "monthly", "upfront"] as const;

export const PAYMENT_STATUSES = ["paid", "pending", "failed", "refunded", "disputed"] as const;
export const PaymentStatus = {
  PAID: PAYMENT_STATUSES[0],
  PENDING: PAYMENT_STATUSES[1],
  FAILED: PAYMENT_STATUSES[2],
  REFUNDED: PAYMENT_STATUSES[3],
  // Cardholder opened a dispute / chargeback. Set by the Clover
  // webhook receiver (task #577) and may be set by the Square
  // receiver in a follow-up. Distinct from `refunded` because the
  // funds aren't necessarily moved yet — the dispute could still be
  // won.
  DISPUTED: PAYMENT_STATUSES[4],
} as const;

export const PAYMENT_TYPES = ["cash", "check", "credit_card", "square", "clover"] as const;
export const PaymentType = {
  CASH: PAYMENT_TYPES[0],
  CHECK: PAYMENT_TYPES[1],
  CREDIT_CARD: PAYMENT_TYPES[2],
  SQUARE: PAYMENT_TYPES[3],
  CLOVER: PAYMENT_TYPES[4],
} as const;

export const CARD_PAYMENT_TYPES: readonly string[] = [PaymentType.CREDIT_CARD, PaymentType.SQUARE, PaymentType.CLOVER];
export function isCardPaymentType(type: string): boolean {
  return CARD_PAYMENT_TYPES.includes(type);
}

export type PaymentTypeValue = (typeof PAYMENT_TYPES)[number];
const PROVIDER_TO_PAYMENT_TYPE: Record<string, PaymentTypeValue> = {
  square: PaymentType.SQUARE,
  clover: PaymentType.CLOVER,
};
export function providerNameToPaymentType(providerName: string): PaymentTypeValue {
  return PROVIDER_TO_PAYMENT_TYPE[providerName] ?? PaymentType.CREDIT_CARD;
}

export const dateSchema = z.coerce.date<string | Date>()
  .transform((date) => date.toISOString());

const timeFormatRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
export const timeSchema = z.union([
  z.literal(""),
  z.string().regex(timeFormatRegex, "Invalid time format. Use HH:MM (24-hour)"),
]);

export const nameSchema = z.string().min(2, "Name must be at least 2 characters");
export const emailSchema = z.string().email("Invalid email address");
export const positiveIntSchema = z.number().int().positive("Must be a positive number");

export const DEFAULT_WEEKLY_FEE_CENTS = 2000;
export const DEFAULT_TIMEZONE = "America/Chicago";
