export interface AutopaySetupQuote {
  quoteFingerprint: string;
  generatedAt: string;
  immediateAmountMinor: number;
  coveredOccurrences: Array<{
    bowlerId: number;
    occurrenceAt: string;
    localDate: string;
    classification: "past_due" | "due_today";
    amountMinor: number;
  }>;
  firstAutomaticAt: string | null;
  firstAutomaticLocalDate: string | null;
  firstAutomaticAmountMinor: number;
  recurringAmountMinor: number;
  timezone: string;
  competitionStartTime: string;
  resuming: boolean;
}
