import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock("wouter", () => ({ useParams: () => ({ leagueId: "7" }), useSearch: () => "?organizationId=42" }));
vi.mock("@/components/layout", () => ({ Layout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/page-states", () => ({ PageLoadingState: () => <div>loading</div> }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: apiRequestMock }));
vi.mock("@/components/ui/select", () => {
  type SelectProps = { value?: string; disabled?: boolean; onValueChange?: (value: string) => void; children: ReactNode };
  type ItemProps = { value: string; children: ReactNode };
  return {
    Select: ({ value, disabled, onValueChange, children }: SelectProps) => <select aria-label="financial selection" value={value ?? ""} disabled={disabled} onChange={(event) => onValueChange?.(event.target.value)}>{children}</select>,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: ItemProps) => <option value={value}>{children}</option>,
    SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectValue: ({ placeholder }: { placeholder?: string }) => <option value="" disabled>{placeholder}</option>,
  };
});

import FinancialActivationPage from "@/pages/financial-activation-page";

describe("F1 responsibility activation UI", () => {
  it("uses scoped source/candidate contracts and renders explicit three-or-four choices blank", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/source")) return new Response(JSON.stringify({ data: { activationVersion: 1, contractVersion: "canonical-due-past-due/1", orderVersion: "occurrence-team-slot-bowler/1", organizationId: 1, leagueId: 7, authoritativeSource: "canonical", sourceFingerprint: `lvfinancialsource:v1:${"a".repeat(64)}`, expected: [{ occurrenceId: "00000000-0000-0000-0000-000000000001", teamId: 9, teamName: "A Team", occurrenceKind: "makeup", occurrenceStatus: "scheduled", lifecycle: "published", occurrenceRevision: 1, billingTermId: "00000000-0000-0000-0000-000000000002", billingTermVersion: 1, billingTermRevision: 1, obligationPolicy: "eligible_bowlers", amountMinor: 500, currency: "USD", paymentMode: "weekly", occurrenceStartAt: "2038-01-01T00:00:00.000Z" }] } }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ bowlerId: 11, name: "A Bowler" }] }), { status: 200 });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><FinancialActivationPage /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText(/Review payer responsibility/i)).toBeInTheDocument());
    expect(screen.getByText("Choose three or four")).toBeInTheDocument();
    expect(screen.getByText(/not selected/)).toBeInTheDocument();
    expect(screen.getByText(/exactly three or four payers/i)).toBeInTheDocument();
    expect(screen.getByText(/makeup · scheduled · weekly · \$5\.00 USD/i)).toBeInTheDocument();
    expect(screen.getByText(/irreversible in F1/i)).toBeInTheDocument();
    expect(calls.some((url) => url.includes("/api/bowler-leagues") || url === "/api/bowlers")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("submits the explicit matrix through apiRequest with a stable command key and source", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/source")) return new Response(JSON.stringify({ data: { activationVersion: 1, contractVersion: "canonical-due-past-due/1", orderVersion: "occurrence-team-slot-bowler/1", organizationId: 42, leagueId: 7, authoritativeSource: "canonical", sourceFingerprint: `lvfinancialsource:v1:${"b".repeat(64)}`, expected: [{ occurrenceId: "00000000-0000-0000-0000-000000000001", teamId: 9, teamName: "A Team", occurrenceKind: "regular", occurrenceStatus: "scheduled", lifecycle: "published", occurrenceRevision: 1, billingTermId: "00000000-0000-0000-0000-000000000002", billingTermVersion: 1, billingTermRevision: 1, obligationPolicy: "eligible_bowlers", amountMinor: 500, currency: "USD", paymentMode: "weekly", occurrenceStartAt: "2038-01-01T00:00:00.000Z" }] } }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ bowlerId: 11, name: "A Bowler" }, { bowlerId: 12, name: "B Bowler" }, { bowlerId: 13, name: "C Bowler" }] }), { status: 200 });
    }));
    apiRequestMock.mockResolvedValue({ success: true, data: {} });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><FinancialActivationPage /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText(/Review payer responsibility/i)).toBeInTheDocument());
    const user = userEvent.setup();
    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[0], "3");
    await user.selectOptions(selects[1], "11");
    await user.selectOptions(selects[2], "regular");
    await user.selectOptions(selects[3], "12");
    await user.selectOptions(selects[4], "substitute");
    await user.selectOptions(selects[5], "13");
    await user.selectOptions(selects[6], "regular");
    await user.click(screen.getByRole("button", { name: /Review and activate/i }));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    expect(apiRequestMock.mock.calls[0]).toEqual([
      "/api/financials/leagues/7/activate?organizationId=42",
      "POST",
      expect.objectContaining({
        commandKey: expect.stringMatching(/^financial-activation-/),
        sourceFingerprint: `lvfinancialsource:v1:${"b".repeat(64)}`,
        payingLineupSize: 3,
        responsibilities: [
          { occurrenceId: "00000000-0000-0000-0000-000000000001", teamId: 9, slotIndex: 0, bowlerId: 11, role: "regular", provenance: "explicit_admin_selection" },
          { occurrenceId: "00000000-0000-0000-0000-000000000001", teamId: 9, slotIndex: 1, bowlerId: 12, role: "substitute", provenance: "explicit_admin_selection" },
          { occurrenceId: "00000000-0000-0000-0000-000000000001", teamId: 9, slotIndex: 2, bowlerId: 13, role: "regular", provenance: "explicit_admin_selection" },
        ],
      }),
    ]);
    expect(calls).toEqual(expect.arrayContaining([
      "/api/financials/leagues/7/source?organizationId=42",
      "/api/financials/leagues/7/roster?organizationId=42",
    ]));
    confirmSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
