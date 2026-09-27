import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { ownZoneWhere, scopeOf, viewerOf, type Viewer } from '../people/people.scope.js';

const t = tenantRouter();
export const cellStructureRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const personRef = { select: { id: true, firstName: true, lastName: true, photoFileId: true } } as const;
const color = z
  .string()
  .trim()
  .regex(/^[a-z]+$/)
  .max(20)
  .nullable();

const NetworkInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    color,
    campusId: z.number().int().positive().nullable(),
    leaderPersonId: z.number().int().positive().nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

const ZoneInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    networkId: z.number().int().positive(),
    supervisorPersonId: z.number().int().positive().nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

async function assertPerson(id: number | null | undefined) {
  if (id && !(await tenantDb().person.count({ where: { id, deletedAt: null } }))) {
    throw AppError.badRequest('PERSON_INVALID');
  }
}

async function assertCampus(id: number | null | undefined) {
  if (id && !(await tenantDb().campus.count({ where: { id } }))) throw AppError.badRequest('CAMPUS_INVALID');
}

async function assertNetwork(id: number | undefined) {
  if (id && !(await tenantDb().network.count({ where: { id } })))
    throw AppError.badRequest('NETWORK_INVALID');
}

/** Con alcance "propio" en celulas.ver solo se listan sus redes/zonas (las que lidera o supervisa). */
function networkScope(viewer: Viewer): Prisma.NetworkWhereInput {
  if (scopeOf(viewer, 'celulas.ver') === 'all' || scopeOf(viewer, 'estructura.gestionar')) return {};
  const p = viewer.personId;
  if (!p) return { id: -1 };
  return { OR: [{ leaderPersonId: p }, { zones: { some: { supervisorPersonId: p } } }] };
}

function zoneScope(viewer: Viewer): Prisma.ZoneWhereInput {
  if (scopeOf(viewer, 'celulas.ver') === 'all' || scopeOf(viewer, 'estructura.gestionar')) return {};
  return ownZoneWhere(viewer);
}

// ───────────── Redes ─────────────

t.get('/networks', ['celulas.ver', 'estructura.gestionar'], async (req, res) => {
  const viewer = await viewerOf(req);
  const items = await tenantDb().network.findMany({
    where: networkScope(viewer),
    select: {
      id: true,
      name: true,
      color: true,
      isActive: true,
      campus: { select: { id: true, name: true } },
      leader: personRef,
      _count: { select: { zones: true } },
    },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });
  res.json({ items: items.map(({ _count, ...n }) => ({ ...n, zoneCount: _count.zones })) });
});

t.post('/networks', 'estructura.gestionar', async (req, res) => {
  const input = parse(NetworkInput.required({ name: true }), req.body);
  await Promise.all([assertPerson(input.leaderPersonId), assertCampus(input.campusId)]);
  const network = await tenantDb().network.create({ data: { ...input, accountId: currentAccountId() } });
  await audit({ action: 'cells.network.create', entity: 'Network', entityId: network.id, after: input });
  res.status(201).json(network);
});

t.patch('/networks/:id', 'estructura.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(NetworkInput, req.body);
  const db = tenantDb();
  const before = await db.network.findUnique({ where: { id } });
  if (!before) throw AppError.notFound('NETWORK_NOT_FOUND');
  await Promise.all([assertPerson(input.leaderPersonId), assertCampus(input.campusId)]);
  const network = await db.network.update({ where: { id }, data: input });
  await audit({ action: 'cells.network.update', entity: 'Network', entityId: id, before, after: network });
  res.json(network);
});

t.delete('/networks/:id', 'estructura.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const db = tenantDb();
  const network = await db.network.findUnique({
    where: { id },
    include: { _count: { select: { zones: true } } },
  });
  if (!network) throw AppError.notFound('NETWORK_NOT_FOUND');
  if (network._count.zones > 0) throw AppError.conflict('NETWORK_HAS_ZONES');
  await db.network.delete({ where: { id } });
  await audit({
    action: 'cells.network.delete',
    entity: 'Network',
    entityId: id,
    before: { name: network.name },
  });
  res.status(204).end();
});

// ───────────── Zonas ─────────────

t.get('/zones', ['celulas.ver', 'estructura.gestionar'], async (req, res) => {
  const viewer = await viewerOf(req);
  const { networkId } = parse(
    z.object({ networkId: z.coerce.number().int().positive().optional() }),
    req.query,
  );
  const items = await tenantDb().zone.findMany({
    where: { AND: [zoneScope(viewer), ...(networkId ? [{ networkId }] : [])] },
    select: {
      id: true,
      name: true,
      isActive: true,
      network: { select: { id: true, name: true, color: true } },
      supervisor: personRef,
      _count: { select: { cells: { where: { status: { in: ['active', 'paused'] } } } } },
    },
    orderBy: [{ network: { name: 'asc' } }, { name: 'asc' }],
  });
  res.json({ items: items.map(({ _count, ...z }) => ({ ...z, cellCount: _count.cells })) });
});

t.post('/zones', 'estructura.gestionar', async (req, res) => {
  const input = parse(ZoneInput.required({ name: true, networkId: true }), req.body);
  await Promise.all([assertNetwork(input.networkId), assertPerson(input.supervisorPersonId)]);
  const zone = await tenantDb().zone.create({ data: { ...input, accountId: currentAccountId() } });
  await audit({ action: 'cells.zone.create', entity: 'Zone', entityId: zone.id, after: input });
  res.status(201).json(zone);
});

t.patch('/zones/:id', 'estructura.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(ZoneInput, req.body);
  const db = tenantDb();
  const before = await db.zone.findUnique({ where: { id } });
  if (!before) throw AppError.notFound('ZONE_NOT_FOUND');
  await Promise.all([assertNetwork(input.networkId), assertPerson(input.supervisorPersonId)]);
  const zone = await db.zone.update({ where: { id }, data: input });
  await audit({ action: 'cells.zone.update', entity: 'Zone', entityId: id, before, after: zone });
  res.json(zone);
});

t.delete('/zones/:id', 'estructura.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const db = tenantDb();
  const zone = await db.zone.findUnique({ where: { id }, include: { _count: { select: { cells: true } } } });
  if (!zone) throw AppError.notFound('ZONE_NOT_FOUND');
  if (zone._count.cells > 0) throw AppError.conflict('ZONE_HAS_CELLS');
  await db.zone.delete({ where: { id } });
  await audit({ action: 'cells.zone.delete', entity: 'Zone', entityId: id, before: { name: zone.name } });
  res.status(204).end();
});
