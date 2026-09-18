/**
 * Lightweight process-local wake bridge for routes that enqueue durable email
 * work. Keeping this module free of storage/database imports lets route unit
 * tests and request paths use the wake signal without eagerly constructing a
 * database pool. The database remains authoritative; a missing listener only
 * falls back to the scheduler's safety sweep.
 */
type WakeHandler = () => void;

let handler: WakeHandler | null = null;

export function registerAccountActionDeliveryWakeHandler(next: WakeHandler): void {
  handler = next;
}

export function notifyAccountActionDeliveryChanged(): void {
  handler?.();
}
