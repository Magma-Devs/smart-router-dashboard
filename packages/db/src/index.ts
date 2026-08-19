export { createDb, type Database, type DbHandle, type PostgresDatabase } from "./client.js";
export { migrate } from "./migrate.js";
export { seedAdmin, type SeedAdminOptions, type SeedResult } from "./seed.js";
export {
  createAuditWriter,
  type AuditAccessContext,
  type AuditActor,
  type AuditEventInput,
  type AuditViolation,
  type AuditWriter,
  type AuditWriterOptions,
} from "./audit.js";
export {
  AUDIT_TOKEN_PREFIX,
  hashAuditToken,
  listAuditTokens,
  looksLikeAuditToken,
  mintAuditToken,
  resolveAuditToken,
  revokeAuditToken,
  touchAuditToken,
  type MintAuditTokenInput,
  type MintedAuditToken,
  type RevokeAuditTokenInput,
} from "./audit-tokens.js";
export {
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  auditFilterFingerprint,
  checkAuditCursor,
  decodeAuditCursor,
  encodeAuditCursor,
  listAuditEvents,
  type AuditActorFilter,
  type AuditCursor,
  type AuditCursorRejection,
  type AuditPage,
  type AuditQuery,
} from "./audit-read.js";
/** Re-exported so a caller building an `AuditEventInput` gets every field's
 *  type from one import. `AuditChange` is defined in `@sr/shared` (the writer
 *  and the formatting rules that produce it live together); nobody consuming
 *  the writer should have to know that. */
export type { AuditChange } from "@sr/shared";
export * from "./schema.js";
