import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { paged, toSkipTake } from '../../core/http/pagination.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import {
  CreateHouseholdSchema,
  HOUSEHOLD_SENSITIVE_FIELDS,
  HouseholdMemberSchema,
  HouseholdSchema,
  IdParam,
  ListHouseholdsQuery,
} from './people.schemas.js';
import { isoDate } from './people.service.js';
import { canOnPerson, peopleWhereFor, viewerOf, type Viewer } from './people.scope.js';

const t = tenantRouter();
export const householdsRouter = t.router;

const MemberParam = IdParam.extend({ personId: z.coerce.number().int().positive() });

/**
 * Un hogar es visible si tiene algún integrante visible (con alcance total, todos). Así un líder con
 * alcance "propio" no ve el padrón completo de familias.
 */
function householdWhere(
  viewer: Viewer,
  key: 'personas.ver' | 'personas.editar',
): Prisma.HouseholdWhereInput | null {
  const people = peopleWhereFor(viewer, key);
  if (!people) return null;
  if (Object.keys(people).length === 0) return {};
  return { members: { some: { AND: [{ deletedAt: null }, people] } } };
}

async function findHousehold(
  viewer: Viewer,
  id: number,
  key: 'personas.ver' | 'personas.editar' = 'personas.ver',
) {
  const scope = householdWhere(viewer, key);
  const household = scope ? await tenantDb().household.findFirst({ where: { AND: [{ id }, scope] } }) : null;
  if (!household) {
    // Recién creado y sin integrantes: solo lo encuentra quien tiene alcance total.
    throw key === 'personas.editar' && (await findVisible(viewer, id))
      ? AppError.forbidden('HOUSEHOLD_EDIT_FORBIDDEN')
      : AppError.notFound('HOUSEHOLD_NOT_FOUND');
  }
  return household;
}

async function findVisible(viewer: Viewer, id: number) {
  const scope = householdWhere(viewer, 'personas.ver');
  return scope ? tenantDb().household.findFirst({ where: { AND: [{ id }, scope] } }) : null;
}

/** Datos de dirección del hogar: solo con ver_sensibles sobre algún integrante (o alcance total). */
async function canSeeAddress(viewer: Viewer, householdId: number): Promise<boolean> {
  const where = peopleWhereFor(viewer, 'personas.ver_sensibles');
  if (!where) return false;
  if (Object.keys(where).length === 0) return true;
  const count = await tenantDb().person.count({ where: { AND: [{ householdId, deletedAt: null }, where] } });
  return count > 0;
}

async function presentHousehold(viewer: Viewer, id: number) {
  const household = await findHousehold(viewer, id);
  const scope = peopleWhereFor(viewer, 'personas.ver') ?? { id: -1 };
  const members = await tenantDb().person.findMany({
    where: { AND: [{ householdId: id, deletedAt: null }, scope] },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      householdRole: true,
      birthDate: true,
      photoFileId: true,
      phone: true,
      email: true,
    },
    orderBy: [{ birthDate: 'asc' }, { firstName: 'asc' }],
  });
  const showAddress = await canSeeAddress(viewer, id);
  const { address, postalCode, lat, lng, accountId: _a, ...rest } = household;
  return {
    ...rest,
    ...(showAddress
      ? {
          address,
          postalCode,
          lat: lat === null ? null : Number(lat),
          lng: lng === null ? null : Number(lng),
        }
      : {}),
    members: members.map(({ birthDate, ...m }) => ({ ...m, birthDate: isoDate(birthDate) })),
    access: { sensitive: showAddress },
  };
}

function assertAddressAllowed(input: Record<string, unknown>, allowed: boolean) {
  if (HOUSEHOLD_SENSITIVE_FIELDS.some((f) => input[f] !== undefined) && !allowed) {
    throw AppError.forbidden('SENSITIVE_FIELDS_FORBIDDEN');
  }
}

async function assertMembersEditable(viewer: Viewer, personIds: number[]) {
  for (const personId of new Set(personIds)) {
    if (!(await canOnPerson(viewer, 'personas.ver', personId))) throw AppError.badRequest('PERSON_INVALID');
    if (!(await canOnPerson(viewer, 'personas.editar', personId)))
      throw AppError.forbidden('PERSON_EDIT_FORBIDDEN');
  }
}

t.get('/households', 'personas.ver', async (req, res) => {
  const viewer = await viewerOf(req);
  const query = parse(ListHouseholdsQuery, req.query);
  const scope = householdWhere(viewer, 'personas.ver')!;
  const where: Prisma.HouseholdWhereInput = {
    AND: [scope, ...(query.q ? [{ name: { contains: query.q } }] : [])],
  };
  const db = tenantDb();
  const [rows, total] = await Promise.all([
    db.household.findMany({
      where,
      select: {
        id: true,
        name: true,
        city: true,
        _count: { select: { members: { where: { deletedAt: null } } } },
      },
      orderBy: { name: 'asc' },
      ...toSkipTake(query),
    }),
    db.household.count({ where }),
  ]);
  res.json(
    paged(
      rows.map(({ _count, ...h }) => ({ ...h, memberCount: _count.members })),
      total,
      query,
    ),
  );
});

