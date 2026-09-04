/**
 * Worker-side cancellation tests for the Apple Pay bulk-register job.
 *
 * Pins the subtle race-condition behaviors documented in
 * `apple-pay-worker.ts`'s `processJob` and `processItemsWithConcurrency`:
 *
 *  1. A job flipped to `canceled` mid-flight stops issuing NEW provider
 *     calls. Already in-flight items finish (we cannot revoke them), but
 *     the rest of the queue is never touched.
 *  2. The worker finalizes such a job as `canceled`, with counts reflecting
 *     ONLY the items that actually completed before the cancel was observed.
 *  3. The catch-block in `processJob` does NOT trample an admin's
 *     cancellation by overwriting status with `failed` when an exception
 *     is raised mid-loop.
 *  4. A cancellation that occurs BEFORE the item-processing loop starts
 *     (between enumeration and item dispatch) is detected and the job is
 *     finalized as `canceled` without issuing any provider calls.
 *
 * The worker imports its dependencies as plain modules (`storage`,
 * `getPaymentProvider`), so we mock those modules. We use a Date.now spy
 * that advances on every read to defeat the 1s cancellation-poll throttle
 * deterministically — without that the test would either be flaky or have
 * to sleep for real wall-clock seconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplePayJob, ApplePayJobItem } from "@shared/schema";
import { expectErrorLog } from "../../../tests/helpers/expected-error-logs";

const storageMock = vi.hoisted(() => ({
  storage: {
    countApplePayJobItems: vi.fn(),
    setApplePayJobTotal: vi.fn(),
    getApplePayJobStatus: vi.fn(),
    getPendingApplePayJobItems: vi.fn(),
    getApplePayJobItemCounts: vi.fn(),
    finalizeApplePayJob: vi.fn(),
    reopenApplePayJobForRetry: vi.fn(),
    claimAndCompleteApplePayJobItem: vi.fn(),
    claimApplePayJobItemForProcessing: vi.fn(),
    claimNextApplePayJob: vi.fn(),
    recoverInterruptedApplePayJobs: vi.fn(),
    getOrganizations: vi.fn(),
  },
}));

const providerFactoryMock = vi.hoisted(() => {
  class ProviderNotConfiguredError extends Error {}
  return {
    getPaymentProvider: vi.fn(),
    ProviderNotConfiguredError,
  };
});

vi.mock("../../storage", () => storageMock);
vi.mock("../payment-provider-factory", () => providerFactoryMock);

// Imported AFTER the mocks above are registered.
const { applePayWorker } = await import("../apple-pay-worker");

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeItems(jobId: number, count: number): ApplePayJobItem[] {
  return Array.from({ length: count }, (_, i): ApplePayJobItem => ({
    id: 1000 + i,
    jobId,
    organizationId: 1,
    locationId: 100 + i,
    domain: `item-${i}.example.test`,
    status: "pending",
    message: null,
    processedAt: null,
    claimedAt: null,
    recoveredCount: 0,
  }));
}

function makeJob(): ApplePayJob {
  // Timestamps on apple_pay_jobs are declared with `mode: "string"` (see
  // shared/schema/apple-pay-jobs.ts), so the inferred TS type is `string`,
  // not `Date`. We pass an ISO string here to match the real shape exactly
  // — the previous `new Date()` + `as unknown as ApplePayJob` cast was
  // hiding that mismatch.
  const now = new Date().toISOString();
  return {
    id: 42,
    status: "running",
    totalDomains: 8,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    errorMessage: null,
    createdBy: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
  };
}

describe("ApplePayWorker — cancellation race conditions", () => {
  let nowVal: number;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Date.now advances 1.5s on every read so `processItemsWithConcurrency`'s
    // 1-second cancel-poll throttle never suppresses a check in this test —
    // every iteration's checkCancel() really polls storage.
    nowVal = 1_000_000;
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      const v = nowVal;
      nowVal += 1500;
      return v;
    });
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it("retries transient startup recovery failures with bounded backoff and kicks once after recovery", async () => {
    vi.useFakeTimers();
    storageMock.storage.recoverInterruptedApplePayJobs
      .mockRejectedValueOnce(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({ revivedJobIds: [], revivedItems: [] });
    storageMock.storage.claimNextApplePayJob.mockResolvedValue(undefined);

    const resume = applePayWorker.resumeOnStartup();
    await vi.advanceTimersByTimeAsync(250);
    await resume;
    await vi.runAllTimersAsync();

    expect(storageMock.storage.recoverInterruptedApplePayJobs).toHaveBeenCalledTimes(2);
    expect(storageMock.storage.claimNextApplePayJob).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("stops issuing new provider calls after the job flips to canceled mid-flight, and finalizes as canceled", async () => {
    const job = makeJob();
    const items = makeItems(job.id, 8);

    storageMock.storage.countApplePayJobItems.mockResolvedValue(items.length);
    storageMock.storage.setApplePayJobTotal.mockResolvedValue(undefined);
    storageMock.storage.getPendingApplePayJobItems.mockResolvedValue(items);
    storageMock.storage.claimApplePayJobItemForProcessing.mockResolvedValue(true);
    storageMock.storage.claimAndCompleteApplePayJobItem.mockResolvedValue(true);

    // Status starts running; flips to canceled once the first 4 in-flight
    // provider calls have been observed.
    let status: string = "running";
    storageMock.storage.getApplePayJobStatus.mockImplementation(async () => status);

    storageMock.storage.getApplePayJobItemCounts.mockResolvedValue({
      succeeded: 4,
      failed: 0,
      skipped: 0,
      pending: 4,
    });
    storageMock.storage.finalizeApplePayJob.mockResolvedValue(undefined);

    // Provider call: hold each call until released. We use this gate to
    // guarantee the first batch is in-flight when we flip cancellation.
    const inFlightGates: Deferred<{ success: boolean; message: string }>[] = [];
    const inFlightStarted: Deferred<void>[] = [];
    const provider = {
      registerApplePayDomain: vi.fn(async () => {
        const gate = deferred<{ success: boolean; message: string }>();
        const started = deferred<void>();
        inFlightGates.push(gate);
        inFlightStarted.push(started);
        started.resolve();
        return gate.promise;
      }),
    };
    providerFactoryMock.getPaymentProvider.mockResolvedValue(provider);

    // Drive processJob directly — bypasses the kick/loop so the test owns
    // the lifecycle.
    const runPromise = applePayWorker.processJob(job);

    // Wait for exactly the concurrency-limit number (4) of provider calls
    // to have started. We poll on inFlightStarted.length to avoid a
    // brittle setTimeout race.
    await waitUntil(() => inFlightStarted.length === 4);

    // Flip the job to canceled now that 4 items are mid-call. The other
    // 4 items have NOT been dispatched yet — that's the invariant.
    status = "canceled";

    // Resolve the in-flight provider calls so the workers loop back and
    // re-check cancellation before picking up the next item.
    for (const gate of inFlightGates) {
      gate.resolve({ success: true, message: "ok" });
    }

    await runPromise;

    // Provider was only called for the 4 in-flight items. Items 5-8 must
    // never have been dispatched.
    expect(provider.registerApplePayDomain).toHaveBeenCalledTimes(4);
    expect(storageMock.storage.claimApplePayJobItemForProcessing).toHaveBeenCalledTimes(4);

    // recordCanceled finalized as `canceled`, with counts intact (the
    // 4 succeeded items are still reflected; the 4 untouched stay pending
    // as far as the source of truth is concerned).
    expect(storageMock.storage.finalizeApplePayJob).toHaveBeenCalledTimes(1);
    expect(storageMock.storage.finalizeApplePayJob).toHaveBeenCalledWith(job.id, {
      status: "canceled",
      succeededCount: 4,
      failedCount: 0,
      skippedCount: 0,
      errorMessage: null,
    });
  });

  it("detects cancellation that arrived BEFORE the item-processing loop starts and finalizes without any provider calls", async () => {
    const job = makeJob();
    const items = makeItems(job.id, 3);

    storageMock.storage.countApplePayJobItems.mockResolvedValue(items.length);
    storageMock.storage.getPendingApplePayJobItems.mockResolvedValue(items);
    // Already canceled by the time processJob runs the pre-loop check.
    storageMock.storage.getApplePayJobStatus.mockResolvedValue("canceled");
    storageMock.storage.getApplePayJobItemCounts.mockResolvedValue({
      succeeded: 0,
      failed: 0,
      skipped: 0,
      pending: 3,
    });
    storageMock.storage.finalizeApplePayJob.mockResolvedValue(undefined);

    const provider = { registerApplePayDomain: vi.fn() };
    providerFactoryMock.getPaymentProvider.mockResolvedValue(provider);

    await applePayWorker.processJob(job);

    // The pre-loop cancellation guard runs BEFORE getPendingApplePayJobItems.
    // Even if that read happened, no items are dispatched.
    expect(provider.registerApplePayDomain).not.toHaveBeenCalled();
    expect(storageMock.storage.claimApplePayJobItemForProcessing).not.toHaveBeenCalled();

    expect(storageMock.storage.finalizeApplePayJob).toHaveBeenCalledTimes(1);
    expect(storageMock.storage.finalizeApplePayJob).toHaveBeenCalledWith(job.id, {
      status: "canceled",
      succeededCount: 0,
      failedCount: 0,
      skippedCount: 0,
      errorMessage: null,
    });
  });

  it("does NOT trample a cancellation with a `failed` finalize when the catch-block also runs", async () => {
    const job = makeJob();
    expectErrorLog(/\[ApplePayWorker\] Job aborted with error/);

    storageMock.storage.countApplePayJobItems.mockResolvedValue(2);
    // Make getPendingApplePayJobItems throw so processJob's OUTER try/catch
    // fires. (Errors raised inside processItem are caught by processItem's
    // own try/catch and surface as a per-item `failed` write, which would
    // not exercise the outer catch.)
    storageMock.storage.getPendingApplePayJobItems.mockRejectedValue(
      new Error("transient db blip while loading pending items"),
    );
    storageMock.storage.getApplePayJobItemCounts.mockResolvedValue({
      succeeded: 1,
      failed: 0,
      skipped: 0,
      pending: 1,
    });
    storageMock.storage.finalizeApplePayJob.mockResolvedValue(undefined);

    // First call (pre-loop) returns "running" so we enter the body and
    // the throw above fires. The second call (inside the catch block)
    // returns "canceled" — emulating an admin who hit cancel between
    // the pre-loop check and the failure. The catch block MUST respect
    // that cancellation and not stomp on it with status='failed'.
    let calls = 0;
    storageMock.storage.getApplePayJobStatus.mockImplementation(async () => {
      calls++;
      return calls <= 1 ? "running" : "canceled";
    });

    await applePayWorker.processJob(job);

    expect(storageMock.storage.finalizeApplePayJob).toHaveBeenCalledTimes(1);
    const finalizeCall = storageMock.storage.finalizeApplePayJob.mock.calls[0];
    // The catch-block MUST defer to the cancellation: status='canceled',
    // not 'failed' — and must NOT carry the thrown error message into the
    // canceled finalize.
    expect(finalizeCall[1].status).toBe("canceled");
    expect(finalizeCall[1].errorMessage).toBeNull();
  });

  it("DOES finalize as `failed` when the loop throws and the job was not canceled (and items are all terminal)", async () => {
    // Mirror image of the previous test: when there's no cancellation
    // AND every item already reached a terminal state (so nothing is
    // stranded), the catch-block must surface the underlying error as
    // a normal `failed` finalize. This proves the previous test isn't
    // passing because the catch-block always writes `canceled`, AND
    // proves the #568 finalize-guard isn't a blanket "never finalize
    // from the catch-block" — it only refuses when there's still a
    // non-terminal item to strand.
    const job = makeJob();
    expectErrorLog(/\[ApplePayWorker\] Job aborted with error/);

    storageMock.storage.countApplePayJobItems.mockResolvedValue(2);
    storageMock.storage.getPendingApplePayJobItems.mockRejectedValue(
      new Error("network exploded"),
    );
    storageMock.storage.getApplePayJobItemCounts.mockResolvedValue({
      succeeded: 1,
      failed: 1,
      skipped: 0,
      // pending=0 so the #568 guard doesn't reopen — finalize-as-failed
      // is the correct behavior here because no item is being stranded.
      pending: 0,
    });
    storageMock.storage.finalizeApplePayJob.mockResolvedValue(undefined);
    // Both checks return "running" — no cancellation involved.
    storageMock.storage.getApplePayJobStatus.mockResolvedValue("running");

    await applePayWorker.processJob(job);

    const finalizeCall = storageMock.storage.finalizeApplePayJob.mock.calls[0];
    expect(finalizeCall[1].status).toBe("failed");
    expect(finalizeCall[1].errorMessage).toBe("network exploded");
  });

  it("REOPENS instead of finalizing when the catch-block counts query also fails (#568 transient-DB hardening)", async () => {
    // Hardening for #568: if the loop throws AND the catch-block's
    // own counts query also fails (e.g. transient DB blip), we
    // previously defaulted counts to all-zeroes and wrote a junk
    // `failed` row with succeeded=0/failed=0/skipped=0. That junk
    // row would still strand items because we never actually knew
    // their state. Correct behavior is to defer (reopen) and let
    // the next worker tick re-evaluate when the DB is healthy.
    const job = makeJob();
    expectErrorLog(/\[ApplePayWorker\] Job aborted with error/);

    storageMock.storage.countApplePayJobItems.mockResolvedValue(2);
    storageMock.storage.getPendingApplePayJobItems.mockRejectedValue(
      new Error("network exploded"),
    );
    // Both the in-loop counts read AND the catch-block counts read fail.
    storageMock.storage.getApplePayJobItemCounts.mockRejectedValue(
      new Error("DB connection lost"),
    );
    storageMock.storage.finalizeApplePayJob.mockResolvedValue(undefined);
    storageMock.storage.reopenApplePayJobForRetry.mockResolvedValue(true);
    storageMock.storage.getApplePayJobStatus.mockResolvedValue("running");

    await applePayWorker.processJob(job);

    // Critical: NO terminal write happened. The job stays alive
    // for the next worker tick.
    expect(storageMock.storage.finalizeApplePayJob).not.toHaveBeenCalled();
    expect(storageMock.storage.reopenApplePayJobForRetry).toHaveBeenCalledWith(job.id);
  });
});

/**
 * Finalize-side guard tests for the resume-after-crash path (#568).
 *
 * Pins the rule that a job MUST NOT be terminalized while any of its
 * items are still in a non-terminal state. The bug originally surfaced
 * on job #523 where a crash + recover sequence left one item at
 * `pending` with `recovered_count = 1` while the parent job was already
 * `failed` with `completed_at` stamped — a stranded item the worker
 * would never pick up again. The fix re-drains any leftover pending
 * items in the same processJob call; if items are STILL non-terminal
 * after that bounded retry (e.g. a sibling instance is mid-call on a
 * row whose pre-call lease is still fresh), the job is reopened to
 * `pending` so the next worker tick re-claims it instead of writing
 * a terminal status.
 */
