import { z } from 'zod';
import { PaginationQuery } from '../../core/http/pagination.js';

export const IdParam = z.object({ id: z.coerce.number().int().positive() });
export const SubIdParam = IdParam.extend({ subId: z.coerce.number().int().positive() });

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  text(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();

/** Fecha pura "YYYY-MM-DD" → Date a las 00:00 UTC (columnas @db.Date). */
export const dateOnly = z.iso.date().transform((d) => new Date(`${d}T00:00:00Z`));
const pastDate = dateOnly.refine((d) => d.getTime() <= Date.now(), { message: 'DATE_IN_FUTURE' });

export const GENDERS = ['F', 'M'] as const;
export const MARITAL_STATUSES = ['single', 'married', 'widowed', 'divorced', 'separated'] as const;
export const HOUSEHOLD_ROLES = ['head', 'spouse', 'child', 'other'] as const;

/** Versión vigente del texto de consentimiento (Ley 25.326) que acepta la persona. */
export const CONSENT_VERSION = '2026-09';

/** Campos que solo ve/edita quien tiene personas.ver_sensibles. */
export const SENSITIVE_FIELDS = [
  'documentNumber',
  'maritalStatus',
  'address',
  'lat',
  'lng',
  'pastoralNotes',
] as const;

const PersonFields = z.object({
  firstName: text(80).min(1),
  lastName: text(80).min(1),
  preferredName: optionalText(80),
  gender: z.enum(GENDERS).nullable(),
  birthDate: pastDate.nullable(),
  documentNumber: optionalText(20),
  maritalStatus: z.enum(MARITAL_STATUSES).nullable(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => (v === '' ? null : v))
    .pipe(z.email().max(150).nullable())
    .nullable(),
  phone: optionalText(30),
  address: optionalText(250),
  city: optionalText(100),
  province: optionalText(100),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  campusId: z.number().int().positive().nullable(),
  householdId: z.number().int().positive().nullable(),
  householdRole: z.enum(HOUSEHOLD_ROLES).nullable(),
  firstVisitAt: pastDate.nullable(),
  notes: optionalText(4000),
  pastoralNotes: optionalText(8000),
});

export const CreatePersonSchema = PersonFields.partial()
  .required({ firstName: true, lastName: true })
  .extend({
    statusId: z.number().int().positive().optional(),
    tagIds: z.array(z.number().int().positive()).max(50).optional(),
    /** La persona dio su consentimiento para el tratamiento de datos. */
    consent: z.boolean().optional(),
    /** Crear aunque haya posibles duplicados (el usuario ya los revisó). */
    allowDuplicate: z.boolean().default(false),
  })
  .strict();

export const UpdatePersonSchema = PersonFields.partial().extend({ consent: z.boolean().optional() }).strict();

export const ListPeopleQuery = PaginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  statusId: z
    .string()
    .regex(/^\d+(,\d+)*$/)
    .transform((s) => s.split(',').map(Number))
    .optional(),
  campusId: z.coerce.number().int().positive().optional(),
  tagId: z.coerce.number().int().positive().optional(),
  householdId: z.coerce.number().int().positive().optional(),
  gender: z.enum(GENDERS).optional(),
  sort: z.enum(['name', 'recent']).default('name'),
});

export const DuplicatesQuery = z.object({
  firstName: text(80).optional(),
  lastName: text(80).optional(),
  email: text(150).optional(),
  phone: text(30).optional(),
  documentNumber: text(20).optional(),
  birthDate: z.iso.date().optional(),
  excludeId: z.coerce.number().int().positive().optional(),
});

export const ChangeStatusSchema = z
  .object({ statusId: z.number().int().positive(), note: optionalText(300).optional() })
  .strict();

export const MilestoneSchema = z
  .object({
    milestoneTypeId: z.number().int().positive(),
    date: pastDate,
    notes: optionalText(500).optional(),
  })
  .strict();

export const PositionSchema = z
  .object({
    positionId: z.number().int().positive(),
    since: dateOnly.nullable().optional(),
    until: dateOnly.nullable().optional(),
  })
  .strict()
  .refine((p) => !p.since || !p.until || p.since <= p.until, { message: 'DATE_RANGE_INVALID' });

export const SetTagsSchema = z.object({ tagIds: z.array(z.number().int().positive()).max(50) }).strict();

export const MergeSchema = z.object({ intoId: z.number().int().positive() }).strict();

// ───────────── Hogares ─────────────

export const HouseholdSchema = z
  .object({
    name: text(120).min(1),
    address: optionalText(250),
    city: optionalText(100),
    province: optionalText(100),
    postalCode: optionalText(10),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
  })
  .partial()
  .strict();

export const CreateHouseholdSchema = HouseholdSchema.required({ name: true }).extend({
  members: z
    .array(z.object({ personId: z.number().int().positive(), role: z.enum(HOUSEHOLD_ROLES).nullable() }))
    .max(30)
    .default([]),
});

export const HouseholdMemberSchema = z
  .object({ personId: z.number().int().positive(), role: z.enum(HOUSEHOLD_ROLES).nullable() })
  .strict();

export const ListHouseholdsQuery = PaginationQuery.extend({ q: z.string().trim().max(100).optional() });

export const HOUSEHOLD_SENSITIVE_FIELDS = ['address', 'postalCode', 'lat', 'lng'] as const;
