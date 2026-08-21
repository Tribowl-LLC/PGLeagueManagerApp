import { pgTable, text, serial, integer, boolean, timestamp, index, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { USER_ROLES, userRoleEnum, nameSchema, emailSchema } from "./constants";
import { passwordSchema } from "../password-validation";
import { bowlers } from "./bowlers";
import { organizations } from "./organizations";
import { locations } from "./locations";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  bowlerId: integer("bowler_id").references(() => bowlers.id),
  name: text("name").notNull(),
  phone: text("phone"),
  avatar: text("avatar"),
  role: userRoleEnum('role').notNull().default('user'),
  organizationId: integer("organization_id").references(() => organizations.id),
  locationId: integer("location_id").references(() => locations.id),
  // Two-letter ISO 639-1 code (e.g. 'en', 'es') used to localize
  // user-facing notifications (security emails, etc.). Nullable; the
  // email helpers fall back to English when this is null/unset/
  // unknown. See `server/services/email-i18n/` for supported locales.
  preferredLanguage: text("preferred_language"),
  // Task #357: hard lockout on /api/account/change-password after
  // repeated failed current-password checks. The per-user rate limiter
  // (#317, #356) still slows brute-forcing to ~10/15min, but a patient
  // attacker on a hijacked session can spread guesses across rate-limit
  // windows and still grind through ~960/day. This counter escalates
  // throttling to a temporary lockout once `failedPasswordChangeAttempts`
  // crosses `PASSWORD_CHANGE_LOCKOUT_THRESHOLD` (see server/storage/users.ts).
  // The counter is incremented atomically (FOR UPDATE) on every
  // INVALID_PASSWORD and reset to 0 on a successful change-password.
  // When the lock engages, every session for the user is destroyed and
  // an alert email is sent. The counter resets to 0 on the first new
  // failed attempt AFTER the lock has expired so a returning user gets
  // a fresh window instead of being re-locked on the very next typo.
  failedPasswordChangeAttempts: integer("failed_password_change_attempts").notNull().default(0),
  // When non-null and in the future, the user is locked out of the
  // change-password endpoint until this timestamp. The route checks
  // this BEFORE comparing the current password and returns 423
  // ACCOUNT_LOCKED so the client can prompt the user to use the
  // forgot-password flow. Naturally clears on success and on the
  // next failed attempt past expiry.
  passwordChangeLockedUntil: timestamp("password_change_locked_until", { mode: "string" }),
  // Task #455: when true, the user is forced through the change-password
  // flow on their next protected request before they can use the rest
  // of the app. Set to TRUE by the admin-driven reset endpoint at
  // server/routes/organization-admin.ts (the admin necessarily knows
  // the password they just picked, so we make the user rotate it on
  // first sign-in to remove the impersonation window). Cleared back to
  // FALSE by the self-service change-password endpoint in
  // server/routes/account.ts after a successful rotation. The flag is
  // surfaced to the client via the SAFE_USER_FIELDS allowlist so the
  // ProtectedRoute / RootRedirectHandler guards in client/src/App.tsx
  // can route the user to /change-password-required.
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, (table) => ({
  organizationIdx: index("users_organization_idx").on(table.organizationId),
  bowlerIdx: index("users_bowler_idx").on(table.bowlerId),
  locationIdx: index("users_location_idx").on(table.locationId),
  // Account email is an identity key, so case-only variants must not create
  // separate users. Application writes normalize too; this index is the
  // final concurrency-safe boundary for legacy or direct SQL callers.
  normalizedEmailUnique: uniqueIndex("users_email_normalized_unique")
    .on(sql`lower(btrim(${table.email}))`),
  // A bowler account can have at most one user. The predicate preserves the
  // normal PostgreSQL behavior for unlinked users (multiple NULL values).
  bowlerUnique: uniqueIndex("users_bowler_id_unique")
    .on(table.bowlerId)
    .where(sql`${table.bowlerId} IS NOT NULL`),
  // Both tenant-bound references carry the user's organization stamp. A
  // mismatched organization therefore fails at the database boundary even
  // when an application caller bypasses the storage layer.
  bowlerOrganizationFk: foreignKey({
    columns: [table.bowlerId, table.organizationId],
    foreignColumns: [bowlers.id, bowlers.organizationId],
    name: "users_bowler_organization_fk",
  }),
  locationOrganizationFk: foreignKey({
    columns: [table.locationId, table.organizationId],
    foreignColumns: [locations.id, locations.organizationId],
    name: "users_location_organization_fk",
  }),
  paymentManagerScopeCheck: check(
    "users_payment_manager_scope_check",
    // Cast to text so the forward migration can add the enum value and this
    // constraint in the same transaction without PostgreSQL rejecting use of
    // a newly-added enum label before commit.
    sql`${table.role}::text <> 'payment_manager' OR (${table.organizationId} IS NOT NULL AND ${table.locationId} IS NOT NULL)`,
  ),
  elevatedRoleBowlerCheck: check(
    "users_elevated_role_bowler_check",
    sql`${table.role}::text NOT IN ('system_admin', 'org_admin', 'payment_manager') OR ${table.bowlerId} IS NULL`,
  ),
  // The role/org invariant — every non-admin user must be attached to
  // an organization — is enforced by a DB-side TRIGGER named
  // `users_role_org_required`, installed idempotently by
  // `installDbInvariants` in `server/db-invariants.ts` (called from
  // both `server/index.ts` on every server boot and
  // `tests/setup/global-setup.ts` from vitest's globalSetup).
  // It used to be a CHECK constraint, but a trigger is required so
  // the system-admin "orphan data" cleanup tooling tests can stage
  // legacy org-less rows by briefly disabling the trigger inside a
  // single transaction (`ALTER TABLE ... DISABLE TRIGGER` only takes
  // SHARE ROW EXCLUSIVE — CHECK constraints can't be bypassed
  // per-session at all without superuser privileges).
}));


