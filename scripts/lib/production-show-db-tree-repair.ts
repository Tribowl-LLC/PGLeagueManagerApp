import { createHash } from "node:crypto";
import type { JournalEntryRow } from "./db-migration-journal";
import type { ActiveMigration } from "./db-migration-assets";
import type { DatabaseInventory, FunctionInfo } from "./db-schema-inventory";
import type { SchemaStateFingerprint } from "./db-schema-state-fingerprint";

export const SHOW_DB_TREE_REPAIR_CONFIRMATION =
  "REPAIR_LEAGUEVAULT_0049_SHOW_DB_TREE_35824851019";
export const SHOW_DB_TREE_REPAIR_ENVIRONMENT_KEY =
  "DB_PRODUCTION_SCHEMA_REPAIR_CONFIRMATION";
export const SHOW_DB_TREE_REPAIR_0049_TAG =
  "0049_account_ready_standalone_resend";
export const SHOW_DB_TREE_REPAIR_0050_TAG = "0050_rotating_team_payments";
export const SHOW_DB_TREE_REPAIR_PRE_DIGEST =
  "d3251c2f3478da2ae09206506f3076643b46fab2510c1452609d3fba98a1a868";
export const SHOW_DB_TREE_REPAIR_POST_DIGEST =
  "d58d7bdcac73fb6ab35c41403809583fbcea42faa862c5d215c82a6b26fe6fd2";
export const SHOW_DB_TREE_REPAIR_RAW_DEFINITION_SHA256 =
  "3cfbbce2aee1851aec351d1e99b7c071fa8bbf4b7c5f165f1fbb7f7e6506389a";
export const SHOW_DB_TREE_REPAIR_FUNCTION_DEFINITION_SHA256 =
  "5be7a62f70799a7e52d515b40b9a9cfa4104a5aeed4a9e507206298c22ed2dd4";

export const SHOW_DB_TREE_REPAIR_PRE_COUNTS: SchemaStateFingerprint["counts"] =
  {
    tables: 75,
    columns: 1050,
    nonTableRelations: 0,
    rewriteRules: 0,
    unsupportedPublicObjects: 0,
    extensions: 0,
    sequences: 32,
    constraints: 566,
    indexes: 321,
    types: 1,
    functions: 20,
    triggers: 33,
    policies: 0,
  };

interface ShowDbTreeAclGrant {
  grantor: string;
  grantee: string;
  privilegeType: string;
  isGrantable: boolean;
}

interface ShowDbTreeDependentObject {
  classId: string;
  objectId: string;
  objectSubId: string;
  dependencyType: string;
  description: string;
}

export interface ShowDbTreeCatalogSecurityState {
  owner: string;
  explicitAclPresent: boolean;
  rawDefinitionSha256: string;
  acl: ShowDbTreeAclGrant[];
  dependents: ShowDbTreeDependentObject[];
}

interface PinnedShowDbTreeCatalogSecurityState {
  owner: string;
  explicitAclPresent: boolean;
  rawDefinitionSha256: string;
  acl: readonly ShowDbTreeAclGrant[];
  dependents: readonly ShowDbTreeDependentObject[];
}

