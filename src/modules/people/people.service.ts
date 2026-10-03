import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { deleteFile } from '../../core/files/files.service.js';
import { AppError } from '../../core/http/errors.js';
import { paged, toSkipTake } from '../../core/http/pagination.js';
import {
  CONSENT_VERSION,
  SENSITIVE_FIELDS,
  type ChangeStatusSchema,
  type CreatePersonSchema,
  type DuplicatesQuery,
  type ListPeopleQuery,
  type MilestoneSchema,
  type PositionSchema,
  type UpdatePersonSchema,
} from './people.schemas.js';
import { canOnPerson, peopleWhereFor, scopeOf, type Viewer } from './people.scope.js';

// ───────────── Normalización y presentación ─────────────

/** "+54 9 (11) 5555-1234" → "+5491155551234". Sin libphonenumber: solo saca separadores. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone
    .trim()
    .replace(/[^\d+]/g, '')
    .replace(/(?!^)\+/g, '');
  return cleaned.replace(/\D/g, '').length >= 6 ? cleaned : phone.trim();
}

/** DNI "30.123.456" → "30123456". */
export function normalizeDocument(doc: string | null | undefined): string | null {
  if (!doc) return null;
  return doc.replace(/[\s.-]/g, '').toUpperCase() || null;
}

/** "Pérez Núñez" → "perez nunez": minúsculas y sin diacríticos, para buscar y comparar nombres. */
export function fold(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

type SearchFields = {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
  email?: string | null;
};

/** Valor de Person.searchText. */
export const searchTextOf = (p: SearchFields) =>
  fold([p.firstName, p.lastName, p.preferredName, p.email].filter(Boolean).join(' ')).slice(0, 450);

export const isoDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const num = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d));

export const catalogRef = { id: true, systemKey: true, name: true, color: true } as const;

