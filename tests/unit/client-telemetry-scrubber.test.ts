/**
 * task #770: the client logger (`client/src/lib/logger.ts`) is the
 * central funnel for non-401 API/query failures and Square/
 * wallet/provider payment errors that get forwarded to Sentry. These
 * tests pin the redaction scrubber so PII (emails, phones) and
 * secret-shaped strings (provider/customer/card IDs, tokens, sensitive
 * invite/reset/confirm links, raw response bodies) never leave the
 * client unscrubbed, while benign diagnostics survive intact.
 */
import { describe, it, expect } from "vitest";
import {
  scrubString,
  scrubDeep,
  sanitizeForTelemetry,
  scrubSentryEvent,
} from "@/lib/logger";

describe("scrubString redaction categories", () => {
  it("masks email addresses", () => {
    const out = scrubString("user contact: jane.doe+league@example.com here");
    expect(out).not.toContain("jane.doe+league@example.com");
    expect(out).toContain("[redacted-email]");
  });

  it("masks phone-like number strings", () => {
    const out = scrubString("call +1 (555) 123-4567 now");
    expect(out).not.toContain("555");
    expect(out).not.toContain("4567");
    expect(out).toContain("[redacted-phone]");
  });

  it("masks Square card-on-file / nonce provider IDs", () => {
    const out = scrubString("token was ccof:GaJGNoeYHc5VYzRA___ failed");
    expect(out).not.toContain("ccof:GaJGNoeYHc5VYzRAyJpY");
    expect(out).not.toContain("GaJGNoeYHc5VYzRAyJpY");
    expect(out).toContain("[redacted-token]");
  });

  it("masks long opaque customer/card/payment IDs", () => {
    const out = scrubString("customerId=CBASEKj9xQ1aBcDeFgHiJkLmNoPq processed");
    expect(out).not.toContain("CBASEKj9xQ1aBcDeFgHiJkLmNoPq");
    expect(out).toContain("[redacted-token]");
  });

  it("masks bearer-style and secret-shaped tokens", () => {
    const out = scrubString("Authorization: Bearer sq0atp-aBcDeFgHiJkLmNoPqRsTuV");
    expect(out).not.toContain("sq0atp-aBcDeFgHiJkLmNoPqRsTuV");
    expect(out).toContain("[redacted-token]");
  });

  it("masks invite / reset / confirm links carrying tokens", () => {
    const reset = scrubString(
      "open https://app.example.com/reset-password?token=abc123secretvalue please",
    );
    expect(reset).not.toContain("abc123secretvalue");
    expect(reset).not.toContain("/reset-password?token=");
    expect(reset).toContain("[redacted-link]");

    const invite = scrubString(
      "https://app.example.com/invite/9f8e7d6c5b4a3 join",
    );
    expect(invite).not.toContain("9f8e7d6c5b4a3");
    expect(invite).toContain("[redacted-link]");
  });

  it("leaves benign diagnostic text untouched", () => {
    const msg = "GET /api/leagues request failed with status 500";
    expect(scrubString(msg)).toBe(msg);
  });
});

describe("scrubDeep truncation and traversal", () => {
  it("truncates large raw bodies / blobs", () => {
    const huge = "lorem ipsum dolor sit amet ".repeat(100);
    const out = scrubDeep(huge) as string;
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("[truncated]");
  });

  it("recursively scrubs nested object string values", () => {
    const out = scrubDeep({
      body: { email: "secret@example.com", note: "ok" },
    }) as Record<string, Record<string, string>>;
    expect(out.body.email).toBe("[redacted-email]");
    expect(out.body.note).toBe("ok");
  });

  it("collapses values beyond the depth limit", () => {
    const deep = { a: { b: { c: { d: { e: "deep" } } } } };
    const out = JSON.stringify(scrubDeep(deep));
    expect(out).toContain("[redacted-depth]");
  });
});

