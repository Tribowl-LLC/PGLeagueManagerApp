import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, CreditCard, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import "./admin-weekly-payments-worksheet.css";

export type AdminWeeklyPaymentsFeeComponent = "full" | "lineage" | "prize";

export interface AdminWeeklyPaymentsFeeOption {
  feeComponent: AdminWeeklyPaymentsFeeComponent;
  amountMinor: number;
}

export interface AdminWeeklyPaymentsManualReceipt {
  receiptId: string;
  type: "cash" | "check";
  paymentId: number;
  revision: number;
  amountMinor: number;
  businessCollectionLocalDate: string;
}

export interface AdminWeeklyPaymentsCardReceipt {
  paymentId: number;
  amountMinor: number;
  type: "credit_card" | "square";
}

export interface AdminWeeklyPaymentsBowlerRow {
  bowlerId: number;
  displayName: string;
  responsible: boolean;
  feeComponent: AdminWeeklyPaymentsFeeComponent;
  feeMinor: number;
  /** Positive values are account credit; negative values are owed. */
  balanceMinor: number;
  manualReceipts: readonly AdminWeeklyPaymentsManualReceipt[];
  cardReceipts: readonly AdminWeeklyPaymentsCardReceipt[];
  finalTwoWeeksPaid: boolean;
}

export interface AdminWeeklyPaymentsTeam {
  teamId: number;
  teamName: string;
  rows: readonly AdminWeeklyPaymentsBowlerRow[];
}

export interface AdminWeeklyPaymentsRowChange {
  teamId: number;
  bowlerId: number;
  responsible: boolean;
  feeComponent: AdminWeeklyPaymentsFeeComponent;
  manualReceiptEdits: readonly {
    receiptId: string;
    expectedRevision: number;
    amountMinor: number;
  }[];
  newManualReceiptAmountMinor?: number;
}

export interface AdminWeeklyPaymentsSaveInput {
  occurrenceId: string;
  expectedRevision: number;
  /** Opaque canonical fingerprint supplied by the server. */
  expectedStateFingerprint: string;
  changedRows: readonly AdminWeeklyPaymentsRowChange[];
}

export interface AdminWeeklyPaymentsResponsibilityDraft {
  responsible: boolean;
  feeComponent: AdminWeeklyPaymentsFeeComponent;
}

export interface AdminWeeklyPaymentsWorksheetDraftState {
  responsibilityDrafts: Readonly<Record<string, AdminWeeklyPaymentsResponsibilityDraft>>;
  newReceiptDrafts: Readonly<Record<string, string>>;
  manualReceiptDrafts: Readonly<Record<string, string>>;
}

export interface AdminWeeklyPaymentsRecoveryAction {
  label: string;
  run: () => Promise<void>;
}

/** Marker for a sanitized, deliberately user-facing save message. */
export class AdminWeeklyPaymentsSaveError extends Error {
  readonly recoveryAction?: AdminWeeklyPaymentsRecoveryAction;

  constructor(message: string, recoveryAction?: AdminWeeklyPaymentsRecoveryAction) {
    super(message);
    this.name = "AdminWeeklyPaymentsSaveError";
    this.recoveryAction = recoveryAction;
  }
}

export interface AdminWeeklyPaymentsWorksheetProps {
  leagueId: number;
  occurrenceId: string;
  expectedRevision: number;
  expectedStateFingerprint: string;
  weekConfirmed: boolean;
  needsConfirmation: boolean;
  feeOptions: readonly AdminWeeklyPaymentsFeeOption[];
  teams: readonly AdminWeeklyPaymentsTeam[];
  initialDrafts?: AdminWeeklyPaymentsWorksheetDraftState;
  onSave: (input: AdminWeeklyPaymentsSaveInput) => Promise<void>;
  onDirtyChange?: (isDirty: boolean) => void;
  onDraftStateChange?: (drafts: AdminWeeklyPaymentsWorksheetDraftState) => void;
  onBowlerAccount: (row: AdminWeeklyPaymentsBowlerRow) => void;
}

function rowKey(
  leagueId: number,
  teamId: number,
  bowlerId: number,
): string {
  return `${leagueId}:${teamId}:${bowlerId}`;
}