const listSelect = {
  id: true,
  firstName: true,
  lastName: true,
  preferredName: true,
  photoFileId: true,
  gender: true,
  birthDate: true,
  email: true,
  phone: true,
  createdAt: true,
  status: { select: catalogRef },
  campus: { select: { id: true, name: true } },
  household: { select: { id: true, name: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
} as const;

type ListRow = Prisma.PersonGetPayload<{ select: typeof listSelect }>;

const presentListItem = ({ tags, birthDate, ...p }: ListRow) => ({
  ...p,
  birthDate: isoDate(birthDate),
  tags: tags.map((t) => t.tag),
});

const detailSelect = {
  ...listSelect,
  householdRole: true,
  documentNumber: true,
  maritalStatus: true,
  address: true,
  city: true,
  province: true,
  lat: true,
  lng: true,
  source: true,
  firstVisitAt: true,
  consentAt: true,
  consentVersion: true,
  notes: true,
  pastoralNotes: true,
  createdById: true,
  updatedAt: true,
  milestones: {
    select: { id: true, date: true, notes: true, milestoneType: { select: catalogRef } },
    orderBy: { date: 'asc' },
  },
  positions: {
    select: { id: true, since: true, until: true, position: { select: catalogRef } },
    orderBy: { since: 'asc' },
  },
  users: { select: { id: true, email: true, isActive: true }, where: { deletedAt: null } },
} as const;

type DetailRow = Prisma.PersonGetPayload<{ select: typeof detailSelect }>;

// ───────────── Validaciones comunes ─────────────

/** Toda FK que viene del cliente se verifica dentro de la cuenta (la extensión tenant no mira FKs). */
async function assertRefs(input: {
  campusId?: number | null;
  householdId?: number | null;
  tagIds?: number[];
}) {
  const db = tenantDb();
  if (input.campusId && !(await db.campus.count({ where: { id: input.campusId } }))) {
    throw AppError.badRequest('CAMPUS_INVALID');
  }
  if (input.householdId && !(await db.household.count({ where: { id: input.householdId } }))) {
    throw AppError.badRequest('HOUSEHOLD_INVALID');
  }
  if (input.tagIds?.length) {
    const unique = [...new Set(input.tagIds)];
    if ((await db.tag.count({ where: { id: { in: unique } } })) !== unique.length) {
      throw AppError.badRequest('TAG_INVALID');
    }
  }
}

async function activeCatalogItem(type: string, id: number, code: string) {
  const item = await tenantDb().catalogItem.findFirst({ where: { id, type, isActive: true } });
  if (!item) throw AppError.badRequest(code);
  return item;
}

/** Estado inicial de una persona nueva: "visitante" si está activo, si no el primero activo. */
export async function defaultStatusId(preferred = 'visitor'): Promise<number> {
  const db = tenantDb();
  const item =
    (await db.catalogItem.findFirst({
      where: { type: 'person_status', systemKey: preferred, isActive: true },
    })) ??
    (await db.catalogItem.findFirst({
      where: { type: 'person_status', isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    }));
  if (!item) throw AppError.conflict('CATALOG_LAST_ACTIVE_STATUS');
  return item.id;
}

const touchesSensitive = (input: Record<string, unknown>) =>
  SENSITIVE_FIELDS.some((f) => input[f] !== undefined);

/** Persona viva visible para el permiso; 404 si no existe o no está en su alcance. */
async function visiblePerson(viewer: Viewer, id: number, key: 'personas.ver' = 'personas.ver') {
  if (!(await canOnPerson(viewer, key, id))) throw AppError.notFound('PERSON_NOT_FOUND');
}

/** Para escribir: 404 si no la ve, 403 si la ve pero no la puede editar. */
async function editablePerson(viewer: Viewer, id: number) {
  await visiblePerson(viewer, id);
  if (!(await canOnPerson(viewer, 'personas.editar', id))) throw AppError.forbidden('PERSON_EDIT_FORBIDDEN');
}

// ───────────── Listado y ficha ─────────────

export type PeopleFilters = Omit<z.infer<typeof ListPeopleQuery>, 'page' | 'pageSize'>;

/** Filtro del listado (también lo usa la exportación): alcance del usuario + filtros + búsqueda. */
export function peopleListWhere(viewer: Viewer, query: PeopleFilters): Prisma.PersonWhereInput {
  const scope = peopleWhereFor(viewer, 'personas.ver');
  if (!scope) throw AppError.forbidden('PERMISSION_DENIED');

  const and: Prisma.PersonWhereInput[] = [{ deletedAt: null }, scope];
  if (query.statusId) and.push({ statusId: { in: query.statusId } });
  if (query.campusId) and.push({ campusId: query.campusId });
  if (query.householdId) and.push({ householdId: query.householdId });
  if (query.gender) and.push({ gender: query.gender });
  if (query.tagId) and.push({ tags: { some: { tagId: query.tagId } } });
  // Cada palabra tiene que aparecer: "juan per" encuentra a Juan Pérez (sin importar acentos).
  for (const token of (query.q ?? '').split(/\s+/).filter(Boolean).slice(0, 5)) {
    const digits = token.replace(/\D/g, '');
    and.push({
      OR: [
        { searchText: { contains: fold(token) } },
        ...(digits.length >= 3
          ? [{ phone: { contains: digits } }, { documentNumber: { contains: digits } }]
          : []),
      ],
    });
  }
  return { AND: and };
}

export const peopleOrderBy = (sort: PeopleFilters['sort']): Prisma.PersonOrderByWithRelationInput[] =>
  sort === 'recent'
    ? [{ createdAt: 'desc' }, { id: 'desc' }]
    : [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }];

export async function listPeople(viewer: Viewer, query: z.infer<typeof ListPeopleQuery>) {
  const where = peopleListWhere(viewer, query);
  const orderBy = peopleOrderBy(query.sort);
  const db = tenantDb();
  const [rows, total] = await Promise.all([
    db.person.findMany({ where, select: listSelect, orderBy, ...toSkipTake(query) }),
    db.person.count({ where }),
  ]);
  return paged(rows.map(presentListItem), total, query);
}

async function householdMembers(viewer: Viewer, householdId: number, excludeId?: number) {
  const scope = peopleWhereFor(viewer, 'personas.ver') ?? { id: -1 };
  const rows = await tenantDb().person.findMany({
    where: {
      AND: [{ householdId, deletedAt: null }, scope, ...(excludeId ? [{ id: { not: excludeId } }] : [])],
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      householdRole: true,
      birthDate: true,
      photoFileId: true,
    },
    orderBy: [{ birthDate: 'asc' }, { firstName: 'asc' }],
  });
  return rows.map(({ birthDate, ...m }) => ({ ...m, birthDate: isoDate(birthDate) }));
}

/**
 * Ficha completa. `auditView`: registrar que se consultaron datos sensibles (solo al abrir la ficha,
 * no en la respuesta de una edición que el mismo usuario acaba de hacer).
 */
export async function getPerson(viewer: Viewer, id: number, options: { auditView?: boolean } = {}) {
  await visiblePerson(viewer, id);
  const row: DetailRow | null = await tenantDb().person.findFirst({
    where: { id, deletedAt: null },
    select: detailSelect,
  });
  if (!row) throw AppError.notFound('PERSON_NOT_FOUND');

  const [canEdit, canSensitive] = await Promise.all([
    canOnPerson(viewer, 'personas.editar', id),
    canOnPerson(viewer, 'personas.ver_sensibles', id),
  ]);
  const {
    tags,
    milestones,
    positions,
    users,
    household,
    birthDate,
    firstVisitAt,
    documentNumber,
    maritalStatus,
    address,
    lat,
    lng,
    pastoralNotes,
    ...rest
  } = row;

  if (canSensitive && options.auditView) {
    await audit({ action: 'people.sensitive.view', entity: 'Person', entityId: id });
  }

  return {
    ...rest,
    birthDate: isoDate(birthDate),
    firstVisitAt: isoDate(firstVisitAt),
    tags: tags.map((t) => t.tag),
    household: household ? { ...household, members: await householdMembers(viewer, household.id, id) } : null,
    milestones: milestones.map((m) => ({
      id: m.id,
      type: m.milestoneType,
      date: isoDate(m.date),
      notes: m.notes,
    })),
    positions: positions.map((p) => ({
      id: p.id,
      position: p.position,
      since: isoDate(p.since),
      until: isoDate(p.until),
    })),
    // Solo quien administra usuarios ve con qué usuario está vinculada la ficha.
    user: scopeOf(viewer, 'usuarios.ver') ? (users[0] ?? null) : undefined,
    ...(canSensitive
      ? { documentNumber, maritalStatus, address, lat: num(lat), lng: num(lng), pastoralNotes }
      : {}),
    access: {
      edit: canEdit,
      sensitive: canSensitive,
      delete: Boolean(scopeOf(viewer, 'personas.eliminar')),
      merge: Boolean(scopeOf(viewer, 'personas.fusionar')),
    },
  };
}

// ───────────── Duplicados ─────────────

type DuplicateCriteria = z.infer<typeof DuplicatesQuery>;
export type DuplicateReason = 'email' | 'phone' | 'document' | 'name' | 'name_birthdate';

/**
 * Posibles duplicados dentro de la cuenta. "Fuerte" = mismo email/teléfono/documento o mismo nombre y
 * fecha de nacimiento. Solo se devuelven los que el usuario puede ver; del resto, la cantidad.
 */
export async function findDuplicates(viewer: Viewer, criteria: DuplicateCriteria) {
  const email = criteria.email?.trim().toLowerCase() || null;
  const phone = normalizePhone(criteria.phone);
  const document = normalizeDocument(criteria.documentNumber);
  const first = fold(criteria.firstName);
  const last = fold(criteria.lastName);

  const or: Prisma.PersonWhereInput[] = [];
  if (email) or.push({ email });
  if (phone) or.push({ phone });
  if (document) or.push({ documentNumber: document });
  // Prefiltro por searchText; la igualdad exacta de nombre y apellido se verifica abajo.
  if (first && last) {
    or.push({ AND: [{ searchText: { contains: first } }, { searchText: { contains: last } }] });
  }
  if (or.length === 0) return { items: [], hiddenCount: 0, strong: false };

  const rows = await tenantDb().person.findMany({
    where: {
      deletedAt: null,
      OR: or,
      ...(criteria.excludeId ? { id: { not: criteria.excludeId } } : {}),
    },
    select: {
      ...listSelect,
      documentNumber: true,
      createdById: true,
    },
    take: 50,
  });

  const candidates = rows
    .map((r) => {
      const reasons: DuplicateReason[] = [];
      if (email && r.email?.toLowerCase() === email) reasons.push('email');
      if (phone && r.phone === phone) reasons.push('phone');
      if (document && r.documentNumber === document) reasons.push('document');
      if (first && last && fold(r.firstName) === first && fold(r.lastName) === last) {
        reasons.push(
          criteria.birthDate && isoDate(r.birthDate) === criteria.birthDate ? 'name_birthdate' : 'name',
        );
      }
      const strong = reasons.some((x) => x !== 'name');
      return { row: r, reasons, strong, score: reasons.length + (strong ? 10 : 0) };
    })
    .filter((c) => c.reasons.length > 0)
    .sort((a, b) => b.score - a.score);

  const scope = peopleWhereFor(viewer, 'personas.ver');
  let visibleIds = new Set<number>();
  if (scope) {
    const ids = candidates.map((c) => c.row.id);
    const visible = await tenantDb().person.findMany({
      where: { AND: [{ id: { in: ids } }, scope] },
      select: { id: true },
    });
    visibleIds = new Set(visible.map((v) => v.id));
  }

  const items = candidates
    .filter((c) => visibleIds.has(c.row.id))
    .slice(0, 10)
    .map(({ row, reasons, strong }) => {
      const { documentNumber: _doc, createdById: _by, ...person } = row;
      return { ...presentListItem(person), reasons, strong };
    });
  return {
    items,
    hiddenCount: candidates.length - candidates.filter((c) => visibleIds.has(c.row.id)).length,
    strong: candidates.some((c) => c.strong),
  };
}

// ───────────── Alta / edición / baja ─────────────

type CreateInput = z.infer<typeof CreatePersonSchema>;
type UpdateInput = z.infer<typeof UpdatePersonSchema>;

function normalizeContact<T extends { phone?: string | null; documentNumber?: string | null }>(input: T): T {
  return {
    ...input,
    ...(input.phone !== undefined ? { phone: normalizePhone(input.phone) } : {}),
    ...(input.documentNumber !== undefined
      ? { documentNumber: normalizeDocument(input.documentNumber) }
      : {}),
  };
}

export async function createPerson(
  viewer: Viewer,
  raw: CreateInput,
  options: Parameters<typeof insertPerson>[2] = {},
) {
  return getPerson(viewer, await insertPerson(viewer, raw, options));
}

/** Alta sin devolver la ficha (quien acepta un formulario puede no tener personas.ver). */
export async function insertPerson(
  viewer: Viewer,
  raw: CreateInput,
  options: {
    source?: 'manual' | 'form' | 'import' | 'cell';
    /**
     * Datos que cargó la propia persona (formulario "Soy nuevo"): se guardan aunque quien acepta no
     * tenga ver_sensibles, con el consentimiento que dio ella.
     */
    selfReported?: { consentAt: Date; consentVersion: string };
  } = {},
) {
  // Con alcance "propio" alcanza: la persona nueva queda cargada por él y entra en su alcance.
  if (!options.selfReported && touchesSensitive(raw) && !scopeOf(viewer, 'personas.ver_sensibles')) {
    throw AppError.forbidden('SENSITIVE_FIELDS_FORBIDDEN');
  }
  const { statusId: requestedStatus, tagIds, consent, allowDuplicate, ...fields } = normalizeContact(raw);
  await assertRefs({ campusId: fields.campusId, householdId: fields.householdId, tagIds });
  const statusId = requestedStatus
    ? (await activeCatalogItem('person_status', requestedStatus, 'STATUS_INVALID')).id
    : await defaultStatusId();

  if (!allowDuplicate) {
    const dup = await findDuplicates(viewer, {
      firstName: fields.firstName,
      lastName: fields.lastName,
      email: fields.email ?? undefined,
      phone: fields.phone ?? undefined,
      documentNumber: fields.documentNumber ?? undefined,
      birthDate: isoDate(fields.birthDate) ?? undefined,
    });
    if (dup.strong) throw AppError.conflict('PERSON_DUPLICATE_SUSPECTED', dup);
  }

  const db = tenantDb();
  const accountId = currentAccountId();
  const person = await db.$transaction(async (tx) => {
    const created = await tx.person.create({
      data: {
        ...fields,
        searchText: searchTextOf(fields),
        householdRole: fields.householdId ? (fields.householdRole ?? null) : null,
        accountId,
        statusId,
        source: options.source ?? 'manual',
        createdById: viewer.userId,
        ...(consent ? { consentAt: new Date(), consentVersion: CONSENT_VERSION } : {}),
        ...(options.selfReported ?? {}),
        // Escritura anidada: el chequeo de padres de personTag.createMany consulta fuera de la
        // transacción y no vería a la persona recién creada. Las etiquetas ya se validaron arriba.
        ...(tagIds?.length ? { tags: { create: [...new Set(tagIds)].map((tagId) => ({ tagId })) } } : {}),
      },
      select: { id: true },
    });
    await tx.personStatusHistory.create({
      data: { accountId, personId: created.id, toStatusId: statusId, changedById: viewer.userId },
    });
    return created;
  });

  await audit({
    action: 'people.create',
    entity: 'Person',
    entityId: person.id,
    after: { firstName: fields.firstName, lastName: fields.lastName, source: options.source ?? 'manual' },
  });
  return person.id;
}

export async function updatePerson(viewer: Viewer, id: number, raw: UpdateInput) {
  await editablePerson(viewer, id);
  if (touchesSensitive(raw) && !(await canOnPerson(viewer, 'personas.ver_sensibles', id))) {
    throw AppError.forbidden('SENSITIVE_FIELDS_FORBIDDEN');
  }
  const { consent, ...fields } = normalizeContact(raw);
  await assertRefs({ campusId: fields.campusId, householdId: fields.householdId });

  const db = tenantDb();
  const before = await db.person.findUniqueOrThrow({ where: { id } });
  const data: Prisma.PersonUncheckedUpdateInput = { ...fields };
  if (fields.householdId === null) data.householdRole = null;
  if (consent === true && !before.consentAt) {
    data.consentAt = new Date();
    data.consentVersion = CONSENT_VERSION;
  }
  if (consent === false) {
    data.consentAt = null;
    data.consentVersion = null;
  }
  await db.person.update({
    where: { id },
    data: { ...data, searchText: searchTextOf({ ...before, ...fields }) },
  });

  // Solo se auditan los campos que cambiaron; los sensibles, sin su valor.
  const changed = Object.keys(data).filter(
    (k) =>
      String(before[k as keyof typeof before] ?? '') !== String((data as Record<string, unknown>)[k] ?? ''),
  );
  if (changed.length) {
    await audit({
      action: 'people.update',
      entity: 'Person',
      entityId: id,
      after: {
        changed,
        values: Object.fromEntries(
          changed
            .filter((k) => !(SENSITIVE_FIELDS as readonly string[]).includes(k))
            .map((k) => [k, (data as Record<string, unknown>)[k]]),
        ),
      },
    });
  }
  return getPerson(viewer, id);
}

export async function deletePerson(viewer: Viewer, id: number) {
  await visiblePerson(viewer, id);
  const db = tenantDb();
  // Quien lidera una célula abierta no se puede dar de baja: primero hay que reemplazarlo.
  const leads = await db.cell.count({
    where: { leaderPersonId: id, status: { in: ['active', 'paused'] } },
  });
  if (leads > 0) throw AppError.conflict('PERSON_LEADS_CELL');
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  await db.$transaction([
    db.person.update({ where: { id }, data: { deletedAt: new Date() } }),
    db.user.updateMany({ where: { personId: id }, data: { personId: null } }),
    db.cellMember.updateMany({ where: { personId: id, leftAt: null }, data: { leftAt: today } }),
    db.consolidationCase.updateMany({
      where: { personId: id, status: 'open' },
      data: { status: 'dropped', closeReason: 'person_deleted', closedAt: today },
    }),
  ]);
  await audit({ action: 'people.delete', entity: 'Person', entityId: id });
}

// ───────────── Estado, hitos, cargos, etiquetas ─────────────

export async function changeStatus(viewer: Viewer, id: number, input: z.infer<typeof ChangeStatusSchema>) {
  await editablePerson(viewer, id);
  const status = await activeCatalogItem('person_status', input.statusId, 'STATUS_INVALID');
  const db = tenantDb();
  const person = await db.person.findUniqueOrThrow({ where: { id }, select: { statusId: true } });
  if (person.statusId !== status.id) {
    await db.$transaction([
      db.person.update({ where: { id }, data: { statusId: status.id } }),
      db.personStatusHistory.create({
        data: {
          accountId: currentAccountId(),
          personId: id,
          fromStatusId: person.statusId,
          toStatusId: status.id,
          changedById: viewer.userId,
          note: input.note ?? null,
        },
      }),
    ]);
    await audit({
      action: 'people.status.change',
      entity: 'Person',
      entityId: id,
      before: { statusId: person.statusId },
      after: { statusId: status.id, note: input.note ?? null },
    });
  }
  return getPerson(viewer, id);
}

export async function addMilestone(viewer: Viewer, id: number, input: z.infer<typeof MilestoneSchema>) {
  await editablePerson(viewer, id);
  await activeCatalogItem('milestone', input.milestoneTypeId, 'MILESTONE_INVALID');
  const milestone = await tenantDb().personMilestone.create({
    data: { accountId: currentAccountId(), personId: id, ...input, notes: input.notes ?? null },
  });
  await audit({ action: 'people.milestone.add', entity: 'Person', entityId: id, after: milestone });
  return getPerson(viewer, id);
}

export async function updateMilestone(
  viewer: Viewer,
  id: number,
  milestoneId: number,
  input: Partial<z.infer<typeof MilestoneSchema>>,
) {
  await editablePerson(viewer, id);
  const db = tenantDb();
  const before = await db.personMilestone.findFirst({ where: { id: milestoneId, personId: id } });
  if (!before) throw AppError.notFound('MILESTONE_NOT_FOUND');
  if (input.milestoneTypeId) await activeCatalogItem('milestone', input.milestoneTypeId, 'MILESTONE_INVALID');
  const after = await db.personMilestone.update({ where: { id: milestoneId }, data: input });
  await audit({ action: 'people.milestone.update', entity: 'Person', entityId: id, before, after });
  return getPerson(viewer, id);
}

export async function removeMilestone(viewer: Viewer, id: number, milestoneId: number) {
  await editablePerson(viewer, id);
  const db = tenantDb();
  const before = await db.personMilestone.findFirst({ where: { id: milestoneId, personId: id } });
  if (!before) throw AppError.notFound('MILESTONE_NOT_FOUND');
  await db.personMilestone.delete({ where: { id: milestoneId } });
  await audit({ action: 'people.milestone.remove', entity: 'Person', entityId: id, before });
  return getPerson(viewer, id);
}

type PositionInput = z.infer<typeof PositionSchema>;

export async function addPosition(viewer: Viewer, id: number, input: PositionInput) {
  await editablePerson(viewer, id);
  await activeCatalogItem('position', input.positionId, 'POSITION_INVALID');
  const position = await tenantDb().personPosition.create({
    data: {
      accountId: currentAccountId(),
      personId: id,
      positionId: input.positionId,
      since: input.since ?? null,
      until: input.until ?? null,
    },
  });
  await audit({ action: 'people.position.add', entity: 'Person', entityId: id, after: position });
  return getPerson(viewer, id);
}

export async function updatePosition(
  viewer: Viewer,
  id: number,
  positionRowId: number,
  input: { since?: Date | null; until?: Date | null },
) {
  await editablePerson(viewer, id);
  const db = tenantDb();
  const before = await db.personPosition.findFirst({ where: { id: positionRowId, personId: id } });
  if (!before) throw AppError.notFound('POSITION_NOT_FOUND');
  const since = input.since === undefined ? before.since : input.since;
  const until = input.until === undefined ? before.until : input.until;
  if (since && until && since > until) throw AppError.badRequest('DATE_RANGE_INVALID');
  const after = await db.personPosition.update({ where: { id: positionRowId }, data: { since, until } });
  await audit({ action: 'people.position.update', entity: 'Person', entityId: id, before, after });
  return getPerson(viewer, id);
}

export async function removePosition(viewer: Viewer, id: number, positionRowId: number) {
  await editablePerson(viewer, id);
  const db = tenantDb();
  const before = await db.personPosition.findFirst({ where: { id: positionRowId, personId: id } });
  if (!before) throw AppError.notFound('POSITION_NOT_FOUND');
  await db.personPosition.delete({ where: { id: positionRowId } });
  await audit({ action: 'people.position.remove', entity: 'Person', entityId: id, before });
  return getPerson(viewer, id);
}

export async function setTags(viewer: Viewer, id: number, tagIds: number[]) {
  await editablePerson(viewer, id);
  const unique = [...new Set(tagIds)];
  await assertRefs({ tagIds: unique });
  const db = tenantDb();
  const before = await db.personTag.findMany({ where: { personId: id }, select: { tagId: true } });
  await db.$transaction([
    db.personTag.deleteMany({ where: { personId: id } }),
    db.personTag.createMany({ data: unique.map((tagId) => ({ personId: id, tagId })) }),
  ]);
  await audit({
    action: 'people.tags.set',
    entity: 'Person',
    entityId: id,
    before: before.map((t) => t.tagId),
    after: unique,
  });
  return getPerson(viewer, id);
}

// ───────────── Historial ─────────────

export async function timeline(viewer: Viewer, id: number) {
  await visiblePerson(viewer, id);
  const db = tenantDb();
  const [person, history, milestones, positions] = await Promise.all([
    db.person.findUniqueOrThrow({
      where: { id },
      select: { createdAt: true, source: true, createdById: true },
    }),
    db.personStatusHistory.findMany({
      where: { personId: id },
      select: {
        id: true,
        changedAt: true,
        changedById: true,
        note: true,
        fromStatus: { select: catalogRef },
        toStatus: { select: catalogRef },
      },
    }),
    db.personMilestone.findMany({
      where: { personId: id },
      select: { id: true, date: true, notes: true, milestoneType: { select: catalogRef } },
    }),
    db.personPosition.findMany({
      where: { personId: id },
      select: { id: true, since: true, until: true, position: { select: catalogRef } },
    }),
  ]);

  const userIds = [
    ...new Set(
      [person.createdById, ...history.map((h) => h.changedById)].filter((v): v is number => v !== null),
    ),
  ];
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const who = (userId: number | null) => (userId ? (byId.get(userId) ?? null) : null);

  const items = [
    {
      type: 'created' as const,
      at: person.createdAt.toISOString(),
      source: person.source,
      by: who(person.createdById),
    },
    // El primer registro del historial es el estado inicial del alta: ya lo cuenta "created".
    ...history
      .filter((h) => h.fromStatus !== null)
      .map((h) => ({
        type: 'status' as const,
        at: h.changedAt.toISOString(),
        from: h.fromStatus,
        to: h.toStatus,
        note: h.note,
        by: who(h.changedById),
      })),
    ...milestones.map((m) => ({
      type: 'milestone' as const,
      at: isoDate(m.date)!,
      milestone: m.milestoneType,
      notes: m.notes,
    })),
    ...positions.flatMap((p) => [
      ...(p.since ? [{ type: 'position_start' as const, at: isoDate(p.since)!, position: p.position }] : []),
      ...(p.until ? [{ type: 'position_end' as const, at: isoDate(p.until)!, position: p.position }] : []),
    ]),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return { items };
}

// ───────────── Fusión ─────────────

/** Campos que la ficha destino toma de la origen cuando los tiene vacíos. */
const MERGE_FILL_FIELDS = [
  'preferredName',
  'gender',
  'birthDate',
  'documentNumber',
  'maritalStatus',
  'email',
  'phone',
  'address',
  'city',
  'province',
  'lat',
  'lng',
  'photoFileId',
  'campusId',
  'householdId',
  'householdRole',
  'consentAt',
  'consentVersion',
] as const;

/**
 * Fusiona `sourceId` dentro de `intoId`: mueve historial, hitos, cargos, etiquetas y el usuario vinculado,
 * completa los campos vacíos del destino y da de baja la origen (mergedIntoId).
 * Cada módulo que agregue tablas con personId (células, consolidación, finanzas…) debe moverlas acá.
 */
export async function mergePeople(viewer: Viewer, sourceId: number, intoId: number) {
  if (sourceId === intoId) throw AppError.badRequest('MERGE_SAME_PERSON');
  await visiblePerson(viewer, sourceId);
  await visiblePerson(viewer, intoId);
  const db = tenantDb();
  const [source, target] = await Promise.all([
    db.person.findUniqueOrThrow({ where: { id: sourceId }, include: { users: true, tags: true } }),
    db.person.findUniqueOrThrow({ where: { id: intoId }, include: { users: true, tags: true } }),
  ]);
  const sourceUser = source.users.find((u) => !u.deletedAt);
  const targetUser = target.users.find((u) => !u.deletedAt);
  if (sourceUser && targetUser) throw AppError.conflict('MERGE_BOTH_LINKED');

  const fill: Record<string, unknown> = {};
  for (const field of MERGE_FILL_FIELDS) {
    if ((target[field] === null || target[field] === undefined) && source[field] !== null)
      fill[field] = source[field];
  }
  if (source.firstVisitAt && (!target.firstVisitAt || source.firstVisitAt < target.firstVisitAt)) {
    fill.firstVisitAt = source.firstVisitAt;
  }
  for (const field of ['notes', 'pastoralNotes'] as const) {
    if (source[field] && target[field] && source[field] !== target[field]) {
      fill[field] = `${target[field]}\n\n${source[field]}`;
    } else if (source[field] && !target[field]) {
      fill[field] = source[field];
    }
  }
  const targetTagIds = new Set(target.tags.map((t) => t.tagId));
  const newTags = source.tags.filter((t) => !targetTagIds.has(t.tagId)).map((t) => t.tagId);

  await db.$transaction(async (tx) => {
    await tx.personStatusHistory.updateMany({ where: { personId: sourceId }, data: { personId: intoId } });
    await tx.personMilestone.updateMany({ where: { personId: sourceId }, data: { personId: intoId } });
    await tx.personPosition.updateMany({ where: { personId: sourceId }, data: { personId: intoId } });
    await tx.newcomerSubmission.updateMany({ where: { personId: sourceId }, data: { personId: intoId } });
    // Células: participación y roles de liderazgo pasan a la ficha que queda. Si las dos
    // participaban en células distintas, se conserva la del destino (una célula activa por persona).
    if (await tx.cellMember.count({ where: { personId: intoId, leftAt: null } })) {
      await tx.cellMember.updateMany({
        where: { personId: sourceId, leftAt: null },
        data: { leftAt: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) },
      });
    }
    await tx.cellMember.updateMany({ where: { personId: sourceId }, data: { personId: intoId } });
    // Asistencia a reportes: si las dos fichas figuran en el mismo reporte, queda una sola fila.
    const targetReports = (
      await tx.cellReportAttendance.findMany({ where: { personId: intoId }, select: { reportId: true } })
    ).map((a) => a.reportId);
    await tx.cellReportAttendance.deleteMany({
      where: { personId: sourceId, reportId: { in: targetReports } },
    });
    await tx.cellReportAttendance.updateMany({ where: { personId: sourceId }, data: { personId: intoId } });
    await tx.cell.updateMany({ where: { leaderPersonId: sourceId }, data: { leaderPersonId: intoId } });
    await tx.cell.updateMany({ where: { coLeaderPersonId: sourceId }, data: { coLeaderPersonId: intoId } });
    await tx.cell.updateMany({ where: { hostPersonId: sourceId }, data: { hostPersonId: intoId } });
    await tx.zone.updateMany({
      where: { supervisorPersonId: sourceId },
      data: { supervisorPersonId: intoId },
    });
    await tx.network.updateMany({ where: { leaderPersonId: sourceId }, data: { leaderPersonId: intoId } });
    // Consolidación: un solo caso abierto por persona; si ambas tenían, el de la origen se cierra.
    if (await tx.consolidationCase.count({ where: { personId: intoId, status: 'open' } })) {
      await tx.consolidationCase.updateMany({
        where: { personId: sourceId, status: 'open' },
        data: {
          status: 'dropped',
          closeReason: 'merged',
          closedAt: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`),
        },
      });
    }
    await tx.consolidationCase.updateMany({ where: { personId: sourceId }, data: { personId: intoId } });
    await tx.followUp.updateMany({ where: { personId: sourceId }, data: { personId: intoId } });
    await tx.inventoryLoan.updateMany({
      where: { borrowerPersonId: sourceId },
      data: { borrowerPersonId: intoId },
    });
    // Discipulado: si las dos estaban activas en el mismo nivel, la de la origen se borra.
    const targetLevels = (
      await tx.courseEnrollment.findMany({
        where: { personId: intoId, status: 'active' },
        select: { levelId: true },
      })
    ).map((e) => e.levelId);
    const duplicated = { personId: sourceId, status: 'active', levelId: { in: targetLevels } };
    await tx.courseAttendance.deleteMany({ where: { enrollment: duplicated } });
    await tx.courseEnrollment.deleteMany({ where: duplicated });
    await tx.courseEnrollment.updateMany({ where: { personId: sourceId }, data: { personId: intoId } });
    await tx.courseLevel.updateMany({
      where: { teacherPersonId: sourceId },
      data: { teacherPersonId: intoId },
    });
    await tx.personTag.deleteMany({ where: { personId: sourceId } });
    if (newTags.length) {
      await tx.personTag.createMany({ data: newTags.map((tagId) => ({ personId: intoId, tagId })) });
    }
    if (sourceUser) await tx.user.update({ where: { id: sourceUser.id }, data: { personId: intoId } });
    if (Object.keys(fill).length) {
      await tx.person.update({
        where: { id: intoId },
        data: {
          ...(fill as Prisma.PersonUncheckedUpdateInput),
          searchText: searchTextOf({ ...target, ...(fill as Partial<typeof target>) }),
        },
      });
    }
    await tx.person.update({
      where: { id: sourceId },
      data: { deletedAt: new Date(), mergedIntoId: intoId, photoFileId: null },
    });
  });
  // Si el destino ya tenía foto, la de la origen queda sin uso: se libera la cuota.
  if (source.photoFileId && fill.photoFileId !== source.photoFileId) await deleteFile(source.photoFileId);

  await audit({
    action: 'people.merge',
    entity: 'Person',
    entityId: intoId,
    before: { sourceId, source: { firstName: source.firstName, lastName: source.lastName } },
    after: { filled: Object.keys(fill), tagsAdded: newTags, userMoved: sourceUser?.id ?? null },
  });
  return getPerson(viewer, intoId);
}
