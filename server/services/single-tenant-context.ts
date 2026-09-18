import type { Organization } from "@shared/schema";

export interface SingleTenantOrganizationRecord {
  id: number;
  active: boolean;
  slug: string | null;
  subdomain: string | null;
}
export interface SingleTenantActiveOrganizationRecord {
  id: number;
  active: boolean;
}

export interface SingleTenantContext {
  organizationId: number;
  organization: SingleTenantOrganizationRecord;
}

export type SingleTenantContextErrorCode =
  | "configuration_missing"
  | "configuration_invalid"
  | "organization_not_found"
  | "organization_inactive"
  | "no_active_organization"
  | "multiple_active_organizations"
  | "configured_organization_not_active";

export class SingleTenantContextError extends Error {
  readonly code: SingleTenantContextErrorCode;

  constructor(code: SingleTenantContextErrorCode, message: string) {
    super(message);
    this.name = "SingleTenantContextError";
    this.code = code;
  }
}

export type SingleTenantContextResult =
  | { ok: true; context: SingleTenantContext }
  | { ok: false; error: SingleTenantContextError };

export interface SingleTenantContextReader {
  getOrganization(id: number): Promise<Organization | undefined>;
  getActiveOrganizations(): Promise<readonly SingleTenantActiveOrganizationRecord[]>;
}

export interface ValidateSingleTenantContextInput {
  configuredOrganizationId: number | undefined;
  organization: SingleTenantOrganizationRecord | undefined;
  activeOrganizations: readonly SingleTenantActiveOrganizationRecord[];
}

function error(
  code: SingleTenantContextErrorCode,
  message: string,
): SingleTenantContextResult {
  return { ok: false, error: new SingleTenantContextError(code, message) };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validate the database-backed singleton invariant after configuration has
 * already been parsed. This pure function intentionally accepts the active
 * organization inventory so it can be tested without opening a database.
 */
export function validateSingleTenantContext(
  input: ValidateSingleTenantContextInput,
): SingleTenantContextResult {
  const { configuredOrganizationId, organization, activeOrganizations } = input;

  if (configuredOrganizationId === undefined) {
    return error(
      "configuration_missing",
      "APP_ORGANIZATION_ID is required before single-tenant business operations can run.",
    );
  }
  if (!isPositiveSafeInteger(configuredOrganizationId)) {
    return error(
      "configuration_invalid",
      "APP_ORGANIZATION_ID must be a positive safe integer.",
    );
  }
  if (!organization || organization.id !== configuredOrganizationId) {
    return error(
      "organization_not_found",
      `Configured organization ${configuredOrganizationId} does not exist.`,
    );
  }
  if (!organization.active) {
    return error(
      "organization_inactive",
      `Configured organization ${configuredOrganizationId} is inactive.`,
    );
  }
  if (activeOrganizations.length === 0) {
    return error(
      "no_active_organization",
      "No active organization exists; single-tenant operations are not ready.",
    );
  }
  if (activeOrganizations.length > 1) {
    return error(
      "multiple_active_organizations",
      "Multiple active organizations exist; single-tenant operations are not ready.",
    );
  }

  const [activeOrganization] = activeOrganizations;
  if (!activeOrganization || activeOrganization.id !== configuredOrganizationId) {
    return error(
      "configured_organization_not_active",
      `Configured organization ${configuredOrganizationId} is not the only active organization.`,
    );
  }

  return {
    ok: true,
    context: {
      organizationId: configuredOrganizationId,
      organization,
    },
  };
}

export interface ResolveSingleTenantContextOptions {
  /** Explicit values are useful for tests and operational callers. */
  organizationId?: unknown;
  nodeEnv?: string;
  appEnv?: string;
  reader?: SingleTenantContextReader;
}

function toOrganizationRecord(
  organization: Organization | undefined,
): SingleTenantOrganizationRecord | undefined {
  if (!organization) return undefined;
  return {
    id: organization.id,
    active: organization.active,
    slug: organization.slug,
    subdomain: organization.subdomain,
  };
}

/**
 * Resolve the authoritative organization for business operations. It never
 * accepts request, hostname, or browser input and it does not choose a row
 * implicitly: configuration and the database singleton invariant must both
 * agree before a context is returned.
 */
export async function resolveSingleTenantContext(
  options: ResolveSingleTenantContextOptions = {},
): Promise<SingleTenantContextResult> {
  const config = await import("../config.js");
  const configuration = config.validateProductionLikeRequiredConfiguration({
    appOrganizationId: options.organizationId ?? config.env.APP_ORGANIZATION_ID,
    nodeEnv: options.nodeEnv ?? config.env.NODE_ENV,
    appEnv: options.appEnv ?? config.env.APP_ENV,
  });

  if (!configuration.ok) {
    return error(
      configuration.reason.includes("must be set")
        ? "configuration_missing"
        : "configuration_invalid",
      configuration.reason,
    );
  }
  if (configuration.organizationId === undefined) {
    return error(
      "configuration_missing",
      "APP_ORGANIZATION_ID is required before single-tenant business operations can run.",
    );
  }

  const reader = options.reader ?? (await import("../storage/index.js")).storage;
  const [organization, activeOrganizations] = await Promise.all([
    reader.getOrganization(configuration.organizationId),
    reader.getActiveOrganizations(),
  ]);

  return validateSingleTenantContext({
    configuredOrganizationId: configuration.organizationId,
    organization: toOrganizationRecord(organization),
    activeOrganizations,
  });
}

/** Resolve the full durable row for legacy branding and route compatibility. */
export async function resolveConfiguredOrganization(): Promise<Organization> {
  const result = await resolveSingleTenantContext();
  if (!result.ok) throw result.error;
  const organization = await (await import('../storage/index.js')).storage.getOrganization(result.context.organizationId);
  if (!organization) {
    throw new SingleTenantContextError(
      'organization_not_found',
      `Configured organization ${result.context.organizationId} does not exist.`,
    );
  }
  return organization;
}
