// Re-export shim. The real schema lives in `./schema/` (one file per domain
// table), but the rest of the codebase imports from `@shared/schema` as a
// single entry point. Keep both — see `server/storage.ts` for the matching
// convention on the server side.
export * from "./schema/index";
export * from "./f4-canonical-autopay-contract";
export * from "./canonical-payment-report";
export * from "./payment-receipt";
