import { pgTable, text, serial, integer, boolean, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { nameSchema } from "./constants";
import { organizations } from "./organizations";

export interface LocationSquareCredentials {
  appId?: string;
  accessToken?: string;
  locationId?: string;
}

export const locationSquareCredentialsSchema = z.object({
  appId: z.string().optional(),
  accessToken: z.string().optional(),
  locationId: z.string().optional(),
}).nullable().optional();

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Required fields for a fully-configured Square Ecommerce location.
 * Used by the server `/payments-provider/config` route and by the settings UI to detect
 * partial configurations and surface a clear "Square not fully
 * configured" message instead of failing silently at checkout.
 * (Task #579 — Square parity for the #575 partial-config UX.)
 */
export const REQUIRED_SQUARE_FIELDS = [
  'appId',
  'accessToken',
  'locationId',
] as const;

export type RequiredSquareField = (typeof REQUIRED_SQUARE_FIELDS)[number];

/**
 * Public/client-facing label for each required Square field. Kept here
 * so server logs and the settings/payment UIs use identical wording.
 */
export const SQUARE_FIELD_LABELS: Record<RequiredSquareField, string> = {
  appId: 'Application ID',
  accessToken: 'Access Token',
  locationId: 'Square Location ID',
};

/**
 * Returns the list of required Square fields that are missing from the
 * provided credentials blob. An empty array means the location is
 * fully configured.
 *
 * This works on the *raw* credentials shape (with `accessToken`) AND on the public-facing config shape
 * returned by GET `/locations/:id/square-config` (which exposes
 * `accessTokenConfigured: boolean` instead of the secret itself). The
 * latter is detected by the presence of `accessTokenConfigured` and
 * treated as "accessToken present" when true.
 */
interface SquareConfigStatusInput {
  appId?: string | null;
  accessToken?: string | null;
  accessTokenConfigured?: boolean;
  locationId?: string | null;
}

export function getMissingSquareFields(
  creds: SquareConfigStatusInput | null | undefined,
): RequiredSquareField[] {
  if (!creds) return [...REQUIRED_SQUARE_FIELDS];

  const missing: RequiredSquareField[] = [];

  if (!nonEmptyString(creds.appId)) missing.push('appId');
  const hasAccessToken =
    creds.accessTokenConfigured === true || nonEmptyString(creds.accessToken);
  if (!hasAccessToken) missing.push('accessToken');
  if (!nonEmptyString(creds.locationId)) missing.push('locationId');

  return missing;
}

export const locations = pgTable("locations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zipCode: text("zip_code"),
  phone: text("phone"),
  active: boolean("active").notNull().default(true),
  organizationId: integer("organization_id").notNull().references(() => organizations.id),
  squareCredentials: jsonb("square_credentials").$type<LocationSquareCredentials>(),
}, (table) => ({
  organizationIdx: index("locations_organization_idx").on(table.organizationId),
  // Canonical occurrence rows reference a location together with their
  // organization ID, so the parent must expose the tenant-safe key.
  idOrganizationUnique: uniqueIndex("locations_id_organization_unique").on(table.id, table.organizationId),
}));

const baseLocationSchema = createInsertSchema(locations);

export const insertLocationSchema = baseLocationSchema.extend({
  name: nameSchema,
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  phone: z.string().optional(),
  active: z.boolean().default(true),
  organizationId: z.number().int().positive(),
  squareCredentials: locationSquareCredentialsSchema,
}).omit({ id: true }).strict();

export const updateLocationSchema = z.object({
  name: nameSchema,
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zipCode: z.string().nullable(),
  phone: z.string().nullable(),
  active: z.boolean(),
  organizationId: z.number().int().positive(),
  squareCredentials: locationSquareCredentialsSchema,
}).partial().strict();

export type Location = typeof locations.$inferSelect;
export type InsertLocation = z.infer<typeof insertLocationSchema>;
export type UpdateLocation = z.infer<typeof updateLocationSchema>;
