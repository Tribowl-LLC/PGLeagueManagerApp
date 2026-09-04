import { describe, expect, it } from "vitest";

import { isTransientDatabaseError } from "../../server/utils/db-errors";

describe("isTransientDatabaseError", () => {
  it("recognizes pg-pool's code-less connection timeout through a Drizzle cause", () => {
    const poolTimeout = new Error("timeout exceeded when trying to connect");
    const drizzleError = new Error("Failed query: SELECT 1", { cause: poolTimeout });

    expect(isTransientDatabaseError(drizzleError)).toBe(true);
  });

  it("does not retry an ordinary failed query without a transient cause", () => {
    const queryError = new Error("Failed query: SELECT * FROM missing_table");

    expect(isTransientDatabaseError(queryError)).toBe(false);
  });
});