function receiptKey(
  leagueId: number,
  teamId: number,
  bowlerId: number,
  receiptId: string,
): string {
  return `${rowKey(leagueId, teamId, bowlerId)}:${receiptId}`;
}

function formatMoney(amountMinor: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

/** Parse a nonnegative user-entered decimal amount into minor currency units. */
function parseAmount(value: string): number | null {
  const normalized = value.trim();
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) return null;

  const [whole = "0", fraction = ""] = normalized.split(".");
  const minor = Number(whole || "0") * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(minor) && minor <= 2_147_483_647 ? minor : null;
}

function parseEditedReceiptAmount(value: string): number | null {
  if (value.trim() === "") return 0;
  return parseAmount(value);
}

function feeLabel(
  option: AdminWeeklyPaymentsFeeOption,
): string {
  const name = option.feeComponent === "lineage"
    ? "Lineage"
    : option.feeComponent === "prize"
      ? "Prize"
      : "Full";
  return `${formatMoney(option.amountMinor)} · ${name}`;
}

function isFeeComponent(value: string): value is AdminWeeklyPaymentsFeeComponent {
  return value === "full" || value === "lineage" || value === "prize";
}

function TeamWorksheet({
  leagueId,
  team,
  feeOptions,
  expanded,
  saving,
  responsibilityDrafts,
  newReceiptDrafts,
  manualReceiptDrafts,
  onExpandedChange,
  onResponsibilityChange,
  onFeeComponentChange,
  onNewReceiptAmountChange,
  onBeginManualReceiptEdit,
  onManualReceiptAmountChange,
  onCancelManualReceiptEdit,
  onBowlerAccount,
}: {
  leagueId: number;
  team: AdminWeeklyPaymentsTeam;
  feeOptions: readonly AdminWeeklyPaymentsFeeOption[];
  expanded: boolean;
  saving: boolean;
  responsibilityDrafts: Readonly<Record<string, AdminWeeklyPaymentsResponsibilityDraft>>;
  newReceiptDrafts: Readonly<Record<string, string>>;
  manualReceiptDrafts: Readonly<Record<string, string>>;
  onExpandedChange: (open: boolean) => void;
  onResponsibilityChange: (row: AdminWeeklyPaymentsBowlerRow, responsible: boolean) => void;
  onFeeComponentChange: (
    row: AdminWeeklyPaymentsBowlerRow,
    feeComponent: AdminWeeklyPaymentsFeeComponent,
  ) => void;
  onNewReceiptAmountChange: (key: string, value: string) => void;
  onBeginManualReceiptEdit: (key: string, receipt: AdminWeeklyPaymentsManualReceipt) => void;
  onManualReceiptAmountChange: (key: string, value: string) => void;
  onCancelManualReceiptEdit: (key: string) => void;
  onBowlerAccount: (row: AdminWeeklyPaymentsBowlerRow) => void;
}) {
  return (
    <div data-awpw="team-card">
      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <div data-awpw="team-heading">
          <Button
            type="button"
            variant="paymentsTeam"
            size="paymentsControl"
            className="w-full justify-between"
            aria-expanded={expanded}
            aria-controls={`admin-weekly-team-panel-${team.teamId}`}
            disabled={saving}
            onClick={() => onExpandedChange(!expanded)}
          >
            <span className="manage-payments-team-name truncate">{team.teamName}</span>
            <ChevronDown
              aria-hidden="true"
              className={expanded ? "size-4.75 shrink-0 rotate-180 text-familiar-muted" : "size-4.75 shrink-0 text-familiar-muted"}
            />
          </Button>
        </div>
        <CollapsibleContent id={`admin-weekly-team-panel-${team.teamId}`}>
        <div
          data-awpw="table-scroll"
          className="w-full max-w-full overscroll-x-contain"
          role="region"
          aria-label={`${team.teamName} weekly roster`}
          tabIndex={0}
        >
          <Table appearance="managePayments">
            <colgroup className="manage-payments-column-group">
              <col data-awpw-col="responsible" />
              <col data-awpw-col="bowler" />
              <col data-awpw-col="balance" />
              <col data-awpw-col="fee" />
              <col data-awpw-col="received" />
              <col data-awpw-col="final" />
            </colgroup>
            <TableHeader appearance="managePayments">
              <TableRow hover="none" appearance="managePayments">
                <TableHead appearance="managePayments">Responsible this week</TableHead>
                <TableHead appearance="managePayments">Bowler</TableHead>
                <TableHead appearance="managePayments">Account balance</TableHead>
                <TableHead appearance="managePayments">This week’s fee</TableHead>
                <TableHead appearance="managePayments">Received</TableHead>
                <TableHead appearance="managePayments">Final two weeks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody appearance="managePayments">
              {team.rows.map((row) => {
                const key = rowKey(leagueId, team.teamId, row.bowlerId);
                const decision = responsibilityDrafts[key] ?? {
                  responsible: row.responsible,
                  feeComponent: row.feeComponent,
                };
                const responsibilityChanged = decision.responsible !== row.responsible
                  || decision.feeComponent !== row.feeComponent;
                const selectedFeeMinor = responsibilityChanged
                  ? feeOptions.find((option) => option.feeComponent === decision.feeComponent)?.amountMinor ?? row.feeMinor
                  : row.feeMinor;
                const newReceiptDraft = newReceiptDrafts[key] ?? "";
                const newReceiptAmount = newReceiptDraft.trim() === ""
                  ? null
                  : parseAmount(newReceiptDraft);
                const newReceiptInvalid = newReceiptDraft.trim() !== ""
                  && newReceiptAmount === null;
                const hasCardReceipt = row.cardReceipts.length > 0;
                const hasReceiptEvidence = hasCardReceipt || row.manualReceipts.length > 0;
                const balanceText = row.balanceMinor < 0
                  ? `${formatMoney(Math.abs(row.balanceMinor))} owed`
                  : row.balanceMinor > 0
                    ? `${formatMoney(row.balanceMinor)} credit`
                    : "—";

                return (
                  <TableRow key={key} variant="plain" hover="none" appearance="managePayments">
                    <TableCell appearance="managePaymentsResponsible">
                      <span data-awpw="mobile-label">Responsible this week</span>
                      <span data-awpw="responsible-control">
                        <Checkbox
                          appearance="managePayments"
                          checked={decision.responsible}
                          disabled={saving}
                          aria-label={`Responsible this week for ${row.displayName}`}
                          onCheckedChange={(checked) =>
                            onResponsibilityChange(row, checked === true)
                          }
                        />
                      </span>
                    </TableCell>
                    <TableCell appearance="managePaymentsBowler" weight="medium">
                      <span data-awpw="mobile-label">Bowler</span>
                      <button
                        type="button"
                        data-awpw="bowler-name"
                        onClick={() => onBowlerAccount(row)}
                      >
                        {row.displayName}
                      </button>
                    </TableCell>
                    <TableCell appearance="managePaymentsBalance">
                      <span data-awpw="mobile-label">Account balance</span>
                      {row.balanceMinor === 0
                        ? balanceText
                        : <strong data-awpw="balance-text">{balanceText}</strong>}
                    </TableCell>
                    <TableCell appearance="managePaymentsFee">
                      <span data-awpw="mobile-label">This week’s fee</span>
                      {decision.responsible ? (
                        <Select
                          value={decision.feeComponent}
                          disabled={saving}
                          onValueChange={(value) => {
                            if (isFeeComponent(value)) onFeeComponentChange(row, value);
                          }}
                        >
                          <SelectTrigger
                            appearance="managePaymentsFee"
                            className="w-full min-w-0"
                            aria-label={`This week’s fee for ${row.displayName}`}
                          >
                            <SelectValue>
                              {formatMoney(selectedFeeMinor)}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent appearance="managePaymentsFee">
                            {feeOptions.map((option) => (
                              <SelectItem
                                key={option.feeComponent}
                                value={option.feeComponent}
                              >
                                {feeLabel(option)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell appearance="managePaymentsReceived">
                      <span data-awpw="mobile-label" className="manage-payments-received-mobile-label">
                        Received
                      </span>
                      <div data-awpw="received-content">
                        {row.cardReceipts.map((receipt) => (
                          <div
                            className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground"
                            key={receipt.paymentId}
                            aria-label={`Card payment for ${row.displayName}`}
                          >
                            <CreditCard aria-hidden="true" className="size-3.5 shrink-0" />
                            <span>Card · {formatMoney(receipt.amountMinor)}</span>
                          </div>
                        ))}
                        {row.manualReceipts.map((receipt) => {
                          const manualKey = receiptKey(
                            leagueId,
                            team.teamId,
                            row.bowlerId,
                            receipt.receiptId,
                          );
                          const manualDraft = manualReceiptDrafts[manualKey];
                          const manualDraftAmount = manualDraft === undefined
                            ? null
                            : parseEditedReceiptAmount(manualDraft);
                          const manualDraftInvalid = manualDraft !== undefined
                            && manualDraftAmount === null;

                          return (
                            <div className="flex min-w-0 items-center gap-1" key={receipt.receiptId}>
                              {manualDraft === undefined ? (
                                <>
                                  <span className="text-sm text-foreground">
                                    Recorded · {formatMoney(receipt.amountMinor)}
                                  </span>
                                  <Button
                                    type="button"
                                    variant="paymentsGhost"
                                    size="icon"
                                    className="shrink-0"
                                    data-awpw="edit-recorded-button"
                                    disabled={saving}
                                    aria-label={`Edit recorded ${receipt.type} payment ${formatMoney(receipt.amountMinor)} received ${receipt.businessCollectionLocalDate} for ${row.displayName}`}
                                    onClick={() => onBeginManualReceiptEdit(manualKey, receipt)}
                                  >
                                    <Pencil aria-hidden="true" className="size-3.5" />
                                  </Button>
                                </>
                              ) : (
                                <div className="flex min-w-0 flex-col gap-1">
                                  <div className="flex min-w-0 items-center gap-1">
                                    <div data-awpw="amount-input" data-awpw-edit-input>
                                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                                      <Input
                                        type="text"
                                        inputMode="decimal"
                                        appearance="managePayments"
                                        autoFocus
                                        value={manualDraft}
                                        disabled={saving}
                                        aria-label={`Correct recorded amount received ${receipt.businessCollectionLocalDate} for ${row.displayName}`}
                                        aria-invalid={manualDraftInvalid}
                                        onKeyDown={(event) => {
                                          if (event.key === "Escape") {
                                            event.preventDefault();
                                            onCancelManualReceiptEdit(manualKey);
                                          }
                                        }}
                                        onChange={(event) =>
                                          onManualReceiptAmountChange(manualKey, event.currentTarget.value)
                                        }
                                        leading="sm"
                                        className="w-full min-w-0"
                                      />
                                    </div>
                                    <Button
                                      type="button"
                                      variant="paymentsGhost"
                                      size="paymentsIcon"
                                      className="shrink-0"
                                      disabled={saving}
                                      aria-label={`Cancel recorded payment edit received ${receipt.businessCollectionLocalDate} for ${row.displayName}`}
                                      onClick={() => onCancelManualReceiptEdit(manualKey)}
                                    >
                                      <X aria-hidden="true" className="size-4" />
                                    </Button>
                                  </div>
                                  {manualDraftAmount === 0 && !manualDraftInvalid && (
                                    <small className="text-xs text-muted-foreground">Removed when you save.</small>
                                  )}
                                  {manualDraftInvalid && (
                                    <small className="text-xs text-destructive" role="alert">
                                      Enter a valid amount with up to two decimal places, or leave it blank to remove.
                                    </small>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {!hasReceiptEvidence && (
                          <div className="flex min-w-0 flex-col gap-1">
                            <div data-awpw="amount-input">
                              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                              <Input
                                type="text"
                                inputMode="decimal"
                                appearance="managePayments"
                                value={newReceiptDraft}
                                placeholder="0.00"
                                disabled={saving}
                                aria-label={`Amount received from ${row.displayName}`}
                                aria-invalid={newReceiptInvalid}
                                onChange={(event) =>
                                  onNewReceiptAmountChange(key, event.currentTarget.value)
                                }
                                leading="sm"
                                className="w-full min-w-0"
                              />
                            </div>
                            {newReceiptInvalid && (
                              <small className="text-xs text-destructive" role="alert">
                                Enter an amount with up to two decimal places.
                              </small>
                            )}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell appearance="managePaymentsFinal">
                      <span data-awpw="mobile-label">Final two weeks</span>
                      <span data-awpw={row.finalTwoWeeksPaid ? "final-paid" : "final-unpaid"} className={row.finalTwoWeeksPaid ? "font-medium text-positive-700" : "text-muted-foreground"}>
                        {row.finalTwoWeeksPaid ? "Paid" : "Unpaid"}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function AdminWeeklyPaymentsWorksheet({
  leagueId,
  occurrenceId,
  expectedRevision,
  expectedStateFingerprint,
  weekConfirmed,
  needsConfirmation,
  feeOptions,
  teams,
  initialDrafts,
  onSave,
  onDirtyChange,
  onDraftStateChange,
  onBowlerAccount,
}: AdminWeeklyPaymentsWorksheetProps) {
  const [expandedTeams, setExpandedTeams] = useState<Readonly<Record<number, boolean>>>(() =>
    Object.fromEntries(teams.map((team, index) => [team.teamId, index === 0])),
  );
  const [responsibilityDrafts, setResponsibilityDrafts] = useState<
    Readonly<Record<string, AdminWeeklyPaymentsResponsibilityDraft>>
  >(() => initialDrafts?.responsibilityDrafts ?? {});
  const [newReceiptDrafts, setNewReceiptDrafts] = useState<Readonly<Record<string, string>>>(
    () => initialDrafts?.newReceiptDrafts ?? {},
  );
  const [manualReceiptDrafts, setManualReceiptDrafts] = useState<Readonly<Record<string, string>>>(
    () => initialDrafts?.manualReceiptDrafts ?? {},
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{
    message: string;
    recoveryAction?: AdminWeeklyPaymentsRecoveryAction;
  } | null>(null);
  const [recovering, setRecovering] = useState(false);
  const saveInFlight = useRef(false);

  const allRows = teams.flatMap((team) =>
    team.rows.map((row) => ({ team, row, key: rowKey(leagueId, team.teamId, row.bowlerId) })),
  );

  function currentDecision(row: AdminWeeklyPaymentsBowlerRow, key: string): AdminWeeklyPaymentsResponsibilityDraft {
    return responsibilityDrafts[key] ?? {
      responsible: row.responsible,
      feeComponent: row.feeComponent,
    };
  }

  function responsibilityIsChanged(
    row: AdminWeeklyPaymentsBowlerRow,
    key: string,
  ): boolean {
    const draft = responsibilityDrafts[key];
    return draft !== undefined
      && (draft.responsible !== row.responsible || draft.feeComponent !== row.feeComponent);
  }

  const invalidRows = allRows.filter(({ team, row, key }) => {
    const newAmount = newReceiptDrafts[key] ?? "";
    const canEnterNewReceipt = row.manualReceipts.length === 0 && row.cardReceipts.length === 0;
    const paymentInvalid = canEnterNewReceipt
      && newAmount.trim() !== ""
      && parseAmount(newAmount) === null;
    const receiptInvalid = row.manualReceipts.some((receipt) => {
      const editKey = receiptKey(leagueId, team.teamId, row.bowlerId, receipt.receiptId);
      const editAmount = manualReceiptDrafts[editKey];
      return editAmount !== undefined && parseEditedReceiptAmount(editAmount) === null;
    });
    return paymentInvalid || receiptInvalid;
  });

  const rowChanges: AdminWeeklyPaymentsRowChange[] = [];
  for (const { team, row, key } of allRows) {
    const decision = currentDecision(row, key);
    const manualReceiptEdits: AdminWeeklyPaymentsRowChange["manualReceiptEdits"][number][] = [];
    let newManualReceiptAmountMinor: number | undefined;

    const newPaymentDraft = newReceiptDrafts[key] ?? "";
    if (row.manualReceipts.length === 0 && row.cardReceipts.length === 0 && newPaymentDraft.trim() !== "") {
      const amount = parseAmount(newPaymentDraft);
      if (amount !== null && amount > 0) newManualReceiptAmountMinor = amount;
    }

    for (const receipt of row.manualReceipts) {
      const editKey = receiptKey(leagueId, team.teamId, row.bowlerId, receipt.receiptId);
      const draft = manualReceiptDrafts[editKey];
      if (draft !== undefined) {
        const amount = parseEditedReceiptAmount(draft);
        if (amount !== null && amount !== receipt.amountMinor) {
          manualReceiptEdits.push({
            receiptId: receipt.receiptId,
            expectedRevision: receipt.revision,
            amountMinor: amount,
          });
        }
      }
    }

    const changed = responsibilityIsChanged(row, key)
      || manualReceiptEdits.length > 0
      || newManualReceiptAmountMinor !== undefined;
    if (changed) {
      rowChanges.push({
        teamId: team.teamId,
        bowlerId: row.bowlerId,
        responsible: decision.responsible,
        feeComponent: decision.feeComponent,
        manualReceiptEdits,
        ...(newManualReceiptAmountMinor === undefined
          ? {}
          : { newManualReceiptAmountMinor }),
      });
    }
  }

  const hasDraftChanges = rowChanges.length > 0;
  const hasLocalDrafts = hasDraftChanges
    || invalidRows.length > 0
    || Object.keys(manualReceiptDrafts).length > 0
    || Object.values(newReceiptDrafts).some((amount) => amount.trim() !== "");
  const canSave = !saving
    && invalidRows.length === 0
    && (needsConfirmation || hasDraftChanges);

  useEffect(() => {
    onDirtyChange?.(hasLocalDrafts);
  }, [hasLocalDrafts, onDirtyChange]);

  useEffect(() => {
    onDraftStateChange?.({ responsibilityDrafts, newReceiptDrafts, manualReceiptDrafts });
  }, [manualReceiptDrafts, newReceiptDrafts, onDraftStateChange, responsibilityDrafts]);

  function clearSaveError() {
    setSaveError(null);
  }

  function updateResponsibility(
    row: AdminWeeklyPaymentsBowlerRow,
    teamId: number,
    next: AdminWeeklyPaymentsResponsibilityDraft,
  ) {
    const key = rowKey(leagueId, teamId, row.bowlerId);
    setResponsibilityDrafts((current) => {
      const updated = { ...current };
      if (next.responsible === row.responsible && next.feeComponent === row.feeComponent) {
        delete updated[key];
      } else {
        updated[key] = next;
      }
      return updated;
    });
    clearSaveError();
  }

  function toggleExpanded(teamId: number, expanded: boolean) {
    setExpandedTeams((current) => ({ ...current, [teamId]: expanded }));
  }

  function changeNewReceiptAmount(key: string, value: string) {
    setNewReceiptDrafts((current) => {
      const updated = { ...current };
      if (value === "") delete updated[key];
      else updated[key] = value;
      return updated;
    });
    clearSaveError();
  }

  function beginManualReceiptEdit(
    key: string,
    receipt: AdminWeeklyPaymentsManualReceipt,
  ) {
    setManualReceiptDrafts((current) => ({
      ...current,
      [key]: (receipt.amountMinor / 100).toFixed(2),
    }));
    clearSaveError();
  }

  function changeManualReceiptAmount(key: string, value: string) {
    setManualReceiptDrafts((current) => ({ ...current, [key]: value }));
    clearSaveError();
  }

  function cancelManualReceiptEdit(key: string) {
    setManualReceiptDrafts((current) => {
      const updated = { ...current };
      delete updated[key];
      return updated;
    });
    clearSaveError();
  }

  async function saveWeek() {
    if (!canSave || saveInFlight.current) return;

    saveInFlight.current = true;
    setSaving(true);
    clearSaveError();

    try {
      await onSave({
        occurrenceId,
        expectedRevision,
        expectedStateFingerprint,
        changedRows: rowChanges,
      });

      setResponsibilityDrafts({});
      setNewReceiptDrafts({});
      setManualReceiptDrafts({});
    } catch (error) {
      setSaveError(error instanceof AdminWeeklyPaymentsSaveError
        ? { message: error.message, recoveryAction: error.recoveryAction }
        : { message: "Week wasn’t saved. Your changes are still here. Check your connection and try again." });
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  async function runRecoveryAction() {
    const action = saveError?.recoveryAction;
    if (!action || recovering) return;
    setRecovering(true);
    try {
      await action.run();
      setSaveError(null);
    } catch {
      setSaveError({
        message: "The latest saved week could not be loaded. This week’s unsaved edits were cleared as requested; retry the reload to continue.",
        recoveryAction: action,
      });
    } finally {
      setRecovering(false);
    }
  }

  return (
    <section data-awpw="worksheet" aria-label="Weekly payments worksheet">
      <div data-awpw="team-controls">
        <p>Team rosters</p>
        <div>
          <Button
            type="button"
            variant="paymentsSecondary"
            size="paymentsControl"
            className="flex-1 md:flex-none"
            disabled={saving || teams.length === 0}
            onClick={() => setExpandedTeams(Object.fromEntries(teams.map((team) => [team.teamId, true])))}
          >
            Expand all
          </Button>
          <Button
            type="button"
            variant="paymentsSecondary"
            size="paymentsControl"
            className="flex-1 md:flex-none"
            disabled={saving || teams.length === 0}
            onClick={() => setExpandedTeams(Object.fromEntries(teams.map((team) => [team.teamId, false])))}
          >
            Collapse all
          </Button>
        </div>
      </div>

      {teams.length > 0 ? (
        <div data-awpw="team-list">
          {teams.map((team, index) => (
            <TeamWorksheet
              key={`${leagueId}:${team.teamId}`}
              leagueId={leagueId}
              team={team}
              feeOptions={feeOptions}
              expanded={expandedTeams[team.teamId] ?? index === 0}
              saving={saving}
              responsibilityDrafts={responsibilityDrafts}
              newReceiptDrafts={newReceiptDrafts}
              manualReceiptDrafts={manualReceiptDrafts}
              onExpandedChange={(open) => toggleExpanded(team.teamId, open)}
              onResponsibilityChange={(row, responsible) =>
                updateResponsibility(row, team.teamId, {
                  ...currentDecision(row, rowKey(leagueId, team.teamId, row.bowlerId)),
                  responsible,
                })
              }
              onFeeComponentChange={(row, feeComponent) =>
                updateResponsibility(row, team.teamId, {
                  ...currentDecision(row, rowKey(leagueId, team.teamId, row.bowlerId)),
                  feeComponent,
                })
              }
              onNewReceiptAmountChange={changeNewReceiptAmount}
              onBeginManualReceiptEdit={beginManualReceiptEdit}
              onManualReceiptAmountChange={changeManualReceiptAmount}
              onCancelManualReceiptEdit={cancelManualReceiptEdit}
              onBowlerAccount={onBowlerAccount}
            />
          ))}
        </div>
      ) : (
        <div data-awpw="empty-state">
          There are no team rosters for this league.
        </div>
      )}

      <p data-awpw="receipt-note">Receipts stay with the named bowler and cover their oldest confirmed fees first.</p>

      <div data-awpw="save-dock">
        <div data-awpw="save-status">
          <p>
            {needsConfirmation
              ? "Week is ready to confirm"
              : hasLocalDrafts
                ? "Unsaved changes"
                : weekConfirmed
                  ? "Week saved"
                  : "Week not confirmed"}
          </p>
          {invalidRows.length > 0 && (
            <p data-awpw="invalid-notice" role="alert">
              Fix invalid amounts before saving.
            </p>
          )}
          {saveError && (
            <div data-awpw="save-error" role="alert">
              <p>{saveError.message}</p>
              {saveError.recoveryAction && (
                <Button
                  type="button"
                  variant="paymentsSecondary"
                  size="paymentsControl"
                  disabled={saving || recovering}
                  onClick={() => { void runRecoveryAction(); }}
                >
                  {recovering ? "Reloading…" : saveError.recoveryAction.label}
                </Button>
              )}
            </div>
          )}
          {!needsConfirmation && weekConfirmed && !hasLocalDrafts && invalidRows.length === 0 && (
            <p data-awpw="save-hint">No changes to save.</p>
          )}
        </div>
        <Button
          type="button"
          variant="paymentsPrimary"
          size="paymentsSave"
          disabled={!canSave}
          onClick={saveWeek}
        >
          <Check aria-hidden="true" className="mr-2 size-4" />
          {saving ? "Saving…" : "Save week"}
        </Button>
      </div>
    </section>
  );
}
