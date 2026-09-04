import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { initializeSquare, getPreWarmedCard, toast } = vi.hoisted(() => ({
  initializeSquare: vi.fn(),
  getPreWarmedCard: vi.fn(() => null),
  toast: vi.fn(),
}));

vi.mock("@/lib/square", () => ({
  initializeSquare,
  getPreWarmedCard,
  cardStyle: {},
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { useSquarePayment } from "@/hooks/use-square-payment";

describe("useSquarePayment editor lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats removal of the card container during initialization as cancellation", async () => {
    let resolvePayments!: (payments: {
      card: () => Promise<{ attach: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>;
    }) => void;
    initializeSquare.mockReturnValue(new Promise((resolve) => { resolvePayments = resolve; }));
    const attach = vi.fn();
    const destroy = vi.fn();
    const onError = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { result } = renderHook(() => useSquarePayment({ locationId: 1, onError }));

    let initialization!: Promise<void>;
    act(() => { initialization = result.current.initializeCard(container); });
    container.remove();
    resolvePayments({ card: async () => ({ attach, destroy }) });
    await act(async () => { await initialization; });

    expect(attach).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("suppresses Square's attach error when React removes the target element", async () => {
    let rejectAttach!: (error: Error) => void;
    const attach = vi.fn(() => new Promise<void>((_, reject) => { rejectAttach = reject; }));
    const destroy = vi.fn();
    initializeSquare.mockResolvedValue({ card: async () => ({ attach, destroy }) });
    const onError = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { result } = renderHook(() => useSquarePayment({ locationId: 1, onError }));

    let initialization!: Promise<void>;
    act(() => { initialization = result.current.initializeCard(container); });
    await waitFor(() => expect(attach).toHaveBeenCalledWith(container));
    container.remove();
    rejectAttach(new Error("The element DIV was not found"));
    await act(async () => { await initialization; });

    expect(destroy).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("uses the supplied error handler as the single terminal notification owner", async () => {
    vi.useFakeTimers();
    initializeSquare.mockRejectedValue(new Error("provider initialization failed"));
    const onError = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { result } = renderHook(() => useSquarePayment({ locationId: 1, onError }));

    await act(async () => { await result.current.initializeCard(container); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(onError).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
    container.remove();
  });
});
