import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock("pg", () => ({
  default: {
    Client: class {
      connect = mocks.connect;
      query = mocks.query;
      end = mocks.end;
    },
  },
}));

import { runCompletedSummerComparator } from "../../scripts/compare-completed-summer-occurrences";

const args = [
  "--organizationId=1",
  "--seasonYear=2025",
  "--asOfDate=2026-01-01",
  "--sourceScheduleRevision=1",
  "--currency=USD",
  "--regularSessionBillingPolicy=eligible_bowlers",
  "--billingOrdinalPolicy=planned_slot",
];

describe("B1 operator transaction lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.connect.mockReset();
    mocks.query.mockReset();
    mocks.end.mockReset();
  });

  it("uses the exact read-only transaction and rolls back/closes after success", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.connect.mockResolvedValue(undefined);
    mocks.end.mockResolvedValue(undefined);
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.startsWith("BEGIN")) return { rows: [] };
      if (statement === "ROLLBACK") return { rows: [] };
      return { rows: [] };
    });
    await expect(runCompletedSummerComparator(args, { DATABASE_URL: "postgres://redacted.invalid/db" })).resolves.toBe(0);
    expect(mocks.query.mock.calls[0]?.[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("canonical-occurrence-comparison-report/1"));
  });

  it("emits a sanitized fatal report and still rolls back/closes after a query failure", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mocks.connect.mockResolvedValue(undefined);
    mocks.end.mockResolvedValue(undefined);
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.startsWith("BEGIN")) return { rows: [] };
      if (statement === "ROLLBACK") return { rows: [] };
      throw new Error("secret database detail");
    });
    await expect(runCompletedSummerComparator(args, { DATABASE_URL: "postgres://secret.invalid/db" })).resolves.toBe(1);
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.end).toHaveBeenCalledOnce();
    const semanticOutput = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(semanticOutput).toContain("operator_read_failure");
    expect(semanticOutput).not.toContain("secret database detail");
    expect(semanticOutput).not.toContain("secret.invalid");
  });
});
