import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';

const t = tenantRouter();
export const catalogsRouter = t.router;

/** Tipos de catálogo que la cuenta puede editar. Cada módulo que agregue uno lo suma acá. */
export const CATALOG_TYPES = [
  'person_status',
  'milestone',
  'position',
  'inventory_category',
  'event_type',
] as const;
export type CatalogType = (typeof CATALOG_TYPES)[number];

const TypeParam = z.object({ type: z.enum(CATALOG_TYPES) });
const ItemParam = TypeParam.extend({ id: z.coerce.number().int().positive() });
const IdParam = z.object({ id: z.coerce.number().int().positive() });
const color = z
  .string()
  .trim()
  .regex(/^[a-z]+(\.\d)?$|^#[0-9a-f]{6}$/i)
  .max(20)
  .nullable();

const CreateItem = z
  .object({
    name: z.string().trim().min(1).max(100),
    color: color.optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

const UpdateItem = z
  .object({
    // null = volver al nombre traducido (solo ítems del sistema).
    name: z.string().trim().min(1).max(100).nullable(),
    color,
    sortOrder: z.number().int().min(0).max(100_000),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

const ReorderItems = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }).strict();

const itemSelect = {
  id: true,
  type: true,
  systemKey: true,
  name: true,
  color: true,
  sortOrder: true,
  isActive: true,
} as const;

/** Cuántos registros usan el ítem: si hay alguno no se puede borrar (solo desactivar). */
async function usageCount(type: CatalogType, id: number): Promise<number> {
  const db = tenantDb();
  switch (type) {
    case 'person_status': {
      const [people, history] = await Promise.all([
        db.person.count({ where: { statusId: id } }),
        db.personStatusHistory.count({ where: { OR: [{ fromStatusId: id }, { toStatusId: id }] } }),
      ]);
      return people + history;
    }
    case 'milestone':
      return db.personMilestone.count({ where: { milestoneTypeId: id } });
    case 'position':
      return db.personPosition.count({ where: { positionId: id } });
    default:
      return 0; // inventario y eventos todavía no existen
  }
}

async function findItem(type: CatalogType, id: number) {
  const item = await tenantDb().catalogItem.findFirst({ where: { id, type }, select: itemSelect });
  if (!item) throw AppError.notFound('CATALOG_ITEM_NOT_FOUND');
  return item;
}

/** Siempre tiene que quedar al menos un estado de persona activo (las altas lo necesitan). */
async function assertAnotherActiveStatus(excludingId: number) {
  const others = await tenantDb().catalogItem.count({
    where: { type: 'person_status', isActive: true, id: { not: excludingId } },
  });
  if (others === 0) throw AppError.conflict('CATALOG_LAST_ACTIVE_STATUS');
}

// Cualquier usuario: los catálogos alimentan selectores y filtros en todo el front.
t.get('/catalogs/:type', 'account-user', async (req, res) => {
  const { type } = parse(TypeParam, req.params);
  const { includeInactive } = parse(z.object({ includeInactive: z.stringbool().default(false) }), req.query);
  const items = await tenantDb().catalogItem.findMany({
    where: { type, ...(includeInactive ? {} : { isActive: true }) },
    select: itemSelect,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  res.json({ items });
});

t.post('/catalogs/:type', 'catalogos.gestionar', async (req, res) => {
  const { type } = parse(TypeParam, req.params);
  const input = parse(CreateItem, req.body);
  const db = tenantDb();
  const last = await db.catalogItem.aggregate({ where: { type }, _max: { sortOrder: true } });
  const item = await db.catalogItem.create({
    data: {
      accountId: currentAccountId(),
      type,
      name: input.name,
      color: input.color ?? null,
      sortOrder: input.sortOrder ?? (last._max.sortOrder ?? 0) + 10,
    },
    select: itemSelect,
  });
  await audit({ action: 'catalogs.create', entity: 'CatalogItem', entityId: item.id, after: item });
  res.status(201).json(item);
});

t.put('/catalogs/:type/order', 'catalogos.gestionar', async (req, res) => {
  const { type } = parse(TypeParam, req.params);
  const { ids } = parse(ReorderItems, req.body);
  const db = tenantDb();
  const unique = [...new Set(ids)];
  const found = await db.catalogItem.count({ where: { type, id: { in: unique } } });
  if (found !== unique.length) throw AppError.badRequest('CATALOG_ITEM_INVALID');
  await db.$transaction(
    unique.map((id, i) => db.catalogItem.update({ where: { id }, data: { sortOrder: (i + 1) * 10 } })),
  );
  await audit({ action: 'catalogs.reorder', entity: 'CatalogItem', after: { type, ids: unique } });
  const items = await db.catalogItem.findMany({
    where: { type },
    select: itemSelect,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  res.json({ items });
});

t.patch('/catalogs/:type/:id', 'catalogos.gestionar', async (req, res) => {
  const { type, id } = parse(ItemParam, req.params);
  const input = parse(UpdateItem, req.body);
  const before = await findItem(type, id);
  if (input.name === null && !before.systemKey) throw AppError.badRequest('CATALOG_NAME_REQUIRED');
  if (type === 'person_status' && input.isActive === false && before.isActive) {
    await assertAnotherActiveStatus(id);
  }
  const item = await tenantDb().catalogItem.update({ where: { id }, data: input, select: itemSelect });
  await audit({ action: 'catalogs.update', entity: 'CatalogItem', entityId: id, before, after: item });
  res.json(item);
});

t.delete('/catalogs/:type/:id', 'catalogos.gestionar', async (req, res) => {
  const { type, id } = parse(ItemParam, req.params);
  const item = await findItem(type, id);
  // Los del sistema se pueden renombrar o desactivar, pero no borrar (los usa la plantilla y la traducción).
  if (item.systemKey) throw AppError.conflict('CATALOG_SYSTEM_ITEM');
  if ((await usageCount(type, id)) > 0) throw AppError.conflict('CATALOG_IN_USE');
  if (type === 'person_status' && item.isActive) await assertAnotherActiveStatus(id);
  await tenantDb().catalogItem.delete({ where: { id } });
  await audit({ action: 'catalogs.delete', entity: 'CatalogItem', entityId: id, before: item });
  res.status(204).end();
});

// ───────────── Etiquetas ─────────────

const TagInput = z.object({ name: z.string().trim().min(1).max(60), color: color.optional() }).strict();

const tagSelect = {
  id: true,
  name: true,
  color: true,
  _count: { select: { people: { where: { person: { deletedAt: null } } } } },
} as const;

const presentTag = ({ _count, ...tag }: Prisma.TagGetPayload<{ select: typeof tagSelect }>) => ({
  ...tag,
  peopleCount: _count.people,
});

async function saveTag<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict('TAG_NAME_IN_USE');
    }
    throw err;
  }
}

t.get('/tags', 'account-user', async (_req, res) => {
  const tags = await tenantDb().tag.findMany({ select: tagSelect, orderBy: { name: 'asc' } });
  res.json({ items: tags.map(presentTag) });
});

t.post('/tags', 'catalogos.gestionar', async (req, res) => {
  const input = parse(TagInput, req.body);
  const tag = await saveTag(() =>
    tenantDb().tag.create({
      data: { accountId: currentAccountId(), name: input.name, color: input.color ?? null },
      select: tagSelect,
    }),
  );
  await audit({ action: 'tags.create', entity: 'Tag', entityId: tag.id, after: input });
  res.status(201).json(presentTag(tag));
});

t.patch('/tags/:id', 'catalogos.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(TagInput.partial(), req.body);
  const db = tenantDb();
  const before = await db.tag.findUnique({ where: { id }, select: { id: true, name: true, color: true } });
  if (!before) throw AppError.notFound('TAG_NOT_FOUND');
  const tag = await saveTag(() => db.tag.update({ where: { id }, data: input, select: tagSelect }));
  await audit({ action: 'tags.update', entity: 'Tag', entityId: id, before, after: input });
  res.json(presentTag(tag));
});

t.delete('/tags/:id', 'catalogos.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const db = tenantDb();
  const tag = await db.tag.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!tag) throw AppError.notFound('TAG_NOT_FOUND');
  await db.tag.delete({ where: { id } }); // PersonTag se borra en cascada
  await audit({ action: 'tags.delete', entity: 'Tag', entityId: id, before: tag });
  res.status(204).end();
});
