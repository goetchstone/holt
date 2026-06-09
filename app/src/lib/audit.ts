// /app/src/lib/audit.ts
//
// Structured audit logging for sensitive operations.
// Outputs to the application log stream (searchable via docker logs).

import { logger } from "@/lib/logger";

export type AuditEvent =
  | "IMPORT_WHOLESALE"
  | "IMPORT_FOUNDATIONS"
  | "IMPORT_FABRICS"
  | "IMPORT_WOOD"
  | "ROLE_CHANGE"
  | "BULK_DELETE"
  | "INVENTORY_CLEAR";

/**
 * Log a structured audit event. All audit entries include `audit: true`
 * for easy filtering in log aggregation (e.g., `docker logs | grep audit`).
 */
export function auditLog(
  event: AuditEvent,
  userId: string,
  details: Record<string, unknown> = {},
): void {
  logger.info(`Audit: ${event}`, {
    audit: true,
    event,
    userId,
    ...details,
  });
}
