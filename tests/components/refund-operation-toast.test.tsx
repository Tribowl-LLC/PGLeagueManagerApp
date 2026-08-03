import { describe, expect, it } from "vitest";
import { refundOperationToast } from "@/lib/refund-operation";

describe("refundOperationToast", () => {
  it("surfaces the server reconciliation status and message", () => {
    expect(refundOperationToast({
      operationId: "refund-operation",
      status: "reconciliation_required",
      message: "The refund outcome is unresolved and requires reconciliation.",
    })).toEqual({
      title: "Refund Requires Reconciliation",
      description: "The refund outcome is unresolved and requires reconciliation.",
      variant: "destructive",
    });
  });

  it("keeps ordinary unresolved operations visibly in progress", () => {
    expect(refundOperationToast({
      operationId: "refund-operation",
      status: "provider_unknown",
      message: "The refund is processing. Do not submit a new refund.",
    })).toMatchObject({
      title: "Refund Processing",
      description: "The refund is processing. Do not submit a new refund.",
    });
  });

  it("keeps confirmed payments on the success toast", () => {
    expect(refundOperationToast({ id: 42, status: "refunded" })).toEqual({
      title: "Refund Processed",
      description: "The payment has been successfully refunded.",
    });
  });
});