function pinnedShowDbTreeCatalogSecurityState(): PinnedShowDbTreeCatalogSecurityState {
  return {
    owner: "neondb_owner",
    explicitAclPresent: false,
    rawDefinitionSha256: SHOW_DB_TREE_REPAIR_RAW_DEFINITION_SHA256,
    acl: [
      {
        grantor: "neondb_owner",
        grantee: "PUBLIC",
        privilegeType: "EXECUTE",
        isGrantable: false,
      },
      {
        grantor: "neondb_owner",
        grantee: "neondb_owner",
        privilegeType: "EXECUTE",
        isGrantable: false,
      },
    ],
    dependents: [],
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function compareJsonValues(left: unknown, right: unknown): number {
  return stableJson(left).localeCompare(stableJson(right), "en");
}

function normalizeAcl(
  grants: readonly ShowDbTreeAclGrant[],
): ShowDbTreeAclGrant[] {
  return grants
    .map((grant) => ({
      grantor: grant.grantor,
      grantee: grant.grantee,
      privilegeType: grant.privilegeType,
      isGrantable: grant.isGrantable,
    }))
    .sort(compareJsonValues);
}

function normalizeDependents(
  dependents: readonly ShowDbTreeDependentObject[],
): ShowDbTreeDependentObject[] {
  return dependents
    .map((dependent) => ({ ...dependent }))
    .sort(compareJsonValues);
}

export function assertShowDbTreeCatalogSecurityState(
  actual: ShowDbTreeCatalogSecurityState,
): void {
  const expected = pinnedShowDbTreeCatalogSecurityState();
  if (actual.rawDefinitionSha256 !== expected.rawDefinitionSha256) {
    throw new Error(
      "The show_db_tree catalog guard failed: raw definition hash mismatch.",
    );
  }
  if (actual.owner !== expected.owner) {
    throw new Error("The show_db_tree catalog guard failed: owner mismatch.");
  }
  if (actual.explicitAclPresent !== expected.explicitAclPresent) {
    throw new Error(
      "The show_db_tree catalog guard failed: explicit ACL mismatch.",
    );
  }
  if (
    stableJson(normalizeAcl(actual.acl)) !==
    stableJson(normalizeAcl(expected.acl))
  ) {
    throw new Error(
      "The show_db_tree catalog guard failed: expanded ACL mismatch.",
    );
  }
  if (
    stableJson(normalizeDependents(actual.dependents)) !==
    stableJson(normalizeDependents(expected.dependents))
  ) {
    throw new Error(
      "The show_db_tree catalog guard failed: dependency mismatch.",
    );
  }
}

export function assertShowDbTreeRepairJournalBoundary(
  entries: readonly JournalEntryRow[],
  migrations: readonly ActiveMigration[],
): ActiveMigration {
  if (entries.length !== 50) {
    throw new Error(
      "Production repair requires the exact 50-entry journal prefix through migration 0049.",
    );
  }
  if (migrations.length !== 51) {
    throw new Error(
      "Production repair requires the checked-in active history through migration 0050.",
    );
  }
  const currentMigration = migrations[49];
  const nextMigration = migrations[50];
  if (
    !currentMigration ||
    currentMigration.tag !== SHOW_DB_TREE_REPAIR_0049_TAG ||
    !nextMigration ||
    nextMigration.tag !== SHOW_DB_TREE_REPAIR_0050_TAG
  ) {
    throw new Error(
      "Production repair is restricted to the checked-in 0049-to-0050 boundary.",
    );
  }
  return currentMigration;
}

export function assertShowDbTreeRepairPreFingerprint(
  fingerprint: SchemaStateFingerprint,
  migration: ActiveMigration,
): void {
  const actualCounts = Object.fromEntries(
    Object.entries(fingerprint.counts).sort(([left], [right]) =>
      left.localeCompare(right, "en"),
    ),
  );
  const expectedCounts = Object.fromEntries(
    Object.entries(SHOW_DB_TREE_REPAIR_PRE_COUNTS).sort(([left], [right]) =>
      left.localeCompare(right, "en"),
    ),
  );
  if (
    fingerprint.migration.tag !== migration.tag ||
    fingerprint.migration.hash !== migration.hash ||
    fingerprint.migration.createdAt !== migration.createdAt ||
    fingerprint.digest !== SHOW_DB_TREE_REPAIR_PRE_DIGEST ||
    stableJson(actualCounts) !== stableJson(expectedCounts)
  ) {
    throw new Error(
      "Production repair refuses any pre-repair schema other than the exact observed 0049 fingerprint and counts.",
    );
  }
}

function hasExternalDefinitionReference(
  inventory: DatabaseInventory,
  target: FunctionInfo,
): boolean {
  const referencesName = (value: string | null | undefined) =>
    typeof value === "string" && /\bshow_db_tree\b/i.test(value);
  return (
    inventory.functions.some(
      (fn) => fn !== target && referencesName(fn.definition),
    ) ||
    inventory.nonTableRelations.some((relation) =>
      referencesName(relation.definition),
    ) ||
    inventory.rewriteRules.some((rule) => referencesName(rule.definition)) ||
    inventory.triggers.some((trigger) => referencesName(trigger.definition)) ||
    inventory.policies.some(
      (policy) =>
        policy.dependencies.some(
          (dependency) =>
            dependency.kind === "function" &&
            dependency.schema === "public" &&
            dependency.name === "show_db_tree",
        ) ||
        referencesName(policy.using) ||
        referencesName(policy.withCheck),
    )
  );
}

export function assertExactShowDbTreeInventory(
  inventory: DatabaseInventory,
): FunctionInfo {
  const matches = inventory.functions.filter(
    (fn) => fn.schema === "public" && fn.name === "show_db_tree",
  );
  const target = matches[0];
  if (matches.length !== 1 || !target) {
    throw new Error(
      "Production repair requires exactly one public.show_db_tree() function.",
    );
  }
  const definitionHash = createHash("sha256")
    .update(target.definition)
    .digest("hex");
  if (
    target.identityArguments !== "" ||
    target.resultType !== "TABLE(tree_structure text)" ||
    target.language !== "plpgsql" ||
    target.kind !== "function" ||
    target.volatility !== "volatile" ||
    target.parallel !== "unsafe" ||
    target.securityDefiner !== false ||
    target.strict !== false ||
    target.leakproof !== false ||
    definitionHash !== SHOW_DB_TREE_REPAIR_FUNCTION_DEFINITION_SHA256
  ) {
    throw new Error(
      "Production repair refuses a show_db_tree function that differs from the reviewed definition.",
    );
  }
  if (hasExternalDefinitionReference(inventory, target)) {
    throw new Error(
      "Production repair refuses a show_db_tree function referenced by another catalog object.",
    );
  }
  return target;
}

export function assertShowDbTreeRepairConfirmation(
  value: string | undefined,
): void {
  if (value !== SHOW_DB_TREE_REPAIR_CONFIRMATION) {
    throw new Error("The exact incident repair confirmation is required.");
  }
}
