import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RefundPaymentDialog } from "@/components/refund-payment-dialog";
import type { Payment } from "@shared/schema";

const payment = (id: number): Payment => ({
  id,
  organizationId: 1,
  bowlerId: 42,
  leagueId: 7,
  amount: 2_000,
  currency: "USD",
  status: "paid",
  type: "square",
  checkNumber: null,
  providerPaymentId: `square-payment-${id}`,
  idempotencyKey: null,
  squareRefundId: null,
  refundReason: null,
  refundedAt: null,
  disputeId: null,
  disputedAt: null,
  receiptUrl: null,
  receiptNumber: null,
  receiptEmailMissing: false,
  notes: null,
  paidByUserId: null,
  paymentOperationId: null,
  createdAt: "2034-09-10T00:00:00.000Z",
});

describe("RefundPaymentDialog", () => {
  it.each([
    ["still owed", "still_owed"],
    ["waived", "waived"],
  ] as const)("requires choosing whether the refund is %s before confirming", async (_label, disposition) => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<RefundPaymentDialog payment={payment(1)} onClose={() => {}} onConfirm={onConfirm} isPending={false} />);

    const confirm = screen.getByRole("button", { name: "Process Refund" });
    expect(confirm).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("radio", { name: new RegExp(disposition === "still_owed" ? "Still owed" : "Waive this amount") }));
    expect(confirm).not.toBeDisabled();
    await user.click(confirm);

    expect(onConfirm).toHaveBeenCalledWith(1, undefined, disposition);
  });

  it("submits the exact disposition and optional reason", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<RefundPaymentDialog payment={payment(2)} onClose={() => {}} onConfirm={onConfirm} isPending={false} />);

    await user.click(screen.getByRole("radio", { name: /^Waive this amount/ }));
    await user.type(screen.getByRole("textbox", { name: "Reason (optional)" }), "Duplicate league charge");
    await user.click(screen.getByRole("button", { name: "Process Refund" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(2, "Duplicate league charge", "waived");
  });

  it("clears a prior choice when closed and reopened for a different payment", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(<RefundPaymentDialog payment={payment(3)} onClose={onClose} onConfirm={() => {}} isPending={false} />);

    await user.click(screen.getByRole("radio", { name: /^Still owed/ }));
    expect(screen.getByRole("radio", { name: /^Still owed/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    view.rerender(<RefundPaymentDialog payment={null} onClose={onClose} onConfirm={() => {}} isPending={false} />);
    view.rerender(<RefundPaymentDialog payment={payment(4)} onClose={onClose} onConfirm={() => {}} isPending={false} />);

    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /^Still owed/ })).not.toBeChecked();
      expect(screen.getByRole("radio", { name: /^Waive this amount/ })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Process Refund" })).toBeDisabled();
    });
  });

  it("disables both disposition choices and confirmation while pending", async () => {
    const user = userEvent.setup();
    const view = render(<RefundPaymentDialog payment={payment(5)} onClose={() => {}} onConfirm={() => {}} isPending={false} />);

    await user.click(screen.getByRole("radio", { name: /^Still owed/ }));
    view.rerender(<RefundPaymentDialog payment={payment(5)} onClose={() => {}} onConfirm={() => {}} isPending />);

    expect(screen.getByRole("radio", { name: /^Still owed/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^Waive this amount/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Process Refund" })).toBeDisabled();
  });
});
