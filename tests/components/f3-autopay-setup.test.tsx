import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { F3CanonicalAutopaySetup } from "@/components/f3-canonical-autopay-setup";

const occurrence = "00000000-0000-4000-8000-000000000001";
const obligation = "00000000-0000-4000-8000-000000000002";
const policyId = "00000000-0000-4000-8000-000000000003";
const fingerprint = `lvf3quote:v1:${"a".repeat(64)}`;
const headers = { "Content-Type": "application/json" };

function authorizationRequired() { return new Response(JSON.stringify({ error: { code: "PAYER_AUTHORIZATION_REQUIRED", message: "Setup required" } }), { status: 409, headers }); }
function prequote(catchUpRequired = false) { return new Response(JSON.stringify({ data: { contractVersion: "canonical-autopay-preauthorization-quote/1", organizationId: 3, leagueId: 7, policy: { id: policyId, version: 1, activationRevision: 1, activationSourceFingerprint: `lvfinancialsource:v1:${"b".repeat(64)}` }, authorization: { payerBowlerId: 10, nextAuthorizationVersion: 1, coveredBowlerIds: [10, 11], acceptedPartnerIds: [11], collectionPointOccurrenceIds: [occurrence] }, items: [{ obligationId: obligation, occurrenceId: occurrence, bowlerId: 10, collectionPointOccurrenceId: occurrence, amountMinor: 1250, itemIndex: 0 }], groups: [{ occurrenceId: occurrence, groupKey: "normal", groupRole: "normal", pairedOccurrenceId: null, collectionPointOccurrenceId: occurrence, localDate: "2032-08-01", localStartTime: "19:00", timezone: "UTC", ordinal: 1 }], timing: "at_collection_point", totalAmountMinor: 1250, catchUpRequired, fingerprint } }), { status: 200, headers }); }

describe("F3 payer setup", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") return new Response(JSON.stringify({ data: { authorizationId: "auth-1" } }), { status: 201, headers });
    return url.includes("/quote?") ? authorizationRequired() : prequote();
  }); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("requires explicit card/partner choices and displays exact evidence", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><F3CanonicalAutopaySetup leagueId={7} organizationId={3} bowlerId={10} savedCards={[{ id: "card-1", brand: "Visa", last4: "1111", expMonth: 12, expYear: 2032 }]} acceptedPartners={[{ id: 11, name: "Partner" }]} /></QueryClientProvider>);
    expect(await screen.findByTestId("f3-canonical-autopay-setup")).toBeVisible();
    expect(screen.getByLabelText("Payment method")).toBeVisible();
    expect(screen.getAllByText(/\$12\.50/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/collection occurrence/i)).toBeVisible();
  });

  it("refetches for an accepted partner and submits the exact selected card/quote", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><F3CanonicalAutopaySetup leagueId={7} organizationId={3} bowlerId={10} savedCards={[{ id: "card-1", brand: "Visa", last4: "1111", expMonth: 12, expYear: 2032 }]} acceptedPartners={[{ id: 11, name: "Partner" }]} /></QueryClientProvider>);
    await screen.findByTestId("f3-canonical-autopay-setup");
    fireEvent.click(screen.getByLabelText("Partner"));
    await waitFor(() => expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("coveredBowlerIds=10%2C11") || String(call[0]).includes("coveredBowlerIds=10,11")).length).toBeGreaterThanOrEqual(1));
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "card-1" } });
    fireEvent.click(screen.getByText("Authorize exact plan"));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(true));
    const request = fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
    const body = JSON.parse(String(request?.[1]?.body));
    expect(body.sourceId).toBe("card-1"); expect(body.acceptedPartnerIds).toEqual([11]); expect(body.preauthorizationFingerprint).toBe(fingerprint); expect(body.authorizedItems).toHaveLength(1);
  });

  it("shows the F2 catch-up action without authorizing a future plan", async () => {
    const onCatchUp = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).includes("/quote?") ? authorizationRequired() : prequote(true));
    render(<QueryClientProvider client={client}><F3CanonicalAutopaySetup leagueId={7} organizationId={3} bowlerId={10} savedCards={[]} onCatchUp={onCatchUp} /></QueryClientProvider>);
    expect(await screen.findByText(/IMMEDIATE_CATCHUP_REQUIRED/)).toBeVisible(); fireEvent.click(screen.getByText("Complete F2 catch-up")); expect(onCatchUp).toHaveBeenCalled(); expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  });

  it("fails closed on malformed successful ready evidence and never starts prequote", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).includes("/quote?") ? new Response(JSON.stringify({ data: { contractVersion: "canonical-autopay-plan/1", items: [] } }), { status: 200, headers }) : prequote());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><F3CanonicalAutopaySetup leagueId={7} organizationId={3} bowlerId={10} savedCards={[]} /></QueryClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("PLAN_EVIDENCE_INCONSISTENT");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/prequote"))).toBe(false);
  });
});
