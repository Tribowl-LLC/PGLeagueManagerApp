let ledgerExecute = false;
let rearmLedgerWake: () => Promise<void> = async () => undefined;

export function configureScheduledPaymentRuntime(input: {
  ledgerExecute: boolean;
  rearm: () => Promise<void>;
}): void {
  ledgerExecute = input.ledgerExecute;
  rearmLedgerWake = input.rearm;
}

export function isScheduledPaymentLedgerExecute(): boolean {
  return ledgerExecute;
}

export async function notifyScheduledPaymentMutation(): Promise<void> {
  if (ledgerExecute) await rearmLedgerWake();
}