describe("sanitizeForTelemetry", () => {
  it("scrubs the message and forwards a safe error name", () => {
    const err = new Error("payment for jane@example.com failed");
    const { message, extra } = sanitizeForTelemetry(
      "[Payment] charge failed for jane@example.com",
      err,
    );
    expect(message).toContain("[redacted-email]");
    expect(message).not.toContain("jane@example.com");
    expect(extra.errorName).toBe("Error");
    expect(extra.errorMessage).toContain("[redacted-email]");
    expect(extra.errorMessage).not.toContain("jane@example.com");
  });

  it("does not dump whole unknown objects, only safe scalar fields", () => {
    const providerError = {
      status: 422,
      statusText: "Unprocessable Entity",
      body: { customerId: "CBASEKj9xQ1aBcDeFgHiJkLmNoPq", email: "a@b.com" },
      message: "raw provider blob",
    };
    const { extra } = sanitizeForTelemetry("[Square] charge failed", providerError);
    expect(extra.status).toBe(422);
    expect(extra.statusText).toBe("Unprocessable Entity");
    // The nested raw body (and its IDs/emails) must not be forwarded.
    expect(extra.body).toBeUndefined();
    expect(JSON.stringify(extra)).not.toContain("CBASEKj9xQ1aBcDeFgHiJkLmNoPq");
    expect(JSON.stringify(extra)).not.toContain("a@b.com");
  });

  it("scrubs and truncates a string detail", () => {
    const { extra } = sanitizeForTelemetry(
      "[Query] error",
      "failed for user@example.com",
    );
    expect(extra.detail).toContain("[redacted-email]");
  });

  it("returns an empty extra for a benign message with no value", () => {
    const { message, extra } = sanitizeForTelemetry("[App] started");
    expect(message).toBe("[App] started");
    expect(Object.keys(extra)).toHaveLength(0);
  });
});

describe("scrubSentryEvent backstop", () => {
  it("scrubs event message, exception values, extra and breadcrumbs", () => {
    const event = {
      message: "failure for user@example.com",
      exception: {
        values: [{ type: "Error", value: "card ccof:GaJGNoeYHc5VYzRAyJpY declined" }],
      },
      extra: { detail: "reset https://app.example.com/reset?token=abc123secret" },
      breadcrumbs: [
        {
          message: "POST /api/payments for jane@example.com",
          data: { phone: "+1 (555) 123-4567" },
        },
      ],
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.message).toContain("[redacted-email]");
    expect(scrubbed.exception.values[0].value).toContain("[redacted-token]");
    expect(scrubbed.exception.values[0].value).not.toContain("GaJGNoeYHc5VYzRAyJpY");
    expect(String(scrubbed.extra.detail)).toContain("[redacted-link]");
    expect(scrubbed.breadcrumbs[0].message).toContain("[redacted-email]");
    expect(JSON.stringify(scrubbed.breadcrumbs[0].data)).toContain("[redacted-phone]");
  });

  it("drops request secrets and keeps only an opaque user id", () => {
    const event = {
      request: {
        url: "https://leaguevault.app/api/account/reset?token=secret-value",
        method: "POST",
        headers: { authorization: "Bearer private-token" },
        cookies: { session: "private-session" },
        data: { email: "private@example.com" },
        query_string: "token=secret-value",
        env: { REMOTE_ADDR: "192.0.2.1" },
      },
      user: {
        id: "user:42",
        email: "private@example.com",
        username: "Private Person",
        ip_address: "192.0.2.1",
      },
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.request.url).toBe("[redacted-link]");
    expect(scrubbed.request.method).toBe("POST");
    expect(scrubbed.request.headers).toBeUndefined();
    expect(scrubbed.request.cookies).toBeUndefined();
    expect(scrubbed.request.data).toBeUndefined();
    expect(scrubbed.request.query_string).toBeUndefined();
    expect(scrubbed.request.env).toBeUndefined();
    expect(scrubbed.user).toEqual({ id: "user:42" });
  });
});
