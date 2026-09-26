import { prisma } from '../db/prisma.js';
import { getContext } from '../context.js';
import { logger } from '../logger.js';

export interface AuditEntry {
  action: string; // "auth.login.success", "finance.movement.void"…
  entity?: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  // Por defecto salen del contexto de la request; se pisan cuando todavía no hay sesión (ej. login).
  userId?: number | null;
  accountId?: number | null;
}

const serialize = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

/** Registra una acción sensible. Nunca rompe la operación principal si falla. */
export async function audit(entry: AuditEntry): Promise<void> {
  const ctx = getContext();
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        entity: entry.entity ?? null,
        entityId: entry.entityId === undefined ? null : String(entry.entityId),
        before: serialize(entry.before),
        after: serialize(entry.after),
        userId: entry.userId === undefined ? (ctx?.userId ?? null) : entry.userId,
        accountId: entry.accountId === undefined ? (ctx?.accountId ?? null) : entry.accountId,
        impersonatorId: ctx?.impersonatorId ?? null,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
        requestId: ctx?.requestId ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, action: entry.action }, 'No se pudo registrar la auditoría');
  }
}
