import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  clampPaymentWeekCount,
  clearWalletRequestKeyForTerminalStatus,
  hasPositivePaymentEvidence,
  MakePaymentReadError,
  resolveSavedCardReadState,
  resetPaymentSelectionForLeagueChange,
  shouldReinitializeOneTimeCardEditor,
} from "@/pages/make-payment-page";

vi.mock("@/components/bowler-layout", () => ({ BowlerLayout: ({ children }: { children: ReactNode }) => <div data-testid="bowler-layout">{children}</div> }));

describe("dedicated make-payment guards", () => {
  it.each(["failed_terminal", "canceled", "action_required"])("clears the in-memory wallet key for terminal HTTP-202 status %s", (status) => {
    const requestKeyRef = { current: "wallet-request-key" };
    clearWalletRequestKeyForTerminalStatus(status, requestKeyRef);
    expect(requestKeyRef.current).toBeNull();
  });

  it("keeps the wallet key while the provider outcome is unresolved", () => {
    const requestKeyRef = { current: "wallet-request-key" };
    clearWalletRequestKeyForTerminalStatus("provider_unknown", requestKeyRef);
    expect(requestKeyRef.current).toBe("wallet-request-key");
  });

  it("reinitializes an unsaved-card editor after a partial payment when no card was saved", () => {
    expect(shouldReinitializeOneTimeCardEditor("new", 0)).toBe(true);
    expect(shouldReinitializeOneTimeCardEditor("new", 1)).toBe(false);
    expect(shouldReinitializeOneTimeCardEditor("saved", 0)).toBe(false);
  });

  it("resets week count and past-due intent when changing leagues", () => {
    expect(resetPaymentSelectionForLeagueChange()).toEqual({ weekCount: 1, intentApplied: false });
  });

  it.each([
    [false, false, false, false, "idle"],
    [true, false, true, false, "loading"],
    [true, false, false, false, "loading"],
    [true, false, false, true, "unavailable"],
    [true, true, false, false, "ready"],
    [true, true, false, true, "ready"],
  ] as const)("resolves saved-card data state without loading disabled queries or discarding cached data", (isEnabled, hasResponse, isLoading, hasError, expected) => {
    expect(resolveSavedCardReadState(isEnabled, hasResponse, isLoading, hasError)).toBe(expected);
  });

  it.each([
    [4, 2, 2],
    [0, 2, 1],
    [2, 4, 2],
    [3, 0, 1],
  ])("clamps selected weeks after options shrink (%s, max %s)", (selected, maximum, expected) => {
    expect(clampPaymentWeekCount(selected, maximum)).toBe(expected);
  });

  it("requires positive allocation evidence before showing paid in full", () => {
    expect(hasPositivePaymentEvidence([])).toBe(false);
    expect(hasPositivePaymentEvidence([{ allocatedMinor: 0, outstandingMinor: 0, state: "settled", reviewRequired: false }])).toBe(false);
    expect(hasPositivePaymentEvidence([{ allocatedMinor: 1, outstandingMinor: 0, state: "settled", reviewRequired: false }])).toBe(true);
  });

  it("fails closed when review-required outstanding evidence accompanies a positive allocation", () => {
    expect(hasPositivePaymentEvidence([
      { allocatedMinor: 100, outstandingMinor: 0, state: "settled", reviewRequired: false },
      { allocatedMinor: 100, outstandingMinor: 50, state: "open", reviewRequired: true },
    ])).toBe(false);
  });

  it("fails closed for non-voided review evidence even with zero outstanding balance", () => {
    expect(hasPositivePaymentEvidence([
      { allocatedMinor: 100, outstandingMinor: 0, state: "settled", reviewRequired: false },
      { allocatedMinor: 0, outstandingMinor: 0, state: "settled", reviewRequired: true },
    ])).toBe(false);
  });

  it("keeps payment-read failures inside the bowler layout with retry and history navigation", async () => {
    const retry = vi.fn();
    render(<MakePaymentReadError message="Payment balance data could not be loaded. Try again." onRetry={retry} leagueId={17} />);
    expect(screen.getByTestId("bowler-layout")).toBeInTheDocument();
    expect(screen.getByText("Payment balance data could not be loaded. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "view payment history" })).toHaveAttribute("href", "/payment-history?leagueId=17");
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
