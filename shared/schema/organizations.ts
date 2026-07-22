import { pgTable, text, serial, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { nameSchema, emailSchema } from "./constants";

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
}).partial();

export type Organization = typeof organizations.$inferSelect;
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;
