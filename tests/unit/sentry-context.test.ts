import { describe, expect, it } from "vitest";
import { sanitizedSentryIdentity } from "@shared/sentry-context";

describe("sanitizedSentryIdentity", () => {
  it("uses only opaque user and organization identifiers plus the role", () => {
    const authenticatedUser = {
      id: 42,
      organizationId: 7,
      role: "org_admin",
      email: "private@example.com",
      name: "Private Person",
    };
    const identity = sanitizedSentryIdentity(authenticatedUser);

    expect(identity).toEqual({
      user: { id: "user:42" },
      tags: {
        organization_id: "organization:7",
        user_role: "org_admin",
      },
    });
    expect(JSON.stringify(identity)).not.toContain("private@example.com");
    expect(JSON.stringify(identity)).not.toContain("Private Person");
  });

  it("clears identity for anonymous requests", () => {
    expect(sanitizedSentryIdentity(null)).toEqual({
      user: null,
      tags: { organization_id: "none", user_role: "anonymous" },
    });
  });
});
