import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { PaginationQuery, paged, toSkipTake } from '../../core/http/pagination.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import type { Locale } from './people.labels.js';
import { IdParam } from './people.schemas.js';
import { findDuplicates, insertPerson, isoDate, searchTextOf } from './people.service.js';
import { canOnPerson, viewerOf, type Viewer } from './people.scope.js';

const t = tenantRouter();
export const newcomersRouter = t.router;

const NOTE_LABELS: Record<'howHeard' | 'wantsVisit' | 'prayer', Record<Locale, string>> = {
  howHeard: { es: 'Cómo nos conoció', en: 'How they heard about us', pt: 'Como nos conheceu' },
  wantsVisit: { es: 'Pidió que lo visiten', en: 'Asked for a visit', pt: 'Pediu uma visita' },
  prayer: {
    es: 'Pedido de oración (formulario)',
    en: 'Prayer request (form)',
    pt: 'Pedido de oração (formulário)',
  },
};

const submissionSelect = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  address: true,
  city: true,
  birthDate: true,
  howHeard: true,
  prayer: true,
  wantsVisit: true,
  consentVersion: true,
  locale: true,
  status: true,
  personId: true,
  reviewedById: true,
  reviewedAt: true,
  createdAt: true,
} as const;

type Submission = Prisma.NewcomerSubmissionGetPayload<{ select: typeof submissionSelect }>;

const present = ({ birthDate, ...s }: Submission) => ({ ...s, birthDate: isoDate(birthDate) });

async function findSubmission(id: number) {
  const s = await tenantDb().newcomerSubmission.findUnique({ where: { id }, select: submissionSelect });
  if (!s) throw AppError.notFound('NEWCOMER_NOT_FOUND');
  return s;
}

async function accountLocale(): Promise<Locale> {
  const { defaultLocale } = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { defaultLocale: true },
  });
  return (['es', 'en', 'pt'].includes(defaultLocale) ? defaultLocale : 'es') as Locale;
}

/** Notas que se agregan a la ficha a partir del formulario (en el idioma de la iglesia). */
function notesFrom(s: Submission, locale: Locale) {
  const lines = [
    ...(s.howHeard ? [`${NOTE_LABELS.howHeard[locale]}: ${s.howHeard}`] : []),
    ...(s.wantsVisit ? [NOTE_LABELS.wantsVisit[locale]] : []),
  ];
  return {
    notes: lines.length ? lines.join('\n') : null,
    // El pedido de oración es información pastoral: va a las notas sensibles.
    pastoralNotes: s.prayer ? `${NOTE_LABELS.prayer[locale]}: ${s.prayer}` : null,
  };
}

const appendText = (current: string | null, extra: string | null) =>
  extra ? (current ? `${current}\n\n${extra}` : extra) : current;

const ListQuery = PaginationQuery.extend({
  status: z.enum(['pending', 'accepted', 'rejected']).default('pending'),
});

t.get('/newcomers', 'personas.nuevos_revisar', async (req, res) => {
  const query = parse(ListQuery, req.query);
  const db = tenantDb();
  const where = { status: query.status };
  const [rows, total, pending] = await Promise.all([
    db.newcomerSubmission.findMany({
      where,
      select: submissionSelect,
      orderBy: { createdAt: query.status === 'pending' ? 'asc' : 'desc' },
      ...toSkipTake(query),
    }),
    db.newcomerSubmission.count({ where }),
    db.newcomerSubmission.count({ where: { status: 'pending' } }),
  ]);
  res.json({ ...paged(rows.map(present), total, query), pendingCount: pending });
});

t.get('/newcomers/:id', 'personas.nuevos_revisar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const s = await findSubmission(id);
  const duplicates =
    s.status === 'pending'
      ? await findDuplicates(await viewerOf(req), {
          firstName: s.firstName,
          lastName: s.lastName,
          email: s.email ?? undefined,
          phone: s.phone ?? undefined,
          birthDate: isoDate(s.birthDate) ?? undefined,
        })
      : null;
  res.json({ ...present(s), duplicates });
});

