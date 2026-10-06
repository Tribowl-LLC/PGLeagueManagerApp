import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AdminWeeklyPaymentsWorksheet,
  type AdminWeeklyPaymentsBowlerRow,
  type AdminWeeklyPaymentsTeam,
  type AdminWeeklyPaymentsWorksheetProps,
} from "@/components/admin-weekly-payments-worksheet";

const manualReceipt = {
  receiptId: "61d0672a-2cee-4faa-b878-696b77f0a414",
  paymentId: 8101,
  revision: 3,
  type: "cash",
  amountMinor: 2_000,
  businessCollectionLocalDate: "2026-09-28",
} as const;

const baseRows: AdminWeeklyPaymentsBowlerRow[] = [
  {
    bowlerId: 501,
    displayName: "Avery Lane",
    responsible: true,
    feeComponent: "full",
    feeMinor: 2_500,
    balanceMinor: -1_250,
    manualReceipts: [manualReceipt],
    cardReceipts: [],
    finalTwoWeeksPaid: false,
  },
  {
    bowlerId: 502,
    displayName: "Blair Quinn",
    responsible: false,
    feeComponent: "full",
    feeMinor: 2_500,
    balanceMinor: 500,
    manualReceipts: [],
    cardReceipts: [],
    finalTwoWeeksPaid: false,
  },
  {
    bowlerId: 503,
    displayName: "Casey Reese",
    responsible: true,
    feeComponent: "lineage",
    feeMinor: 1_000,
    balanceMinor: 0,
    manualReceipts: [],
    cardReceipts: [{ paymentId: 8103, type: "credit_card", amountMinor: 3_000 }],
    finalTwoWeeksPaid: true,
  },
];

const teams: AdminWeeklyPaymentsTeam[] = [
  { teamId: 31, teamName: "Monday Night", rows: baseRows },
  {
    teamId: 32,
    teamName: "Tuesday Mixed",
    rows: [{
      bowlerId: 504,
      displayName: "Devon Park",
      responsible: true,
      feeComponent: "full",
      feeMinor: 2_500,
      balanceMinor: 0,
      manualReceipts: [],
      cardReceipts: [],
      finalTwoWeeksPaid: false,
    }],
  },
];

const defaultOnSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);

function props(
  overrides: Partial<AdminWeeklyPaymentsWorksheetProps> = {},
): AdminWeeklyPaymentsWorksheetProps {
  return {
    leagueId: 7,
    occurrenceId: "b8cc77db-79b5-4515-95c6-5482c56c3835",
    collectionLocalDate: "2026-09-28",
    expectedRevision: 14,
    expectedStateFingerprint: `lvmanagepayments:v1:${"a".repeat(64)}`,
    weekConfirmed: true,
    needsConfirmation: false,
    feeOptions: [
      { feeComponent: "full", amountMinor: 2_500 },
      { feeComponent: "lineage", amountMinor: 1_000 },
      { feeComponent: "prize", amountMinor: 500 },
    ],
    teams,
    onSave: defaultOnSave,
    onBowlerAccount: vi.fn(),
    ...overrides,
  };
}

function renderWorksheet(overrides: Partial<AdminWeeklyPaymentsWorksheetProps> = {}) {
  return render(<AdminWeeklyPaymentsWorksheet {...props(overrides)} />);
}

