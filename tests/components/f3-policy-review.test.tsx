import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { F3PolicyReview } from "@/components/f3-policy-review";

const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const c = "00000000-0000-4000-8000-000000000003";
const d = "00000000-0000-4000-8000-000000000004";
const e = "00000000-0000-4000-8000-000000000005";

describe("F3 administrator policy review", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.includes("/approve")) return new Response(JSON.stringify({ data: { state: "approved" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (init?.method === "POST") return new Response(JSON.stringify({ data: { id: "policy-1", policyFingerprint: `lvf3policy:v1:${"f".repeat(64)}` } }), { status: 201, headers: { "Content-Type": "application/json" } });
    const ids = [a, b, c, d, e];
    return new Response(JSON.stringify({ data: { activation: { id: "00000000-0000-4000-8000-000000000006", revision: 1, sourceFingerprint: `lvfinancialsource:v1:${"a".repeat(64)}` }, occurrences: ids.map((id, index) => ({ id, startAt: `2032-08-${String(index + 1).padStart(2, "0")}T19:00:00.000Z`, localDate: `2032-08-${String(index + 1).padStart(2, "0")}`, localStartTime: "19:00", timezone: "UTC", ordinal: index + 1, lifecycle: "published" })), nextPolicyVersion: 3, currentPolicy: { id: "policy-current", policyVersion: 2, state: "approved", policyFingerprint: `lvf3policy:v1:${"b".repeat(64)}` }, draftPolicy: null } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());
  it("renders exact UUID candidates and explicit double-pay controls", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><F3PolicyReview leagueId={7} organizationId={3} /></QueryClientProvider>);
    expect(await screen.findByTestId("f3-policy-review")).toBeVisible();
    expect(screen.getAllByText(new RegExp(a)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText("Double-pay trigger")).toBeVisible();
    expect(screen.getByText(/display evidence only/i)).toBeVisible();
  });

  it("submits two disjoint explicit pairs plus a normal row, then approves separately", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><F3PolicyReview leagueId={7} organizationId={3} /></QueryClientProvider>);
    await screen.findByTestId("f3-policy-review");
    const trigger = screen.getByLabelText("Double-pay trigger");
    const paired = screen.getByLabelText("Exact paired occurrence");
    fireEvent.change(trigger, { target: { value: a } }); fireEvent.change(paired, { target: { value: b } }); fireEvent.click(screen.getByText("Add pair"));
    fireEvent.change(trigger, { target: { value: c } }); fireEvent.change(paired, { target: { value: d } }); fireEvent.click(screen.getByText("Add pair"));
    fireEvent.click(screen.getByText("Create draft policy"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/policy?organizationId=3"), expect.objectContaining({ method: "POST" })));
    const createCall = fetchMock.mock.calls.find((call) => call[1]?.method === "POST" && !String(call[0]).includes("/approve"));
    const body = JSON.parse(String(createCall?.[1]?.body));
    expect(body.collectionPoints).toEqual([{ occurrenceId: a }, { occurrenceId: c }, { occurrenceId: e }]);
    expect(body.occurrences.filter((row: { groupRole: string }) => row.groupRole === "paired")).toHaveLength(2);
    expect(body.occurrences.find((row: { occurrenceId: string }) => row.occurrenceId === e).groupRole).toBe("normal");
    expect(await screen.findByText(/lvf3policy:v1:/)).toBeVisible();
    vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.click(screen.getByText("Approve reviewed policy"));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/approve"))).toBe(true));
  });

  it("hydrates a persisted draft after reload and keeps non-disabled failures visible", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { activation: { id: "00000000-0000-4000-8000-000000000006", revision: 1, sourceFingerprint: `lvfinancialsource:v1:${"a".repeat(64)}` }, occurrences: [], nextPolicyVersion: 4, currentPolicy: null, draftPolicy: { id: "draft-1", policyVersion: 3, state: "draft", policyFingerprint: `lvf3policy:v1:${"c".repeat(64)}`, collectionPoints: [{ occurrenceId: a }], occurrences: [{ occurrenceId: a, groupKey: "normal-a", groupRole: "normal", pairedOccurrenceId: null, collectionPointOccurrenceId: a, itemIndex: 0 }] } } }), { status: 200 }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><F3PolicyReview leagueId={7} organizationId={3} /></QueryClientProvider>);
    expect(await screen.findByText(/draft-1/)).toBeVisible();
    expect(screen.getByText(/lvf3policy:v1:/)).toBeVisible();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "F1_ACTIVATION_REQUIRED", message: "Activation evidence is missing" } }), { status: 409 }));
    client.clear();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><F3PolicyReview leagueId={8} organizationId={3} /></QueryClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Activation evidence is missing");
  });
});
