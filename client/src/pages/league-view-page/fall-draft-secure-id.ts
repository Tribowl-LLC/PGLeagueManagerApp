export function secureFallDraftIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw new Error("Secure identifier generation is unavailable. Use a supported browser or update the app before retrying.");
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalSetupValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSetupValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalSetupValue(record[key])}`).join(",")}}`;
  }
  throw new Error("Setup intent contains an unsupported value");
}

export function createSetupIdempotencyKeyRetainer() {
  let retained: { semanticPayload: string; key: string } | null = null;
  return {
    keyFor(payload: unknown): string {
      const semanticPayload = canonicalSetupValue(payload);
      if (retained?.semanticPayload === semanticPayload) return retained.key;
      const key = secureFallDraftIdempotencyKey();
      retained = { semanticPayload, key };
      return key;
    },
    reset(): void {
      retained = null;
    },
  };
}
