export interface RefundOperationToast {
  title: string;
  description: string;
  variant?: "default" | "destructive";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Build the admin toast for the durable refund route's 200/202 response. */
export function refundOperationToast(data: unknown): RefundOperationToast {
  if (!isRecord(data) || typeof data.operationId !== "string") {
    return {
      title: "Refund Processed",
      description: "The payment has been successfully refunded.",
    };
  }

  if (data.status === "reconciliation_required") {
    return {
      title: "Refund Requires Reconciliation",
      description: typeof data.message === "string"
        ? data.message
        : "Automatic refund recovery stopped. Review the refund in Square before trying again.",
      variant: "destructive",
    };
  }

  return {
    title: "Refund Processing",
    description: typeof data.message === "string"
      ? data.message
      : "The refund is still being confirmed. Do not submit another refund.",
  };
}
