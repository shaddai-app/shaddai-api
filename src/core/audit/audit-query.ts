import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';
import { paged, toSkipTake, type Pagination } from '../http/pagination.js';

export interface AccountAuditFilters extends Pagination {
  userId?: number;
  action?: string;
  entity?: string;
  from?: Date;
  to?: Date;
}

const parseJson = (v: string | null) => (v === null ? null : (JSON.parse(v) as unknown));

/**
 * Auditoría de UNA cuenta. AuditLog no pasa por el filtro tenant (lo escribe el sistema), así que
 * el accountId se exige acá y el llamador lo toma de la sesión, nunca de la request.
 * De las sesiones de soporte solo se informa que existieron, no quién del equipo de Shaddai fue.
 */
export async function listAccountAudit(accountId: number, f: AccountAuditFilters) {
  const where: Prisma.AuditLogWhereInput = {
    accountId,
    ...(f.userId ? { userId: f.userId } : {}),
    ...(f.action ? { action: { startsWith: f.action } } : {}),
    ...(f.entity ? { entity: f.entity } : {}),
    ...(f.from || f.to ? { createdAt: { gte: f.from, lte: f.to } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, ...toSkipTake(f) }),
    prisma.auditLog.count({ where }),
  ]);

  const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is number => id !== null))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, accountId }, // nunca expone usuarios de otra cuenta ni al superadmin
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  const items = rows.map((r) => ({
    id: r.id.toString(),
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    before: parseJson(r.before),
    after: parseJson(r.after),
    user: r.userId ? (byId.get(r.userId) ?? null) : null,
    support: r.impersonatorId !== null || r.action.startsWith('platform.'),
    ip: r.ip,
    createdAt: r.createdAt,
  }));
  return paged(items, total, f);
}
