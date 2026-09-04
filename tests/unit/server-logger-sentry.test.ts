import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureServerErrorReporter,
  createLogger,
  type ServerErrorReporter,
} from "../../server/logger";
import { expectErrorLog } from "../helpers/expected-error-logs";

afterEach(() => {
  configureServerErrorReporter(null);
});

describe("server handled-error reporting", () => {
  it("reports Error arguments with the logger scope", () => {
    expectErrorLog("Error deleting team:");
    const reporter = vi.fn<ServerErrorReporter>();
    const error = new Error("database constraint failed");
    configureServerErrorReporter(reporter);

    createLogger("Teams").error("Error deleting team:", error);

    expect(reporter).toHaveBeenCalledOnce();
    expect(reporter).toHaveBeenCalledWith(error, { logger: "Teams" });
  });

  it("does not turn plain diagnostic objects into Sentry exceptions", () => {
    expectErrorLog("Already captured express error:");
    const reporter = vi.fn<ServerErrorReporter>();
    configureServerErrorReporter(reporter);

    createLogger("Server").error("Already captured express error:", {
      name: "Error",
      message: "handled",
    });

    expect(reporter).not.toHaveBeenCalled();
  });

  it("does not let reporter failures escape the application error path", () => {
    expectErrorLog("Operation failed:");
    configureServerErrorReporter(() => {
      throw new Error("telemetry unavailable");
    });

    expect(() => createLogger("Teams").error("Operation failed:", new Error("root cause"))).not.toThrow();
  });
});
