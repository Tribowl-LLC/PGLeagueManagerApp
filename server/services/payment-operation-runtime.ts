let ledgerExecute = false;
let rearmLedgerWake: () => Promise<void> = async () => undefined;

export function configurePaymentOperationRuntime(input: {
  ledgerExecute: boolean;
  rearm: () => Promise<void>;
}): void {
  ledgerExecute = input.ledgerExecute;
  rearmLedgerWake = input.rearm;
}

export async function notifyPaymentOperationMutation(): Promise<void> {
  if (ledgerExecute) await rearmLedgerWake();
}