describe("ApplePayWorker — finalize guard for non-terminal items", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-drains items revived between the initial pending snapshot and finalize, then finalizes correctly", async () => {
    // Reproduces the job #523 sequence: after a crash + startup recovery,
    // the job is re-claimed and processed — but one item didn't make it
    // through the first pass (it was revived AFTER getPendingApplePayJobItems
    // was called). The worker must re-fetch and process the leftover before
    // finalizing, otherwise the item is silently stranded.
    const job = makeJob();
    const firstPassItems = makeItems(job.id, 2);
    const lateRevivedItem: ApplePayJobItem = {
      ...firstPassItems[0],
      id: 9999,
      domain: "late-revived.example.test",
      // The late-revived item has no location, so processItem will
      // mark it `skipped` — exercising the (real) item resolution path.
      locationId: null,
    };

    // First pending() call returns the initial snapshot. Second call
    // (the bounded re-drain) returns the late-revived item.
    storageMock.storage.countApplePayJobItems.mockResolvedValue(2);
    storageMock.storage.getApplePayJobStatus.mockResolvedValue("running");
    storageMock.storage.getPendingApplePayJobItems
      .mockResolvedValueOnce(firstPassItems)
      .mockResolvedValueOnce([lateRevivedItem]);

    storageMock.storage.claimApplePayJobItemForProcessing.mockResolvedValue(true);
    storageMock.storage.claimAndCompleteApplePayJobItem.mockResolvedValue(true);
    const provider = {
      registerApplePayDomain: vi.fn(async () => ({ success: true, message: "ok" })),
    };
    providerFactoryMock.getPaymentProvider.mockResolvedValue(provider);

    // Counts call #1 (after re-drain) reports the late-revived item as
    // already terminal — drain succeeded, no leftover. The roll-up rules
    // (today: 2 succeeded + 1 skipped → `partial`) are unchanged.
    storageMock.storage.getApplePayJobItemCounts.mockResolvedValue({
      succeeded: 2,
      failed: 0,
      skipped: 1,
      pending: 0,
    });
    storageMock.storage.finalizeApplePayJob.mockResolvedValue(undefined);

    await applePayWorker.processJob(job);

    // Two calls to getPendingApplePayJobItems prove the re-drain ran.
    expect(storageMock.storage.getPendingApplePayJobItems).toHaveBeenCalledTimes(2);
    // The late-revived item went through processItem (no-location path).
    expect(storageMock.storage.claimAndCompleteApplePayJobItem).toHaveBeenCalledWith(
      lateRevivedItem.id,
      expect.objectContaining({ status: "skipped" }),
    );
    // No reopen — the drain succeeded.
    expect(storageMock.storage.reopenApplePayJobForRetry).not.toHaveBeenCalled();
    // Final write reflects the items table exactly.
    expect(storageMock.storage.finalizeApplePayJob).toHaveBeenCalledTimes(1);
    expect(storageMock.storage.finalizeApplePayJob).toHaveBeenCalledWith(job.id, {
      status: "partial",
      succeededCount: 2,
      failedCount: 0,
      skippedCount: 1,
      errorMessage: null,
    });
  });

  it("refuses to finalize when items are still non-terminal after the bounded re-drain, reopens job to pending instead", async () => {
    // Reproduces the rolling-restart scenario: a sibling instance is
    // mid-call on an item whose pre-call lease is still fresh. The
    // local `processing` row is invisible to getPendingApplePayJobItems
    // (which only matches status='pending'), so the re-drain does
    // nothing — but the counts call still reports it under `pending`.
    // Writing a terminal status here would silently strand the row,
    // so the worker MUST hand the job back to the pending queue.
    const job = makeJob();
    const firstPassItems = makeItems(job.id, 1);

    storageMock.storage.countApplePayJobItems.mockResolvedValue(2);
    storageMock.storage.getApplePayJobStatus.mockResolvedValue("running");
    // Initial snapshot returns one pending item; re-drain finds none
    // (the still-`processing` sibling row doesn't match status='pending').
    storageMock.storage.getPendingApplePayJobItems
      .mockResolvedValueOnce(firstPassItems)
      .mockResolvedValueOnce([]);

    storageMock.storage.claimApplePayJobItemForProcessing.mockResolvedValue(true);
    storageMock.storage.claimAndCompleteApplePayJobItem.mockResolvedValue(true);
    const provider = {
      registerApplePayDomain: vi.fn(async () => ({ success: true, message: "ok" })),
    };
    providerFactoryMock.getPaymentProvider.mockResolvedValue(provider);

    // Counts after re-drain: 1 succeeded (this worker's item) + 1 still
    // pending/processing (the sibling's). pending > 0 must trigger reopen,
    // not finalize.
    storageMock.storage.getApplePayJobItemCounts.mockResolvedValue({
      succeeded: 1,
      failed: 0,
      skipped: 0,
      pending: 1,
    });
    storageMock.storage.reopenApplePayJobForRetry.mockResolvedValue(true);

    await applePayWorker.processJob(job);

    // No terminal write — that's the whole point of the guard.
    expect(storageMock.storage.finalizeApplePayJob).not.toHaveBeenCalled();
    // Job was reopened so the next worker tick can resume.
    expect(storageMock.storage.reopenApplePayJobForRetry).toHaveBeenCalledTimes(1);
    expect(storageMock.storage.reopenApplePayJobForRetry).toHaveBeenCalledWith(job.id);
  });

  it("catch-block also refuses to write `failed` while items are non-terminal — reopens job to pending instead", async () => {
    // Mirror image of the happy-path guard: a thrown error mid-loop
    // must not strand items either. The catch-block previously called
    // finalizeApplePayJob with status='failed' unconditionally, which
    // is exactly how a transient blip during enumeration could
    // terminalize a job that had pending items left over.
    const job = makeJob();
    expectErrorLog(/\[ApplePayWorker\] Job aborted with error/);

    storageMock.storage.countApplePayJobItems.mockResolvedValue(2);
    storageMock.storage.getPendingApplePayJobItems
      // First call (inside the try) throws to enter the catch-block.
      .mockRejectedValueOnce(new Error("transient db blip"))
      // Catch-block re-drain: finds one item that's now pending.
      .mockResolvedValueOnce([]);
    storageMock.storage.getApplePayJobStatus.mockResolvedValue("running");
    storageMock.storage.getApplePayJobItemCounts.mockResolvedValue({
      succeeded: 0,
      failed: 0,
      skipped: 0,
      pending: 2,
    });
    storageMock.storage.reopenApplePayJobForRetry.mockResolvedValue(true);

    await applePayWorker.processJob(job);

    // Critically: no `failed` finalize. The previous behavior would
    // have terminalized the job here, stranding both items.
    expect(storageMock.storage.finalizeApplePayJob).not.toHaveBeenCalled();
    expect(storageMock.storage.reopenApplePayJobForRetry).toHaveBeenCalledWith(job.id);
  });

  it("catch-block STILL writes `failed` when no items are left non-terminal (counts.pending === 0)", async () => {
    // Proves the catch-block guard isn't a blanket "never write failed".
    // When the items table is fully terminal, finalizing as `failed`
    // with the underlying error is the correct behavior — and matches
    // the pre-#568 contract for genuine errors.
    const job = makeJob();
    expectErrorLog(/\[ApplePayWorker\] Job aborted with error/);

    storageMock.storage.countApplePayJobItems.mockResolvedValue(2);
    storageMock.storage.getPendingApplePayJobItems.mockRejectedValue(
      new Error("network exploded"),
    );
    storageMock.storage.getApplePayJobStatus.mockResolvedValue("running");
    storageMock.storage.getApplePayJobItemCounts.mockResolvedValue({
      succeeded: 1,
      failed: 1,
      skipped: 0,
      pending: 0,
    });
    storageMock.storage.finalizeApplePayJob.mockResolvedValue(undefined);

    await applePayWorker.processJob(job);

    expect(storageMock.storage.reopenApplePayJobForRetry).not.toHaveBeenCalled();
    expect(storageMock.storage.finalizeApplePayJob).toHaveBeenCalledTimes(1);
    const finalizeCall = storageMock.storage.finalizeApplePayJob.mock.calls[0];
    expect(finalizeCall[1].status).toBe("failed");
    expect(finalizeCall[1].errorMessage).toBe("network exploded");
  });
});

/**
 * Tiny polling helper: avoids hard-coded sleeps by waiting until the
 * predicate is true or a generous timeout elapses. Yields to the event
 * loop on every iteration so promise microtasks can run.
 */
async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  stepMs = 5,
): Promise<void> {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error("waitUntil: timed out waiting for predicate");
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
