import { createHash } from "node:crypto";

/** Deterministic JSON used for fingerprints shared by current contracts. */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonStringify(item)}`)
    .join(",")}}`;
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}