const baseUserSchema = createInsertSchema(users);

const requireOrgForNonAdmin = (
  data: { role?: string | null; organizationId?: number | null; locationId?: number | null; bowlerId?: number | null },
  ctx: z.RefinementCtx,
) => {
  const role = data.role ?? 'user';
  if (role !== 'system_admin' && (data.organizationId === null || data.organizationId === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['organizationId'],
      message: 'organizationId is required for non-admin users',
    });
  }
  if (
    (role === 'system_admin' || role === 'org_admin' || role === 'payment_manager') &&
    data.bowlerId !== null && data.bowlerId !== undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bowlerId'],
      message: 'Elevated-role users cannot be linked to a bowler',
    });
  }
  if (role === 'payment_manager') {
    if (data.organizationId === null || data.organizationId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['organizationId'],
        message: 'payment_manager users require an organization',
      });
    }
    if (data.locationId === null || data.locationId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locationId'],
        message: 'payment_manager users require a location',
      });
    }
  }
};

export const insertUserSchema = baseUserSchema.extend({
  email: emailSchema,
  name: nameSchema,
  phone: z.string().optional(),
  role: z.enum(USER_ROLES).optional().default('user'),
  organizationId: z.number().nullable().optional(),
  locationId: z.number().nullable().optional(),
  password: passwordSchema,
  bowlerId: z.number().nullable().optional(),
}).omit({ id: true, createdAt: true }).superRefine(requireOrgForNonAdmin);

// Base object schema (kept .pick / .omit / .partial friendly so that
// callers like `server/routes/account.ts` can derive narrower schemas).
export const updateUserSchemaBase = z.object({
  email: emailSchema,
  name: nameSchema,
  phone: z.string().nullable(),
  avatar: z.string().nullable(),
  role: z.enum(USER_ROLES),
  organizationId: z.number().nullable(),
  locationId: z.number().nullable(),
  bowlerId: z.number().nullable(),
  password: passwordSchema,
  preferredLanguage: z.string().nullable(),
  // Task #455: server-only flag. Listed here so the storage helper
  // signature (`UpdateUser`) accepts it from the admin-reset and
  // self-service change-password code paths. Not derived into any
  // request-body schema — every PATCH route in the codebase picks
  // its own subset of fields, so this stays inaccessible to clients.
  mustChangePassword: z.boolean(),
}).partial();

// Strict update schema: refuses payloads that would set a non-admin
// user to an org-less state. The role/org invariant is also enforced
// at the storage layer (`setUserOrganization`, `updateUserRole`) and
// by the `users_role_org_required` DB CHECK constraint.
export const updateUserSchema = updateUserSchemaBase.superRefine((data, ctx) => {
  const settingNullOrg = data.organizationId === null;
  const settingNonAdminRole = data.role !== undefined && data.role !== 'system_admin';
  if (settingNullOrg && settingNonAdminRole) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['organizationId'],
      message: 'organizationId is required for non-admin users',
    });
  }
  if (settingNullOrg && data.role === undefined) {
    // We can't know the resulting role here without the DB row, so leave
    // this case to the storage-layer guard which has the existing role.
  }
  if (
    (data.role === 'system_admin' || data.role === 'org_admin' || data.role === 'payment_manager') &&
    data.bowlerId !== undefined && data.bowlerId !== null
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bowlerId'],
      message: 'Elevated-role users cannot be linked to a bowler',
    });
  }
  if (data.role === 'payment_manager') {
    if (data.organizationId === null || data.organizationId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['organizationId'],
        message: 'payment_manager users require an organization',
      });
    }
    if (data.locationId === null || data.locationId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locationId'],
        message: 'payment_manager users require a location',
      });
    }
  }
});

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type UpdateUser = z.infer<typeof updateUserSchema>;