const AcceptSchema = z
  .object({
    /** Vincular a una ficha existente en vez de crear una nueva. */
    personId: z.number().int().positive().optional(),
    statusId: z.number().int().positive().optional(),
    campusId: z.number().int().positive().nullable().optional(),
    allowDuplicate: z.boolean().default(false),
  })
  .strict();

async function linkToExisting(viewer: Viewer, s: Submission, personId: number, locale: Locale) {
  if (!(await canOnPerson(viewer, 'personas.ver', personId))) throw AppError.badRequest('PERSON_INVALID');
  if (!(await canOnPerson(viewer, 'personas.editar', personId))) {
    throw AppError.forbidden('PERSON_EDIT_FORBIDDEN');
  }
  const db = tenantDb();
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  const extra = notesFrom(s, locale);
  // Solo completa lo que falta: nunca pisa datos cargados por la iglesia.
  const data: Prisma.PersonUncheckedUpdateInput = {
    phone: person.phone ?? s.phone,
    email: person.email ?? s.email,
    address: person.address ?? s.address,
    city: person.city ?? s.city,
    birthDate: person.birthDate ?? s.birthDate,
    firstVisitAt: person.firstVisitAt ?? s.createdAt,
    notes: appendText(person.notes, extra.notes),
    pastoralNotes: appendText(person.pastoralNotes, extra.pastoralNotes),
    ...(person.consentAt ? {} : { consentAt: s.createdAt, consentVersion: s.consentVersion }),
    searchText: searchTextOf({ ...person, email: person.email ?? s.email }),
  };
  await db.person.update({ where: { id: personId }, data });
}

t.post('/newcomers/:id/accept', 'personas.nuevos_revisar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(AcceptSchema, req.body);
  const viewer = await viewerOf(req);
  const s = await findSubmission(id);
  if (s.status !== 'pending') throw AppError.conflict('NEWCOMER_ALREADY_REVIEWED');
  const locale = await accountLocale();

  let personId: number;
  if (input.personId) {
    await linkToExisting(viewer, s, input.personId, locale);
    personId = input.personId;
  } else {
    const extra = notesFrom(s, locale);
    personId = await insertPerson(
      viewer,
      {
        firstName: s.firstName,
        lastName: s.lastName,
        phone: s.phone,
        email: s.email,
        address: s.address,
        city: s.city,
        birthDate: s.birthDate,
        firstVisitAt: new Date(`${s.createdAt.toISOString().slice(0, 10)}T00:00:00Z`),
        campusId: input.campusId ?? null,
        statusId: input.statusId,
        allowDuplicate: input.allowDuplicate,
        ...extra,
      },
      { source: 'form', selfReported: { consentAt: s.createdAt, consentVersion: s.consentVersion } },
    );
  }

  const reviewed = await tenantDb().newcomerSubmission.update({
    where: { id },
    data: { status: 'accepted', personId, reviewedById: viewer.userId, reviewedAt: new Date() },
    select: submissionSelect,
  });
  await audit({
    action: 'newcomers.accept',
    entity: 'NewcomerSubmission',
    entityId: id,
    after: { personId, linked: Boolean(input.personId) },
  });
  res.json(present(reviewed));
});

t.post('/newcomers/:id/reject', 'personas.nuevos_revisar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const viewer = await viewerOf(req);
  const s = await findSubmission(id);
  if (s.status !== 'pending') throw AppError.conflict('NEWCOMER_ALREADY_REVIEWED');
  const reviewed = await tenantDb().newcomerSubmission.update({
    where: { id },
    data: { status: 'rejected', reviewedById: viewer.userId, reviewedAt: new Date() },
    select: submissionSelect,
  });
  await audit({ action: 'newcomers.reject', entity: 'NewcomerSubmission', entityId: id });
  res.json(present(reviewed));
});
