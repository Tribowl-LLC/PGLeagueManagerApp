import { pgTable, text, serial, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { nameSchema, emailSchema } from "./constants";

// Hostname (no scheme/path). Lowercase letters, digits, dot, hyphen.
// Used for the per-org embed-iframe allowlist (Task #681). Validated
// here so both insert/update schemas reject obvious garbage before
// it reaches the CSP middleware.
const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/, "Use a bare hostname (no scheme or path)")
  .refine((h) => !h.startsWith(".") && !h.endsWith("."), "Hostname cannot start or end with a dot");

export const organizations = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  subdomain: text("subdomain"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zipCode: text("zip_code"),
  phone: text("phone"),
  email: text("email"),
  logo: text("logo"),
  darkLogo: text("dark_logo"),
  appIcon: text("app_icon"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  // Task #681: domains allowed to embed this org's
  // registration iframe. The /embed/register/:leagueId middleware
  // sets `Content-Security-Policy: frame-ancestors 'self' <domains>`
  // from this list so each org owns its own embed allowlist.
  // Domains are stored as bare hostnames (no scheme); the middleware
  // rewrites them into `https://<host>` directives.
  allowedEmbedDomains: text("allowed_embed_domains").array().notNull().default(sql`'{}'`),
}, (table) => ({
  slugIdx: uniqueIndex("organization_slug_idx").on(table.slug),
  subdomainIdx: uniqueIndex("organization_subdomain_idx").on(table.subdomain).where(sql`${table.subdomain} IS NOT NULL`),
}));

const baseOrganizationSchema = createInsertSchema(organizations);

export const insertOrganizationSchema = baseOrganizationSchema.extend({
  name: nameSchema,
  slug: z.string().min(2, "Slug must be at least 2 characters").regex(/^[a-z0-9-]+$/, "Slug must contain only lowercase letters, numbers, and hyphens"),
  subdomain: z.string().min(2, "Subdomain must be at least 2 characters").regex(/^[a-z0-9]+$/, "Subdomain must contain only lowercase letters and numbers (no hyphens)").nullable().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  phone: z.string().optional(),
  email: z.union([emailSchema, z.literal("")]).optional(),
  logo: z.string().optional(),
  darkLogo: z.string().optional(),
  appIcon: z.string().optional(),
  active: z.boolean().default(true),
  allowedEmbedDomains: z.array(hostnameSchema).max(50).default([]),
}).omit({ id: true, createdAt: true });

export const updateOrganizationSchema = z.object({
  name: nameSchema,
  slug: z.string().min(2, "Slug must be at least 2 characters").regex(/^[a-z0-9-]+$/, "Slug must contain only lowercase letters, numbers, and hyphens"),
  subdomain: z.string().min(2, "Subdomain must be at least 2 characters").regex(/^[a-z0-9]+$/, "Subdomain must contain only lowercase letters and numbers (no hyphens)").nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zipCode: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.union([emailSchema, z.literal("")]).nullable(),
  logo: z.string().nullable(),
  darkLogo: z.string().nullable(),
  appIcon: z.string().nullable(),
  active: z.boolean(),
  allowedEmbedDomains: z.array(hostnameSchema).max(50),
}).partial();

export type Organization = typeof organizations.$inferSelect;
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;