t.get('/households/:id', 'personas.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await presentHousehold(await viewerOf(req), id));
});

t.post('/households', ['personas.crear', 'personas.editar'], async (req, res) => {
  const viewer = await viewerOf(req);
  const { members, ...input } = parse(CreateHouseholdSchema, req.body);
  assertAddressAllowed(input, Boolean(viewer.permissions['personas.ver_sensibles']));
  // Con alcance "propio" un hogar vacío le quedaría invisible: tiene que nacer con alguien suyo.
  if (members.length === 0 && viewer.permissions['personas.ver'] !== 'all') {
    throw AppError.badRequest('HOUSEHOLD_MEMBERS_REQUIRED');
  }
  await assertMembersEditable(
    viewer,
    members.map((m) => m.personId),
  );
  const db = tenantDb();
  const household = await db.$transaction(async (tx) => {
    const created = await tx.household.create({ data: { ...input, accountId: currentAccountId() } });
    for (const m of members) {
      await tx.person.update({
        where: { id: m.personId },
        data: { householdId: created.id, householdRole: m.role },
      });
    }
    return created;
  });
  await audit({
    action: 'households.create',
    entity: 'Household',
    entityId: household.id,
    after: { name: input.name, members: members.map((m) => m.personId) },
  });
  res.status(201).json(await presentHousehold(viewer, household.id));
});

t.patch('/households/:id', 'personas.editar', async (req, res) => {
  const viewer = await viewerOf(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(HouseholdSchema, req.body);
  const before = await findHousehold(viewer, id, 'personas.editar');
  assertAddressAllowed(input, await canSeeAddress(viewer, id));
  await tenantDb().household.update({ where: { id }, data: input });
  await audit({
    action: 'households.update',
    entity: 'Household',
    entityId: id,
    before: { name: before.name },
    after: { changed: Object.keys(input), name: input.name },
  });
  res.json(await presentHousehold(viewer, id));
});

t.delete('/households/:id', 'personas.editar', async (req: Request, res) => {
  const viewer = await viewerOf(req);
  const { id } = parse(IdParam, req.params);
  const household = await findHousehold(viewer, id, 'personas.editar');
  const db = tenantDb();
  // Solo se puede disolver si puede editar a todos sus integrantes.
  const memberIds = (await db.person.findMany({ where: { householdId: id }, select: { id: true } })).map(
    (p) => p.id,
  );
  const living = await db.person.findMany({
    where: { householdId: id, deletedAt: null },
    select: { id: true },
  });
  await assertMembersEditable(
    viewer,
    living.map((p) => p.id),
  );
  await db.$transaction([
    db.person.updateMany({
      where: { id: { in: memberIds } },
      data: { householdId: null, householdRole: null },
    }),
    db.household.delete({ where: { id } }),
  ]);
  await audit({
    action: 'households.delete',
    entity: 'Household',
    entityId: id,
    before: { name: household.name },
  });
  res.status(204).end();
});

t.post('/households/:id/members', 'personas.editar', async (req, res) => {
  const viewer = await viewerOf(req);
  const { id } = parse(IdParam, req.params);
  const { personId, role } = parse(HouseholdMemberSchema, req.body);
  // Sumar a alguien a un hogar requiere poder editar a esa persona; el hogar alcanza con verlo.
  if (!(await tenantDb().household.count({ where: { id } }))) throw AppError.notFound('HOUSEHOLD_NOT_FOUND');
  await assertMembersEditable(viewer, [personId]);
  await tenantDb().person.update({ where: { id: personId }, data: { householdId: id, householdRole: role } });
  await audit({
    action: 'households.member.add',
    entity: 'Household',
    entityId: id,
    after: { personId, role },
  });
  res.status(201).json(await presentHousehold(viewer, id));
});

t.delete('/households/:id/members/:personId', 'personas.editar', async (req, res) => {
  const viewer = await viewerOf(req);
  const { id, personId } = parse(MemberParam, req.params);
  await findHousehold(viewer, id);
  await assertMembersEditable(viewer, [personId]);
  const { count } = await tenantDb().person.updateMany({
    where: { id: personId, householdId: id },
    data: { householdId: null, householdRole: null },
  });
  if (count === 0) throw AppError.notFound('PERSON_NOT_FOUND');
  await audit({ action: 'households.member.remove', entity: 'Household', entityId: id, after: { personId } });
  // Sin cuerpo: con alcance "propio" puede que ya no vea el hogar después de sacar a su integrante.
  res.status(204).end();
});
