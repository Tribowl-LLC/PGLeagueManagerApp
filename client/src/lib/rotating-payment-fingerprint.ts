/** Create a versioned fingerprint for a canonical roster-payment command. */
export async function fingerprintCanonicalRequest(prefix: string, serializedRequest: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serializedRequest));
  const hexDigest = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${hexDigest}`;
}
