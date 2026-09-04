export interface SentryIdentitySource {
  id: number;
  organizationId?: number | null;
  role?: string | null;
}

export interface SanitizedSentryIdentity {
  user: { id: string } | null;
  tags: {
    organization_id: string;
    user_role: string;
  };
}

/** Sentry identity deliberately excludes names, email addresses, and bowler IDs. */
export function sanitizedSentryIdentity(user: SentryIdentitySource | null | undefined): SanitizedSentryIdentity {
  if (!user) {
    return {
      user: null,
      tags: { organization_id: "none", user_role: "anonymous" },
    };
  }

  return {
    user: { id: `user:${user.id}` },
    tags: {
      organization_id: user.organizationId == null ? "none" : `organization:${user.organizationId}`,
      user_role: user.role ?? "unknown",
    },
  };
}
