import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BowlerWithAccount, League } from "@shared/schema";
import type { RotatingCreditBalanceWire, RotatingCreditRefundQuoteWire } from "@shared/rotating-credit-contract";
import type { RosterPaymentResponsibilityReadContractV2 } from "@shared/roster-payment-contract";
import type { TeamBowlerEntry } from "@/lib/bowler-league-utils";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queryClient")>()),
  apiRequest: mocks.apiRequest,
}));
vi.mock("@/lib/rotating-payment-fingerprint", () => ({
  fingerprintCanonicalRequest: vi.fn(async (prefix: string) => `${prefix}:${"a".repeat(64)}`),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

import { RotatingPaymentsPanel } from "@/pages/team-view-page/rotating-payments-panel";

const occurrenceId = "00000000-0000-4000-8000-000000000001";
const baseRoster: RosterPaymentResponsibilityReadContractV2 = {
  contractVersion: "roster-payment-responsibility/2",
  organizationId: 1,
  leagueId: 1,
  payingLineupSize: 3,
  weeklyFee: 2_000,
  lineageFee: null,
  prizeFundFee: null,
  substituteAccess: "team_only",
  substitutePaymentRegime: "team_choice",
  ready: true,
  incompleteTeamIds: [],
  occurrences: [{ id: occurrenceId, startAt: "2038-01-03T03:00:00.000Z", occurrenceLocalDate: "2038-01-02", plannedOrdinal: 1, billingOrdinal: 1, status: "scheduled" }],
  teams: [{
    id: 9,
    name: "Team Nine",
    number: 9,
    policy: "main_pays_full",
    eligibleRotatingBowlerIds: [10, 11],
    slots: [
      { teamId: 9, slotIndex: 0, occupant: "main", mainBowlerId: 10, currentRevision: 1 },
      { teamId: 9, slotIndex: 1, occupant: "rotating", mainBowlerId: null, currentRevision: 1 },
      { teamId: 9, slotIndex: 2, occupant: "vacant", mainBowlerId: null, currentRevision: 1 },
    ],
  }],
  rotationAssignments: [{ occurrenceId, teamId: 9, slotIndex: 1, responsibilityId: null, obligationIds: [], assignmentId: null, actualBowlerId: null, revision: null, assignedAt: null, recordedByUserId: null }],
  occurrenceResponsibilities: [],
  substituteBowlerOptions: [],
};

const mainOnlyRoster: RosterPaymentResponsibilityReadContractV2 = {
  ...baseRoster,
  teams: [{
    ...baseRoster.teams[0],
    eligibleRotatingBowlerIds: [],
    slots: [
      { teamId: 9, slotIndex: 0, occupant: "main", mainBowlerId: 10, currentRevision: 1 },
      { teamId: 9, slotIndex: 1, occupant: "vacant", mainBowlerId: null, currentRevision: 1 },
      { teamId: 9, slotIndex: 2, occupant: "unassigned", mainBowlerId: null, currentRevision: 1 },
    ],
  }],
  rotationAssignments: [],
};
const confirmedRoster: RosterPaymentResponsibilityReadContractV2 = {
  ...baseRoster,
  rotationAssignments: [{ ...baseRoster.rotationAssignments[0], actualBowlerId: 11, revision: 1 }],
};
const formerPoolMemberRoster: RosterPaymentResponsibilityReadContractV2 = {
  ...baseRoster,
  teams: [{ ...baseRoster.teams[0], eligibleRotatingBowlerIds: [11] }],
  rotationAssignments: [{ ...baseRoster.rotationAssignments[0], actualBowlerId: 12, revision: 1 }],
};

// The view consumes only the active/name/id subset in this panel test.
const teamBowlers = [10, 11, 12].map((id) => ({
  bowler: { id, name: id === 10 ? "Main One" : `Member ${id}`, active: true },
  bowlerLeague: { id: id + 100, bowlerId: id, leagueId: 1, teamId: 9, active: true },
})) as TeamBowlerEntry<BowlerWithAccount>[];
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const league = { id: 1, timezone: "America/Detroit", payingLineupSize: 3 } as League;
const refundFundingId = "00000000-0000-4000-8000-000000000002";

function creditBalance(
  bowlerId: number,
  totals: { availableMinor?: number; refundHeldMinor?: number; reviewHeldMinor?: number; refundedMinor?: number } = {},
): RotatingCreditBalanceWire {
  const availableMinor = totals.availableMinor ?? 1_200;
  const refundHeldMinor = totals.refundHeldMinor ?? 0;
  const reviewHeldMinor = totals.reviewHeldMinor ?? 0;
  const refundedMinor = totals.refundedMinor ?? 0;
  return {
    contractVersion: "rotating-credit-balance/1",
    organizationId: 1,
    leagueId: 1,
    bowlerId,
    eligibleForCredit: false,
    shareAmountMinor: 2_000,
    currency: "USD",
    fundedMinor: 1_200,
    availableMinor,
    appliedMinor: 0,
    refundedMinor,
    refundHeldMinor,
    reviewHeldMinor,
    lots: [{
      fundingId: refundFundingId,
      paymentId: 42,
      amountMinor: 1_200,
      availableMinor,
      appliedMinor: 0,
      refundedMinor,
      refundHeldMinor,
      reviewHeldMinor,
      paymentType: "square",
      createdAt: "2038-01-01T00:00:00.000Z",
      receiptAvailable: false,
      receiptUrl: null,
      receiptNumber: null,
      receiptEmailMissing: false,
    }],
    applications: [],
  };
}

function refundQuote(providerRefundAvailable: boolean): RotatingCreditRefundQuoteWire {
  return {
    contractVersion: "rotating-credit-refund-quote/1",
    organizationId: 1,
    leagueId: 1,
    bowlerId: 12,
    fundingId: refundFundingId,
    paymentId: 42,
    currency: "USD",
    amountMinor: 1_200,
    providerRefundAvailable,
    fingerprint: `lvrotcrrefundquote:v1:${"c".repeat(64)}`,
  };
}

function renderPanel(roster = baseRoster, financeRows: unknown[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async ({ queryKey }) => {
          const path = String(queryKey[0]);
          if (path.endsWith("/rotating-credit/admin/teams/9/members/1")) {
            return { success: true, data: { members: [
              { bowlerId: 11, name: "Member 11", activeRotationMember: true },
              { bowlerId: 12, name: "Member 12", activeRotationMember: false },
            ] } };
          }
          const adminBalanceBowler = /\/rotating-credit\/admin\/(\d+)\/1$/.exec(path)?.[1];
          if (adminBalanceBowler) return { success: true, data: creditBalance(Number(adminBalanceBowler)) };
          return {
            success: true,
            data: {
              contractVersion: "canonical-due-past-due/3",
              orderVersion: "due-at,owner,occurrence,obligation/3",
              authoritativeSource: "payment_obligations",
              organizationId: 1,
              leagueId: 1,
              asOf: "2038-01-01T00:00:00.000Z",
              rows: financeRows,
              totals: { amountMinor: 2_000, allocatedMinor: 0, outstandingMinor: 2_000, collectiblePastDueMinor: 0, reviewCount: 0, settledCount: 0, voidedCount: 0 },
            },
          };
        },
      },
    },
  });
  const view = render(<QueryClientProvider client={queryClient}><RotatingPaymentsPanel
    leagueId={1}
    teamId={9}
    league={league}
    teamBowlers={teamBowlers}
    canManage
    roster={roster}
    rosterLoading={false}
    rosterError={undefined}
    onReloadRoster={async () => ({})}
  /></QueryClientProvider>);
  return view;
}

