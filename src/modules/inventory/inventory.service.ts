import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { deleteFile } from '../../core/files/files.service.js';
import { AppError } from '../../core/http/errors.js';
import { PaginationQuery, paged, toSkipTake } from '../../core/http/pagination.js';
import { toDate } from '../../core/time/local-date.js';
import { present, toMoney } from '../finance/money.js';
import { fold, isoDate } from '../people/people.service.js';
import type { Viewer } from '../people/people.scope.js';

// Inventario: equipos con su QR y su mantenimiento. El QR apunta al front (/i/<token>), que con
// sesiÃ³n y permiso abre la ficha; el token es aleatorio y no expone el id.

export const ITEM_STATUSES = ['ok', 'faulty', 'repair', 'retired'] as const;
export const MAINTENANCE_TYPES = ['preventive', 'repair', 'check'] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const money = z
  .number()
  .min(0)
  .max(999_999_999_999)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, { message: 'max 2 decimals' });

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._-]{0,19}$/);

const ItemFields = z.object({
  code: code.optional(), // sin cÃ³digo se genera uno (EQ-0001â€¦)
  name: z.string().trim().min(1).max(150),
  categoryId: z.number().int().positive(),
  campusId: z.number().int().positive().nullable().optional(),
  brand: optionalText(80),
  model: optionalText(80),
  serialNumber: optionalText(80),
  status: z.enum(ITEM_STATUSES).optional(),
  location: optionalText(150),
  purchaseDate: z.iso.date().nullable().optional(),
  purchaseValue: money.nullable().optional(),
  notes: optionalText(1000),
});

export const CreateItemSchema = ItemFields.strict();
export const UpdateItemSchema = ItemFields.partial().strict();

export const ListItemsQuery = PaginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  campusId: z.coerce.number().int().positive().optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  // Los dados de baja solo aparecen si se piden (o se filtra por ese estado).
  includeRetired: z.stringbool().default(false),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const MaintenanceSchema = z
  .object({
    date: z.iso.date(),
    type: z.enum(MAINTENANCE_TYPES),
    description: z.string().trim().min(1).max(1000),
    cost: money.nullable().optional(),
    vendor: optionalText(150),
    // Opcional: dejar el equipo en otro estado al registrar (ej. "en reparaciÃ³n" â†’ "ok").
    status: z.enum(ITEM_STATUSES).optional(),
  })
  .strict();

export const LabelsQuery = z.object({
  ids: z
    .string()
    .regex(/^\d+(,\d+)*$/)
    .transform((s) => [...new Set(s.split(',').map(Number))])
    .refine((ids) => ids.length <= 300),
});

export const qrUrl = (token: string) => `${env.APP_URL}/i/${token}`;
const newQrToken = () => randomBytes(16).toString('base64url'); // 22 caracteres

const searchTextOf = (i: {
  name: string;
  code: string;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
}) => fold([i.name, i.code, i.brand, i.model, i.serialNumber].filter(Boolean).join(' ')).slice(0, 500);

const listSelect = {
  id: true,
  code: true,
  name: true,
  brand: true,
  model: true,
  status: true,
  location: true,
  photoFileId: true,
  category: { select: { id: true, name: true, systemKey: true } },
  campus: { select: { id: true, name: true } },
} as const;

async function assertCategory(categoryId: number | undefined) {
  if (categoryId === undefined) return;
  const found = await tenantDb().catalogItem.count({ where: { id: categoryId, type: 'inventory_category' } });
  if (!found) throw AppError.badRequest('INVENTORY_CATEGORY_INVALID');
}

async function assertCampus(campusId: number | null | undefined) {
  if (campusId && !(await tenantDb().campus.count({ where: { id: campusId } }))) {
    throw AppError.badRequest('CAMPUS_INVALID');
  }
}