describe("AdminWeeklyPaymentsWorksheet", () => {
  it("shows VACANT and Unassigned slots before current members and excludes display-only rows from edits", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);
    const onDirtyChange = vi.fn();
    const inactiveReceipt = {
      ...manualReceipt,
      receiptId: "f2f99e3e-0b76-4b8f-b5f0-65a9b28c3109",
      paymentId: 8105,
      amountMinor: 4_000,
    };
    const rosterTeam: AdminWeeklyPaymentsTeam = {
      teamId: 31,
      teamName: "Monday Night",
      vacantSlots: [{ slotIndex: 3 }, { slotIndex: 1 }],
      unassignedSlots: [{ slotIndex: 2 }, { slotIndex: 0 }],
      rosterDisplayMembers: [
        { bowlerId: 502, displayName: "Blair Quinn", activeProfile: true },
        { bowlerId: 501, displayName: "Avery Lane", activeProfile: true },
        { bowlerId: 505, displayName: "Inactive Financier", activeProfile: false },
        { bowlerId: 506, displayName: "Static Inactive", activeProfile: false },
      ],
      rows: [
        ...baseRows,
        {
          bowlerId: 505,
          displayName: "Inactive Financier",
          responsible: true,
          feeComponent: "full",
          feeMinor: 2_500,
          balanceMinor: -500,
          manualReceipts: [inactiveReceipt],
          cardReceipts: [],
          finalTwoWeeksPaid: false,
        },
      ],
    };
    const tuesdayTeam = teams[1];
    if (!tuesdayTeam) throw new Error("Tuesday Mixed worksheet team is missing");
    renderWorksheet({
      teams: [rosterTeam, tuesdayTeam],
      initialDrafts: {
        responsibilityDrafts: {
          "7:31:505": { responsible: false, feeComponent: "prize" },
        },
        newReceiptDrafts: {
          "7:31:505": "not an amount",
          "7:31:506": "99.00",
        },
        manualReceiptDrafts: {
          [`7:31:505:${inactiveReceipt.receiptId}`]: "-",
        },
      },
      onSave,
      onDirtyChange,
    });

    const mondayTable = screen.getAllByRole("table")[0];
    if (!mondayTable) throw new Error("Monday Night worksheet table is missing");
    const rows = within(mondayTable).getAllByRole("row").filter((row) => (
      row.querySelector("td") !== null && row.querySelector('[data-awpw="team-total-output"]') === null
    ));
    expect(rows).toHaveLength(9);
    expect(rows[0]).toHaveTextContent("Unassigned");
    expect(rows[1]).toHaveTextContent("VACANT");
    expect(rows[2]).toHaveTextContent("Unassigned");
    expect(rows[3]).toHaveTextContent("VACANT");
    expect(rows[4]).toHaveTextContent("Blair Quinn");
    expect(rows[5]).toHaveTextContent("Avery Lane");
    expect(rows[6]).toHaveTextContent("Inactive Financier");
    expect(rows[7]).toHaveTextContent("Static Inactive");
    expect(rows[8]).toHaveTextContent("Casey Reese");

    const firstVacantCheckbox = screen.getByRole("checkbox", { name: "Responsible this week for VACANT position 2" });
    const secondVacantCheckbox = screen.getByRole("checkbox", { name: "Responsible this week for VACANT position 4" });
    const firstUnassignedCheckbox = screen.getByRole("checkbox", { name: "Responsible this week for Unassigned position 1" });
    const secondUnassignedCheckbox = screen.getByRole("checkbox", { name: "Responsible this week for Unassigned position 3" });
    for (const checkbox of [firstUnassignedCheckbox, firstVacantCheckbox, secondUnassignedCheckbox, secondVacantCheckbox]) {
      expect(checkbox).toBeDisabled();
      expect(checkbox).not.toBeChecked();
    }
    for (const row of rows.slice(0, 4)) {
      expect(within(row).getAllByText("—")).toHaveLength(4);
    }
    await user.click(firstVacantCheckbox);
    fireEvent.keyDown(secondVacantCheckbox, { key: " ", code: "Space" });
    expect(firstVacantCheckbox).not.toBeChecked();
    expect(secondVacantCheckbox).not.toBeChecked();

    const inactiveCheckbox = screen.getByRole("checkbox", { name: "Responsible this week for Inactive Financier" });
    expect(inactiveCheckbox).toBeDisabled();
    expect(inactiveCheckbox).toBeChecked();
    expect(screen.getByLabelText("Monday Night total paid")).toHaveTextContent("$90.00");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Static Inactive" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Responsible this week for Avery Lane" }));
    expect(screen.getByRole("button", { name: "Save week" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save week" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0].changedRows).toEqual([{
      teamId: 31,
      bowlerId: 501,
      responsible: false,
      feeComponent: "full",
      manualReceiptEdits: [],
    }]);
    expect(screen.getByLabelText("Monday Night total paid")).toHaveTextContent("$90.00");
  });

  it("renders the approved six-column order and initially opens only the first team", () => {
    renderWorksheet();

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Responsible this week",
      "Bowler",
      "Account balance",
      "This week’s fee",
      "Received",
      "Final two weeks",
    ]);
    expect(screen.getByRole("button", { name: "Monday Night" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Tuesday Mixed" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    expect(screen.getByText("$12.50 owed")).toBeVisible();
    expect(screen.getByText("$5.00 credit")).toBeVisible();
    expect(screen.getByText("$12.50 owed")).toHaveClass("text-danger-700");
    expect(screen.getByText("$5.00 credit")).not.toHaveClass("text-danger-700");
    const caseyRow = screen.getByRole("row", { name: /Casey Reese/ });
    expect(within(caseyRow).getByText("—")).toBeVisible();
    expect(screen.getByText("Paid")).toBeVisible();
    expect(screen.getAllByText("Unpaid")).toHaveLength(2);
    expect(screen.queryByText(/Paid|Unpaid/, { selector: "td:nth-child(4)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add bowler|Payment history|Record payment/i })).not.toBeInTheDocument();
  });

  it("derives the team total from saved receipts and live drafts for every member", async () => {
    const user = userEvent.setup();
    renderWorksheet();

    const total = screen.getByLabelText("Monday Night total paid");
    expect(total).toHaveTextContent("$50.00");

    const uncheckedMemberPayment = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(uncheckedMemberPayment, "7.25");
    expect(total).toHaveTextContent("$57.25");

    await user.clear(uncheckedMemberPayment);
    await user.type(uncheckedMemberPayment, "-");
    expect(total).toHaveTextContent("$50.00");
    expect(screen.getByText("Total excludes invalid amounts")).toBeVisible();
  });

  it("replaces recorded manual amounts in the total and excludes invalid corrections", async () => {
    const user = userEvent.setup();
    renderWorksheet();

    const total = screen.getByLabelText("Monday Night total paid");
    await user.click(screen.getByRole("button", { name: /Edit recorded cash payment .*Avery Lane/ }));
    const correction = screen.getByRole("textbox", {
      name: "Correct recorded amount received 2026-09-28 for Avery Lane",
    });

    await user.clear(correction);
    await user.type(correction, "5.00");
    expect(total).toHaveTextContent("$35.00");

    await user.clear(correction);
    expect(total).toHaveTextContent("$30.00");

    await user.type(correction, "5.00");
    await user.clear(correction);
    await user.type(correction, "-");
    expect(total).toHaveTextContent("$30.00");
    expect(screen.getByText("Total excludes invalid amounts")).toBeVisible();
  });

  it("defaults the received date, validates it for new payments, and does not save a date alone", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);
    const onDraftStateChange = vi.fn();
    renderWorksheet({ onSave, onDraftStateChange });

    const amount = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(amount, "12.34");
    const receivedDate = screen.getByLabelText("Received date for these payments");
    expect(receivedDate).toHaveValue("2026-09-28");

    await user.clear(receivedDate);
    expect(screen.getByText("Enter a valid received date before saving.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();

    fireEvent.change(receivedDate, { target: { value: "2026-09-30" } });
    expect(receivedDate).toHaveValue("2026-09-30");
    expect(screen.queryByText("Enter a valid received date before saving.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save week" })).toBeEnabled();

    await user.clear(amount);
    expect(screen.queryByLabelText("Received date for these payments")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();
    await waitFor(() => expect(onDraftStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      receivedDate: "2026-09-30",
      newReceiptDrafts: {},
    })));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("includes the selected received date when saving a valid new payment", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);
    renderWorksheet({ onSave });

    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "12.34");
    const receivedDate = screen.getByLabelText("Received date for these payments");
    fireEvent.change(receivedDate, { target: { value: "2026-09-30" } });

    await user.click(screen.getByRole("button", { name: "Save week" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      receivedDate: "2026-09-30",
      changedRows: [{ bowlerId: 502, newManualReceiptAmountMinor: 1_234 }],
    });
  });

  it("refreshes the untouched date default for the same occurrence and retains explicit overrides", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);
    const onDraftStateChange = vi.fn();
    const initialProps = props({ onSave, onDraftStateChange });
    const view = render(<AdminWeeklyPaymentsWorksheet {...initialProps} />);

    view.rerender(
      <AdminWeeklyPaymentsWorksheet {...initialProps} collectionLocalDate="2026-10-06" />,
    );
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "10.00");

    expect(screen.getByLabelText("Received date for these payments")).toHaveValue("2026-10-06");
    await waitFor(() => {
      const latestDraftState = onDraftStateChange.mock.calls.at(-1)?.[0];
      expect(latestDraftState?.newReceiptDrafts["7:31:502"]).toBe("10.00");
      expect(latestDraftState).not.toHaveProperty("receivedDate");
    });

    await user.click(screen.getByRole("button", { name: "Save week" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ receivedDate: "2026-10-06" });

    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "5.00");
    const receivedDate = screen.getByLabelText("Received date for these payments");
    fireEvent.change(receivedDate, { target: { value: "2026-10-04" } });
    view.rerender(
      <AdminWeeklyPaymentsWorksheet {...initialProps} collectionLocalDate="2026-10-07" />,
    );

    expect(receivedDate).toHaveValue("2026-10-04");
    await user.click(screen.getByRole("button", { name: "Save week" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({ receivedDate: "2026-10-04" });
  });

  it("shows a full-week partial count while preserving complete and zero states", () => {
    const partialTeams = teams.map((team) => ({
      ...team,
      rows: team.rows.map((row) => ({
        ...row,
        ...(row.bowlerId === 501 || row.bowlerId === 503 ? { finalTwoWeeksPaidCount: 1 } : {}),
      })),
    }));
    renderWorksheet({ teams: partialTeams });

    expect(screen.getByText("1 of 2 Paid")).toBeVisible();
    expect(screen.getByText("Paid")).toBeVisible();
    expect(screen.getByText("Unpaid")).toBeVisible();
  });

  it("expands and collapses every team without changing the team header content", async () => {
    const user = userEvent.setup();
    renderWorksheet();

    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("button", { name: "Tuesday Mixed" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Devon Park")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.getByRole("button", { name: "Monday Night" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Tuesday Mixed" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("shows the selected fee amount only and offers the full, lineage, and prize choices", async () => {
    const user = userEvent.setup();
    renderWorksheet();

    const fee = screen.getByRole("combobox", { name: "This week’s fee for Avery Lane" });
    expect(fee).toHaveTextContent("$25.00");
    expect(fee).not.toHaveTextContent("Full");

    await user.click(fee);
    expect(screen.getByRole("option", { name: "$25.00 · Full" })).toBeVisible();
    expect(screen.getByRole("option", { name: "$10.00 · Lineage" })).toBeVisible();
    expect(screen.getByRole("option", { name: "$5.00 · Prize" })).toBeVisible();
    await user.click(screen.getByRole("option", { name: "$10.00 · Lineage" }));

    expect(fee).toHaveTextContent("$10.00");
    expect(fee).not.toHaveTextContent("Lineage");
  });

  it("adds the paired responsibility to each displayed fee choice without changing save amounts", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);
    const pairedTeams = teams.map((team) => ({
      ...team,
      rows: team.rows.map((row) => row.bowlerId === 501
        ? { ...row, feeMinor: 2_000, pairedCollectionFeeMinor: 2_000 }
        : row),
    }));
    renderWorksheet({
      teams: pairedTeams,
      feeMultiplier: 2,
      feeOptions: [
        { feeComponent: "full", amountMinor: 2_000 },
        { feeComponent: "lineage", amountMinor: 1_000 },
        { feeComponent: "prize", amountMinor: 500 },
      ],
      onSave,
    });

    const fee = screen.getByRole("combobox", { name: "This week’s fee for Avery Lane" });
    expect(fee).toHaveTextContent("$40.00");
    await user.click(fee);
    expect(screen.getByRole("option", { name: "$40.00 · Full" })).toBeVisible();
    expect(screen.getByRole("option", { name: "$30.00 · Lineage" })).toBeVisible();
    expect(screen.getByRole("option", { name: "$25.00 · Prize" })).toBeVisible();
    await user.click(screen.getByRole("option", { name: "$30.00 · Lineage" }));
    expect(fee).toHaveTextContent("$30.00");

    await user.click(screen.getByRole("button", { name: "Save week" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saveInput = onSave.mock.calls[0]?.[0];
    expect(saveInput?.changedRows).toEqual([{
      teamId: 31,
      bowlerId: 501,
      responsible: true,
      feeComponent: "lineage",
      manualReceiptEdits: [],
    }]);
    expect(JSON.stringify(saveInput)).not.toContain("pairedCollectionFeeMinor");
  });

  it("opens the selected bowler account from the row name", async () => {
    const user = userEvent.setup();
    const onBowlerAccount = vi.fn();
    renderWorksheet({ onBowlerAccount });

    await user.click(screen.getByRole("button", { name: "Avery Lane" }));

    expect(onBowlerAccount).toHaveBeenCalledWith(baseRows[0]);
  });

  it("keeps the server's historical fee amount visible until responsibility changes", () => {
    const originalTeam = teams[0];
    const originalRow = baseRows[0];
    if (!originalTeam || !originalRow) throw new Error("The worksheet fixture is incomplete");
    const historicalTeams: AdminWeeklyPaymentsTeam[] = [{
      ...originalTeam,
      rows: [{ ...originalRow, feeMinor: 1_800 }],
    }];
    renderWorksheet({ teams: historicalTeams });

    const fee = screen.getByRole("combobox", { name: "This week’s fee for Avery Lane" });
    expect(fee).toHaveTextContent("$18.00");
    expect(fee).not.toHaveTextContent("$25.00");
  });

  it("keeps card receipts read-only and leaves a single empty entry only when no receipt exists", () => {
    renderWorksheet();

    expect(screen.getByText("Card · $30.00")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Amount received from Casey Reese" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit recorded .*Casey Reese/ })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Amount received from Avery Lane" })).not.toBeInTheDocument();
  });

  it("saves a responsibility checkbox change without requiring a cash entry", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);
    renderWorksheet({ onSave });

    await user.click(screen.getByRole("checkbox", { name: "Responsible this week for Avery Lane" }));
    await user.click(screen.getByRole("button", { name: "Save week" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      changedRows: [{
        teamId: 31,
        bowlerId: 501,
        responsible: false,
        feeComponent: "full",
        manualReceiptEdits: [],
      }],
    })));
  });

  it("edits each legacy manual receipt independently and cancels on Escape", async () => {
    const user = userEvent.setup();
    const secondReceipt = {
      receiptId: "f28751fc-b037-4e82-9b3d-4b32f0a57c36",
      paymentId: 8102,
      revision: 5,
      type: "check" as const,
      amountMinor: 700,
      businessCollectionLocalDate: "2026-09-29",
    };
    const firstTeam = teams[0];
    const firstRow = baseRows[0];
    if (!firstTeam || !firstRow) throw new Error("Test row missing");
    const rowsWithMultipleReceipts = [
      { ...firstRow, manualReceipts: [manualReceipt, secondReceipt] },
      ...baseRows.slice(1),
    ];
    const onSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);
    renderWorksheet({
      onSave,
      teams: [{ ...firstTeam, rows: rowsWithMultipleReceipts }, ...teams.slice(1)],
    });

    const editButtons = screen.getAllByRole("button", { name: /Edit recorded .*payment .*Avery Lane/ });
    expect(editButtons).toHaveLength(2);
    const secondEditButton = editButtons.at(1);
    if (!secondEditButton) throw new Error("Second receipt edit button missing");
    await user.click(secondEditButton);
    const secondInput = screen.getByRole("textbox", {
      name: "Correct recorded amount received 2026-09-29 for Avery Lane",
    });
    expect(secondInput).toHaveValue("7.00");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: /Correct recorded amount/ })).not.toBeInTheDocument();

    const reopenedEditButton = screen.getAllByRole("button", {
      name: /Edit recorded .*payment .*Avery Lane/,
    }).at(1);
    if (!reopenedEditButton) throw new Error("Second receipt edit button missing after cancel");
    await user.click(reopenedEditButton);
    const reopenedInput = screen.getByRole("textbox", {
      name: "Correct recorded amount received 2026-09-29 for Avery Lane",
    });
    await user.clear(reopenedInput);
    await user.type(reopenedInput, "8.25");
    await user.click(screen.getByRole("button", { name: "Save week" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      occurrenceId: "b8cc77db-79b5-4515-95c6-5482c56c3835",
      expectedRevision: 14,
      expectedStateFingerprint: `lvmanagepayments:v1:${"a".repeat(64)}`,
      changedRows: [{
        teamId: 31,
        bowlerId: 501,
        responsible: true,
        feeComponent: "full",
        manualReceiptEdits: [{
          receiptId: secondReceipt.receiptId,
          expectedRevision: secondReceipt.revision,
          amountMinor: 825,
        }],
      }],
    }));
  });

  it("saves receipt edits and new entry drafts together, preserves them after failure, and clears after success", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);
    onSave.mockRejectedValueOnce(new Error("conflict details are not shown raw"));
    renderWorksheet({ onSave });

    await user.click(screen.getByRole("button", { name: /Edit recorded .*payment .*Avery Lane/ }));
    const editInput = screen.getByRole("textbox", {
      name: "Correct recorded amount received 2026-09-28 for Avery Lane",
    });
    await user.clear(editInput);

    const newEntry = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(newEntry, ".50");
    await user.click(screen.getByRole("button", { name: "Save week" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Week wasn’t saved. Your changes are still here. Check your connection and try again.",
    );
    expect(screen.getByRole("textbox", {
      name: "Correct recorded amount received 2026-09-28 for Avery Lane",
    })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue(".50");
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      changedRows: [
        {
          teamId: 31,
          bowlerId: 501,
          responsible: true,
          feeComponent: "full",
          manualReceiptEdits: [{
            receiptId: manualReceipt.receiptId,
            expectedRevision: manualReceipt.revision,
            amountMinor: 0,
          }],
        },
        {
          teamId: 31,
          bowlerId: 502,
          responsible: false,
          feeComponent: "full",
          manualReceiptEdits: [],
          newManualReceiptAmountMinor: 50,
        },
      ],
    }));

    await user.click(screen.getByRole("button", { name: "Save week" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("textbox", { name: /Correct recorded amount/ })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue("");
  });

  it("accepts a trailing decimal point as an ordinary whole-dollar amount", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);
    renderWorksheet({ onSave });

    const input = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(input, "25.");
    expect(screen.getByRole("button", { name: "Save week" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save week" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      changedRows: [{
        teamId: 31,
        bowlerId: 502,
        responsible: false,
        feeComponent: "full",
        manualReceiptEdits: [],
        newManualReceiptAmountMinor: 2_500,
      }],
    })));
  });

  it("allows initial confirmation and derives the next save state from the returned props", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);
    const unconfirmedView = renderWorksheet({ onSave, weekConfirmed: false, needsConfirmation: true });

    const saveButton = screen.getByRole("button", { name: "Save week" });
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      occurrenceId: "b8cc77db-79b5-4515-95c6-5482c56c3835",
      expectedRevision: 14,
      expectedStateFingerprint: `lvmanagepayments:v1:${"a".repeat(64)}`,
      changedRows: [],
    }));
    // The parent owns the committed server snapshot. A successful callback
    // alone must not poison an unchanged view when its props have not advanced.
    expect(saveButton).toBeEnabled();
    unconfirmedView.unmount();

    const confirmedView = renderWorksheet({ weekConfirmed: true, needsConfirmation: false });
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();
    confirmedView.unmount();
  });

  it("rejects malformed and out-of-range amounts without silently clearing a receipt", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<AdminWeeklyPaymentsWorksheetProps["onSave"]>(async () => undefined);
    renderWorksheet({ onSave });

    const input = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(input, "-");
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();
    expect(screen.getByText("Enter an amount with up to two decimal places.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Edit recorded .*payment .*Avery Lane/ }));
    const edit = screen.getByRole("textbox", {
      name: "Correct recorded amount received 2026-09-28 for Avery Lane",
    });
    await user.clear(edit);
    await user.type(edit, "999999999999999999");
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not clear drafts on a background roster refetch and does not change balances optimistically", async () => {
    const user = userEvent.setup();
    const currentProps = props();
    const { rerender } = render(<AdminWeeklyPaymentsWorksheet {...currentProps} />);

    await user.click(screen.getByRole("checkbox", { name: "Responsible this week for Avery Lane" }));
    const newEntry = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(newEntry, "12.34");
    expect(screen.getByText("$5.00 credit")).toBeVisible();

    const firstTeam = teams[0];
    const secondTeam = teams[1];
    const firstRow = baseRows[0];
    if (!firstTeam || !secondTeam || !firstRow) throw new Error("Test row missing");
    const refreshedTeams = [
      {
        ...firstTeam,
        rows: [
          { ...firstRow, balanceMinor: -2_000 },
          ...baseRows.slice(1),
        ],
      },
      secondTeam,
    ];
    rerender(
      <AdminWeeklyPaymentsWorksheet
        {...currentProps}
        teams={refreshedTeams}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Responsible this week for Avery Lane" })).not.toBeChecked();
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue("12.34");
    expect(screen.getByText("$20.00 owed")).toBeVisible();
    expect(screen.getByText("$5.00 credit")).toBeVisible();
  });

  it("reports when local edits begin and when they are canceled", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    renderWorksheet({ onDirtyChange });

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    await user.click(screen.getByRole("button", {
      name: /Edit recorded cash payment .*Avery Lane/,
    }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    await user.click(screen.getByRole("button", {
      name: "Cancel recorded payment edit received 2026-09-28 for Avery Lane",
    }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });
});