afterEach(() => {
  mocks.apiRequest.mockReset();
  mocks.toast.mockReset();
});

describe("RotatingPaymentsPanel", () => {
  it("lets a manager confirm a rotating bowler without credit", async () => {
    renderPanel(baseRoster, [{
      id: "obligation-1",
      organizationId: 1,
      leagueId: 1,
      occurrenceId,
      responsibilityId: "responsibility-1",
      teamId: 9,
      component: "full",
      payerBowlerId: null,
      owner: { kind: "team", teamId: 9 },
      actualBowlerId: 11,
      occurrenceLocalDate: "2038-01-02",
      plannedOrdinal: 1,
      billingOrdinal: 1,
      amountMinor: 2_000,
      currency: "USD",
      dueAt: "2038-01-03T03:00:00.000Z",
      pastDueAt: "2038-01-10T03:00:00.000Z",
      state: "open",
      allocatedMinor: 0,
      grossAllocatedMinor: 0,
      refundedMinor: 0,
      waivedMinor: 0,
      stillOwed: true,
      outstandingMinor: 2_000,
      classification: "future",
      reviewRequired: false,
    }]);

    expect(screen.getByText(/confirming a lineup does not require prepaid credit/i)).toBeInTheDocument();
    const bowlerSelect = screen.getByRole("combobox", { name: "Confirmed bowler for rotating position 2" });
    expect(Array.from((bowlerSelect as HTMLSelectElement).options).map((option) => option.textContent)).not.toContain("Main One");
    fireEvent.change(bowlerSelect, { target: { value: "11" } });
    mocks.apiRequest.mockResolvedValue({ success: true, data: {} });
    fireEvent.click(screen.getByRole("button", { name: "Confirm lineup" }));

    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledOnce());
    const [url, method, body] = mocks.apiRequest.mock.calls[0] as [string, string, { assignments: Array<Record<string, unknown>> }];
    expect(url).toBe("/api/financials/leagues/1/roster-payment-responsibility/2/rotating-assignments");
    expect(method).toBe("POST");
    expect(body.assignments).toEqual([{
      occurrenceId,
      teamId: 9,
      slotIndex: 1,
      expectedRevision: null,
      actualBowlerId: 11,
    }]);
  });

  it("shows the authoritative unpaid remainder for a confirmed rotating bowler", async () => {
    renderPanel(confirmedRoster, [{
      id: "obligation-1",
      organizationId: 1,
      leagueId: 1,
      occurrenceId,
      responsibilityId: "responsibility-1",
      teamId: 9,
      component: "full",
      payerBowlerId: null,
      owner: { kind: "team", teamId: 9 },
      actualBowlerId: 11,
      occurrenceLocalDate: "2038-01-02",
      plannedOrdinal: 1,
      billingOrdinal: 1,
      amountMinor: 2_000,
      currency: "USD",
      dueAt: "2038-01-03T03:00:00.000Z",
      pastDueAt: "2038-01-10T03:00:00.000Z",
      state: "open",
      allocatedMinor: 0,
      grossAllocatedMinor: 0,
      refundedMinor: 0,
      waivedMinor: 0,
      stillOwed: true,
      outstandingMinor: 2_000,
      classification: "future",
      reviewRequired: false,
    }]);

    expect(await screen.findByText("Unpaid · $20.00 remaining")).toBeInTheDocument();
  });

  it("preserves a former rotating bowler in history and allows a reasoned correction", async () => {
    mocks.apiRequest.mockResolvedValue({ success: true, data: {} });
    renderPanel(formerPoolMemberRoster);
    const bowlerSelect = screen.getByRole("combobox", { name: "Confirmed bowler for rotating position 2" });
    const formerBowlerOption = bowlerSelect.querySelector('option[value="12"]');

    expect(formerBowlerOption).toHaveTextContent("Member 12 · no longer eligible");
    expect(formerBowlerOption).toBeDisabled();
    expect(bowlerSelect).toHaveValue("12");
    fireEvent.change(bowlerSelect, { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Correction reason for position 2" }), {
      target: { value: "Member left the rotating pool." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm lineup" }));

    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledOnce());
    const [, , body] = mocks.apiRequest.mock.calls[0] as [string, string, { assignments: Array<Record<string, unknown>> }];
    expect(body.assignments).toEqual([{
      occurrenceId,
      teamId: 9,
      slotIndex: 1,
      expectedRevision: 1,
      actualBowlerId: null,
      correctionReason: "Member left the rotating pool.",
    }]);
  });

  it("says a staff payment remains available credit when no date receives it", async () => {
    mocks.apiRequest.mockImplementation(async (url: string) => url.endsWith("/manual/quote/1")
      ? { success: true, data: {
        contractVersion: "rotating-credit-manual-quote/1",
        organizationId: 1,
        leagueId: 1,
        bowlerId: 11,
        currency: "USD",
        amountMinor: 2_000,
        currentAvailableMinor: 0,
        expectedAvailableAfterPurchaseMinor: 2_000,
        advisoryApplications: [],
        fingerprint: `lvrotcrquote:v1:${"b".repeat(64)}`,
      } }
      : { success: true, data: {
        contractVersion: "rotating-credit-operation/1",
        operationId: null,
        fundingId: "funding-1",
        status: "succeeded",
        paymentId: 19,
        providerPaymentId: null,
        fundedMinor: 2_000,
        applications: [],
        balance: { availableMinor: 2_000 },
      } });
    renderPanel();

    fireEvent.change(screen.getByLabelText("Rotating member"), { target: { value: "11" } });
    fireEvent.change(screen.getByLabelText(/Amount received/), { target: { value: "20.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Get staff payment quote" }));
    expect(await screen.findByText("Server-confirmed amount")).toBeInTheDocument();
    expect(screen.getByText("No confirmed date currently needs this payment. The full tender amount will remain the member’s personal credit until an eligible date is confirmed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Record cash · $20.00" }));

    expect(await screen.findByText("No confirmed date received credit yet; the unused amount remains in the member’s personal available credit.")).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      description: "$20.00 received as credit; no confirmed dates needed credit, so it remains available.",
    }));
  });

  it("locks a manual tender after an ambiguous response and retries with the same idempotency key", async () => {
    const recordBodies: Record<string, unknown>[] = [];
    mocks.apiRequest.mockImplementation(async (url: string, _method: string, body: Record<string, unknown>) => {
      if (url.endsWith("/manual/quote/1")) return { success: true, data: {
        contractVersion: "rotating-credit-manual-quote/1",
        organizationId: 1,
        leagueId: 1,
        bowlerId: 11,
        currency: "USD",
        amountMinor: 2_000,
        currentAvailableMinor: 0,
        expectedAvailableAfterPurchaseMinor: 2_000,
        advisoryApplications: [],
        fingerprint: `lvrotcrquote:v1:${"b".repeat(64)}`,
      } };
      if (url.endsWith("/manual/1")) {
        recordBodies.push(body);
        if (recordBodies.length === 1) throw new Error("Connection lost before the server response.");
        return { success: true, data: {
          contractVersion: "rotating-credit-operation/1",
          operationId: null,
          fundingId: "funding-1",
          status: "succeeded",
          paymentId: 19,
          providerPaymentId: null,
          fundedMinor: 2_000,
          applications: [],
          balance: { availableMinor: 2_000 },
        } };
      }
      return { success: true, data: {} };
    });
    renderPanel();

    fireEvent.change(screen.getByLabelText("Rotating member"), { target: { value: "11" } });
    fireEvent.change(screen.getByLabelText(/Amount received/), { target: { value: "20.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Get staff payment quote" }));
    await screen.findByText("Server-confirmed amount");
    fireEvent.change(screen.getByLabelText("Tender"), { target: { value: "check" } });
    fireEvent.change(screen.getByLabelText(/^Check number/), { target: { value: "CHECK-808" } });
    fireEvent.change(screen.getByLabelText(/^Notes/), { target: { value: "Received at the desk." } });
    fireEvent.click(screen.getByRole("button", { name: "Record check · $20.00" }));

    expect(await screen.findByText(/Do not record the same tender again or change its details/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check or retry same payment · $20.00" })).toBeEnabled();
    expect(screen.getByLabelText("Rotating member")).toBeDisabled();
    expect(screen.getByLabelText(/Amount received/)).toBeDisabled();
    expect(screen.getByLabelText("Tender")).toBeDisabled();
    expect(screen.getByLabelText(/^Check number/)).toBeDisabled();
    expect(screen.getByLabelText(/^Notes/)).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Check or retry same payment · $20.00" }));
    expect(await screen.findByText("Payment recorded · $20.00 received")).toBeInTheDocument();
    expect(recordBodies).toHaveLength(2);
    expect(recordBodies[0]).toMatchObject({
      bowlerId: 11,
      amountMinor: 2_000,
      tenderType: "check",
      checkNumber: "CHECK-808",
      quoteFingerprint: `lvrotcrquote:v1:${"b".repeat(64)}`,
      notes: "Received at the desk.",
    });
    expect(recordBodies[0].idempotencyKey).toBeTruthy();
    expect(recordBodies[1]).toEqual(recordBodies[0]);
  });

  it("does not displace an existing fixed Main when opting in", () => {
    renderPanel(mainOnlyRoster);
    fireEvent.click(screen.getByRole("switch", { name: "Enable rotating payments for this team" }));

    expect(screen.getByRole("combobox", { name: "Paying role for position 1" })).toHaveValue("main");
    expect(screen.getByText("Choose a paying position and change its role to “Rotating payer” to finish opting in. No fixed Main payer has been changed yet.")).toBeInTheDocument();
    expect(screen.getByText("Fixed Main · autopay unchanged")).toBeInTheDocument();
  });

  it("offers provider refund only when the server quote permits it and reuses the same key for retry", async () => {
    const recordBodies: Record<string, unknown>[] = [];
    mocks.apiRequest.mockImplementation(async (url: string, _method: string, body: Record<string, unknown>) => {
      if (url.endsWith("/refund/quote/1")) return { success: true, data: refundQuote(true) };
      if (url.endsWith("/refund/1")) {
        recordBodies.push(body);
        const isRetry = recordBodies.length > 1;
        return { success: true, data: {
          contractVersion: "rotating-credit-refund-operation/1",
          refundId: "00000000-0000-4000-8000-000000000003",
          operationId: "refund-operation-1",
          status: isRetry ? "succeeded" : "provider_unknown",
          amountMinor: 1_200,
          providerRefundId: null,
          balance: isRetry
            ? creditBalance(12, { availableMinor: 0, refundedMinor: 1_200 })
            : creditBalance(12, { availableMinor: 0, refundHeldMinor: 1_200 }),
        } };
      }
      return { success: true, data: {} };
    });
    renderPanel(mainOnlyRoster);

    expect(await screen.findByRole("combobox", { name: "Member with rotating credit" })).toBeInTheDocument();
    expect(screen.getByText("Member 12 · former rotating member")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Member with rotating credit"), { target: { value: "12" } });
    await screen.findByRole("combobox", { name: "Credit lot" });
    fireEvent.change(screen.getByLabelText("Credit lot"), { target: { value: refundFundingId } });
    fireEvent.click(screen.getByRole("button", { name: "Get refund quote" }));

    expect(await screen.findByText("Server-confirmed refund amount")).toBeInTheDocument();
    const methodSelect = screen.getByLabelText("Refund method");
    expect(Array.from((methodSelect as HTMLSelectElement).options).map((option) => option.value)).toContain("provider");
    fireEvent.change(methodSelect, { target: { value: "provider" } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: "Unused share credit requested back." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm provider refund · $12.00" }));

    expect(await screen.findByText("Refund status · provider unknown")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Refunds held: $12.00");
    fireEvent.click(screen.getByRole("button", { name: "Check or retry same refund · $12.00" }));
    expect(await screen.findByText("Refund status · succeeded")).toBeInTheDocument();
    expect(recordBodies).toHaveLength(2);
    expect(recordBodies[0]).toMatchObject({
      fundingId: refundFundingId,
      refundKind: "provider",
      quoteFingerprint: `lvrotcrrefundquote:v1:${"c".repeat(64)}`,
      reason: "Unused share credit requested back.",
    });
    expect(recordBodies[0]).not.toHaveProperty("reference");
    expect(recordBodies[0].idempotencyKey).toEqual(recordBodies[1].idempotencyKey);
  });

  it("locks an ambiguously submitted refund and retries with the same idempotency key", async () => {
    const recordBodies: Record<string, unknown>[] = [];
    mocks.apiRequest.mockImplementation(async (url: string, _method: string, body: Record<string, unknown>) => {
      if (url.endsWith("/refund/quote/1")) return { success: true, data: refundQuote(false) };
      if (url.endsWith("/refund/1")) {
        recordBodies.push(body);
        if (recordBodies.length === 1) throw new Error("Connection lost before the server response.");
        return { success: true, data: {
          contractVersion: "rotating-credit-refund-operation/1",
          refundId: "00000000-0000-4000-8000-000000000003",
          operationId: null,
          status: "succeeded",
          amountMinor: 1_200,
          providerRefundId: null,
          balance: creditBalance(12, { availableMinor: 0, refundedMinor: 1_200 }),
        } };
      }
      return { success: true, data: {} };
    });
    renderPanel(mainOnlyRoster);

    fireEvent.change(await screen.findByRole("combobox", { name: "Member with rotating credit" }), { target: { value: "12" } });
    await screen.findByRole("combobox", { name: "Credit lot" });
    fireEvent.change(screen.getByLabelText("Credit lot"), { target: { value: refundFundingId } });
    fireEvent.click(screen.getByRole("button", { name: "Get refund quote" }));
    await screen.findByText("Server-confirmed refund amount");
    fireEvent.change(screen.getByLabelText("Refund method"), { target: { value: "check" } });
    fireEvent.change(screen.getByLabelText(/^Refund reference/), { target: { value: "CHK-808" } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: "Unused share credit requested back." } });
    fireEvent.click(screen.getByRole("button", { name: "Record issued check refund · $12.00" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Do not start another refund.");
    expect(screen.getByRole("button", { name: "Check or retry same refund · $12.00" })).toBeEnabled();
    expect(screen.getByLabelText("Member with rotating credit")).toBeDisabled();
    expect(screen.getByLabelText("Credit lot")).toBeDisabled();
    expect(screen.getByLabelText("Refund method")).toBeDisabled();
    expect(screen.getByLabelText(/^Reason/)).toBeDisabled();
    expect(screen.getByLabelText(/^Refund reference/)).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Check or retry same refund · $12.00" }));
    expect(await screen.findByText("Refund status · succeeded")).toBeInTheDocument();
    expect(recordBodies).toHaveLength(2);
    expect(recordBodies[0].idempotencyKey).toBeTruthy();
    expect(recordBodies[1].idempotencyKey).toBe(recordBodies[0].idempotencyKey);
    expect(recordBodies[1]).toEqual(recordBodies[0]);
  });

  it("requires a reason and issuance reference to record a manual check refund", async () => {
    mocks.apiRequest.mockImplementation(async (url: string, _method: string, body: Record<string, unknown>) => {
      if (url.endsWith("/refund/quote/1")) return { success: true, data: refundQuote(false) };
      if (url.endsWith("/refund/1")) return { success: true, data: {
        contractVersion: "rotating-credit-refund-operation/1",
        refundId: "00000000-0000-4000-8000-000000000003",
        operationId: null,
        status: "succeeded",
        amountMinor: 1_200,
        providerRefundId: null,
        balance: creditBalance(12, { availableMinor: 0, refundedMinor: 1_200 }),
      } };
      return { success: true, data: {} };
    });
    renderPanel(mainOnlyRoster);

    fireEvent.change(await screen.findByRole("combobox", { name: "Member with rotating credit" }), { target: { value: "12" } });
    await screen.findByRole("combobox", { name: "Credit lot" });
    fireEvent.change(screen.getByLabelText("Credit lot"), { target: { value: refundFundingId } });
    fireEvent.click(screen.getByRole("button", { name: "Get refund quote" }));
    await screen.findByText("Server-confirmed refund amount");

    const methodSelect = screen.getByLabelText("Refund method");
    expect(Array.from((methodSelect as HTMLSelectElement).options).map((option) => option.value)).not.toContain("provider");
    fireEvent.change(methodSelect, { target: { value: "check" } });
    const recordButton = screen.getByRole("button", { name: "Record issued check refund · $12.00" });
    fireEvent.change(screen.getByLabelText(/^Refund reference/), { target: { value: "CHK-808" } });
    expect(recordButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: "Unused credit refunded by check." } });
    expect(recordButton).toBeEnabled();
    fireEvent.click(recordButton);

    expect(await screen.findByText("Refund status · succeeded")).toBeInTheDocument();
    const refundCall = mocks.apiRequest.mock.calls.find(([url]) => url === "/api/financials/leagues/1/rotating-credit/refund/1");
    expect(refundCall).toBeDefined();
    expect(refundCall?.[2]).toMatchObject({
      fundingId: refundFundingId,
      refundKind: "check",
      quoteFingerprint: `lvrotcrrefundquote:v1:${"c".repeat(64)}`,
      reason: "Unused credit refunded by check.",
      reference: "CHK-808",
    });
    expect(refundCall?.[2]).toHaveProperty("idempotencyKey");
  });
});