async function assertCodeFree(value: string, exceptId?: number) {
  const taken = await tenantDb().inventoryItem.count({
    where: { code: value, ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  if (taken) throw AppError.conflict('INVENTORY_CODE_IN_USE');
}

/** Siguiente EQ-NNNN libre de la cuenta. */
async function nextCode(): Promise<string> {
  const db = tenantDb();
  let n = (await db.inventoryItem.count()) + 1;
  for (let tries = 0; tries < 50; tries++, n++) {
    const candidate = `EQ-${String(n).padStart(4, '0')}`;
    if (!(await db.inventoryItem.count({ where: { code: candidate } }))) return candidate;
  }
  throw AppError.conflict('INVENTORY_CODE_IN_USE');
}

export async function listItems(q: z.infer<typeof ListItemsQuery>) {
  const words = fold(q.q).split(' ').filter(Boolean);
  const base: Prisma.InventoryItemWhereInput = {
    AND: [
      { deletedAt: null },
      ...words.map((w) => ({ searchText: { contains: w } })),
      ...(q.categoryId ? [{ categoryId: q.categoryId }] : []),
      ...(q.campusId ? [{ campusId: q.campusId }] : []),
    ],
  };
  const where: Prisma.InventoryItemWhereInput = {
    AND: [base, q.status ? { status: q.status } : q.includeRetired ? {} : { status: { not: 'retired' } }],
  };
  const db = tenantDb();
  const [items, total, byStatus] = await Promise.all([
    db.inventoryItem.findMany({
      where,
      select: listSelect,
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
      ...toSkipTake(q),
    }),
    db.inventoryItem.count({ where }),
    // CuÃ¡ntos hay en cada estado con los mismos filtros (para las pestaÃ±as).
    db.inventoryItem.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const row of byStatus) counts[row.status] = row._count._all;
  return { ...paged(items, total, q), counts };
}

async function findItem(id: number) {
  const item = await tenantDb().inventoryItem.findFirst({
    where: { id, deletedAt: null },
    select: {
      ...listSelect,
      serialNumber: true,
      purchaseDate: true,
      purchaseValue: true,
      qrToken: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
      maintenance: {
        select: {
          id: true,
          date: true,
          type: true,
          description: true,
          cost: true,
          vendor: true,
          createdAt: true,
        },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
      },
    },
  });
  if (!item) throw AppError.notFound('INVENTORY_ITEM_NOT_FOUND');
  return item;
}

export async function getItem(id: number) {
  const { purchaseDate, purchaseValue, qrToken, maintenance, ...item } = await findItem(id);
  const maintenanceCost = maintenance.reduce((sum, m) => (m.cost ? sum.add(m.cost) : sum), toMoney(0));
  return {
    ...item,
    purchaseDate: isoDate(purchaseDate),
    purchaseValue: present(purchaseValue),
    qrUrl: qrUrl(qrToken),
    maintenance: maintenance.map((m) => ({ ...m, date: isoDate(m.date)!, cost: present(m.cost) })),
    maintenanceCost: present(maintenanceCost),
  };
}

export async function createItem(viewer: Viewer, input: z.infer<typeof CreateItemSchema>) {
  await Promise.all([assertCategory(input.categoryId), assertCampus(input.campusId)]);
  if (input.code) await assertCodeFree(input.code);
  const itemCode = input.code ?? (await nextCode());
  const { purchaseDate, purchaseValue, ...fields } = input;
  const created = await tenantDb().inventoryItem.create({
    data: {
      accountId: currentAccountId(),
      ...fields,
      code: itemCode,
      campusId: input.campusId ?? null,
      purchaseDate: purchaseDate ? toDate(purchaseDate) : null,
      purchaseValue: purchaseValue == null ? null : toMoney(purchaseValue),
      qrToken: newQrToken(),
      searchText: searchTextOf({ ...fields, code: itemCode }),
      createdById: viewer.userId,
    },
    select: { id: true },
  });
  await audit({
    action: 'inventory.item.create',
    entity: 'InventoryItem',
    entityId: created.id,
    after: { code: itemCode, name: input.name },
  });
  return getItem(created.id);
}

export async function updateItem(id: number, input: z.infer<typeof UpdateItemSchema>) {
  const before = await findItem(id);
  await Promise.all([assertCategory(input.categoryId), assertCampus(input.campusId)]);
  if (input.code && input.code !== before.code) await assertCodeFree(input.code, id);
  const { purchaseDate, purchaseValue, ...fields } = input;
  const merged = {
    name: fields.name ?? before.name,
    code: fields.code ?? before.code,
    brand: fields.brand === undefined ? before.brand : fields.brand,
    model: fields.model === undefined ? before.model : fields.model,
    serialNumber: fields.serialNumber === undefined ? before.serialNumber : fields.serialNumber,
  };
  await tenantDb().inventoryItem.update({
    where: { id },
    data: {
      ...fields,
      ...(purchaseDate !== undefined ? { purchaseDate: purchaseDate ? toDate(purchaseDate) : null } : {}),
      ...(purchaseValue !== undefined
        ? { purchaseValue: purchaseValue === null ? null : toMoney(purchaseValue) }
        : {}),
      searchText: searchTextOf(merged),
    },
  });
  await audit({
    action: 'inventory.item.update',
    entity: 'InventoryItem',
    entityId: id,
    before: { code: before.code, name: before.name, status: before.status },
    after: { changed: Object.keys(input) },
  });
  return getItem(id);
}

/**
 * Baja lÃ³gica: el historial queda. El cÃ³digo se libera (se reemplaza por ~id, que no pasa la
 * validaciÃ³n de entrada) para poder reutilizarlo en otro equipo.
 */
export async function deleteItem(id: number) {
  const item = await findItem(id);
  await tenantDb().inventoryItem.update({
    where: { id },
    data: { deletedAt: new Date(), code: `~${id}`, photoFileId: null },
  });
  if (item.photoFileId) await deleteFile(item.photoFileId);
  await audit({
    action: 'inventory.item.delete',
    entity: 'InventoryItem',
    entityId: id,
    before: { code: item.code, name: item.name },
  });
}

export async function setPhoto(id: number, fileId: number | null) {
  const { photoFileId: previous } = await findItem(id);
  await tenantDb().inventoryItem.update({ where: { id }, data: { photoFileId: fileId } });
  if (previous) await deleteFile(previous);
  await audit({
    action: fileId ? 'inventory.photo.update' : 'inventory.photo.delete',
    entity: 'InventoryItem',
    entityId: id,
    ...(fileId ? { after: { fileId } } : {}),
  });
}

/** Equipo al que apunta un QR (para abrir su ficha). */
export async function resolveQr(token: string) {
  const item = await tenantDb().inventoryItem.findFirst({
    where: { qrToken: token, deletedAt: null },
    select: { id: true },
  });
  if (!item) throw AppError.notFound('INVENTORY_ITEM_NOT_FOUND');
  return item;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Mantenimiento â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function addMaintenance(
  viewer: Viewer,
  itemId: number,
  input: z.infer<typeof MaintenanceSchema>,
) {
  const item = await findItem(itemId);
  const { status, cost, date, ...fields } = input;
  const db = tenantDb();
  const created = await db.$transaction(async (tx) => {
    const row = await tx.inventoryMaintenance.create({
      data: {
        accountId: currentAccountId(),
        itemId,
        ...fields,
        date: toDate(date),
        cost: cost == null ? null : toMoney(cost),
        createdById: viewer.userId,
      },
      select: { id: true },
    });
    if (status && status !== item.status) {
      await tx.inventoryItem.update({ where: { id: itemId }, data: { status } });
    }
    return row;
  });
  await audit({
    action: 'inventory.maintenance.create',
    entity: 'InventoryItem',
    entityId: itemId,
    after: { maintenanceId: created.id, type: input.type, date, status: status ?? item.status },
  });
  return getItem(itemId);
}

export async function deleteMaintenance(id: number) {
  const db = tenantDb();
  const row = await db.inventoryMaintenance.findFirst({
    where: { id, item: { deletedAt: null } },
    select: { id: true, itemId: true, type: true, date: true },
  });
  if (!row) throw AppError.notFound('INVENTORY_MAINTENANCE_NOT_FOUND');
  await db.inventoryMaintenance.delete({ where: { id } });
  await audit({
    action: 'inventory.maintenance.delete',
    entity: 'InventoryItem',
    entityId: row.itemId,
    before: { maintenanceId: id, type: row.type, date: isoDate(row.date) },
  });
  return getItem(row.itemId);
}

/** Equipos para imprimir etiquetas, en el orden pedido (los inexistentes se ignoran). */
export async function itemsForLabels(ids: number[]) {
  const rows = await tenantDb().inventoryItem.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, code: true, name: true, qrToken: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [{ code: r.code, name: r.name, url: qrUrl(r.qrToken) }] : [];
  });
}
