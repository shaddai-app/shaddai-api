import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { readSheet, type CellValue } from '../../core/excel/spreadsheet.js';
import { AppError } from '../../core/http/errors.js';
import {
  GENDER_ALIASES,
  MARITAL_ALIASES,
  PERSON_COLUMNS,
  STATUS_LABELS,
  type PersonColumn,
} from './people.labels.js';
import { defaultStatusId, fold, normalizeDocument, normalizePhone, searchTextOf } from './people.service.js';
import { scopeOf, type Viewer } from './people.scope.js';

export const IMPORT_MAX_ROWS = 5000;
const JOB_TTL_MS = 24 * 3_600_000;
const COMMIT_CHUNK = 50;

export interface ImportIssue {
  field: PersonColumn;
  code: string;
  value?: string;
}

export interface ImportRow {
  row: number;
  data: {
    firstName: string;
    lastName: string;
    preferredName: string | null;
    gender: 'F' | 'M' | null;
    birthDate: string | null;
    email: string | null;
    phone: string | null;
    documentNumber: string | null;
    maritalStatus: string | null;
    address: string | null;
    city: string | null;
    province: string | null;
    statusId: number | null;
    campusId: number | null;
    tags: string[];
    firstVisitAt: string | null;
    notes: string | null;
  };
  errors: ImportIssue[];
  warnings: ImportIssue[];
  duplicate: { id: number; firstName: string; lastName: string; reasons: string[] } | null;
}

export interface ImportSummary {
  total: number;
  valid: number;
  withErrors: number;
  duplicates: number;
  newTags: string[];
  /** Columnas sensibles ignoradas porque el usuario no tiene personas.ver_sensibles. */
  ignoredColumns: string[];
  /** Encabezados que no corresponden a ningún campo. */
  unknownColumns: string[];
  created?: number;
  skipped?: number;
}

const MAX_LENGTH: Partial<Record<PersonColumn, number>> = {
  firstName: 80,
  lastName: 80,
  preferredName: 80,
  email: 150,
  phone: 30,
  documentNumber: 20,
  address: 250,
  city: 100,
  province: 100,
  notes: 4000,
};

// ───────────── Encabezados ─────────────

const headerKey = (h: string) =>
  fold(h)
    .replace(/[_*.:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const HEADER_MAP = new Map<string, PersonColumn>(
  PERSON_COLUMNS.flatMap((c) =>
    [...Object.values(c.header), ...c.aliases, c.key].map((h) => [headerKey(h), c.key] as const),
  ),
);

// ───────────── Valores ─────────────

const text = (v: CellValue): string | null => {
  if (v === null) return null;
  const s = (v instanceof Date ? v.toISOString().slice(0, 10) : v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
};

const ymd = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? date.toISOString().slice(0, 10)
    : null;
};

/**
 * Fechas de planilla: celdas de fecha de Excel, "dd/mm/aaaa" (formato argentino; si el segundo número
 * pasa de 12 se toma como mm/dd), "aaaa-mm-dd" y números de serie de Excel.
 */
export function parseSheetDate(v: CellValue): string | null | 'invalid' {
  if (v === null) return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime())
      ? 'invalid'
      : ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  const s = v.trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!) ?? 'invalid';
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let [a, b, y] = [+m[1]!, +m[2]!, +m[3]!];
    if (y < 100) y += y > 30 ? 1900 : 2000;
    if (b > 12 && a <= 12) [a, b] = [b, a];
    return ymd(y, b, a) ?? 'invalid';
  }
  if (/^\d{4,5}$/.test(s)) {
    const serial = Number(s);
    if (serial > 0 && serial < 80_000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return d.toISOString().slice(0, 10);
    }
  }
  return 'invalid';
}

const emailSchema = z.email();

// ───────────── Vista previa ─────────────

async function lookups() {
  const db = tenantDb();
  const [statuses, campuses, tags] = await Promise.all([
    db.catalogItem.findMany({ where: { type: 'person_status', isActive: true } }),
    db.campus.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    db.tag.findMany({ select: { name: true } }),
  ]);
  const statusMap = new Map<string, number>();
  for (const s of statuses) {
    const names = [
      s.name,
      s.systemKey,
      ...(s.systemKey ? Object.values(STATUS_LABELS[s.systemKey] ?? {}) : []),
    ];
    for (const n of names) if (n) statusMap.set(fold(n), s.id);
  }
  return {
    statusMap,
    campusMap: new Map(campuses.map((c) => [fold(c.name), c.id])),
    tagMap: new Map(tags.map((t) => [fold(t.name), t.name])),
  };
}

/** Coincidencias con personas existentes por email, teléfono o documento (en lote). */
async function existingMatches(rows: ImportRow[]) {
  const pick = (f: 'email' | 'phone' | 'documentNumber') => [
    ...new Set(rows.map((r) => r.data[f]).filter((v): v is string => Boolean(v))),
  ];
  const chunks = <T>(list: T[]) =>
    Array.from({ length: Math.ceil(list.length / 500) }, (_, i) => list.slice(i * 500, i * 500 + 500));
  const found = new Map<
    number,
    {
      id: number;
      firstName: string;
      lastName: string;
      email: string | null;
      phone: string | null;
      documentNumber: string | null;
    }
  >();
  for (const field of ['email', 'phone', 'documentNumber'] as const) {
    for (const chunk of chunks(pick(field))) {
      const people = await tenantDb().person.findMany({
        where: { deletedAt: null, [field]: { in: chunk } },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, documentNumber: true },
      });
      for (const p of people) found.set(p.id, p);
    }
  }
  return [...found.values()];
}

export async function previewImport(viewer: Viewer, file: { buffer: Buffer; originalname: string }) {
  const sheet = await readSheet(file.buffer, IMPORT_MAX_ROWS);
  const canSensitive = Boolean(scopeOf(viewer, 'personas.ver_sensibles'));

  const columns: (PersonColumn | null)[] = sheet.headers.map((h) => HEADER_MAP.get(headerKey(h)) ?? null);
  const unknownColumns = sheet.headers.filter((h, i) => h && columns[i] === null);
  const missing = PERSON_COLUMNS.filter((c) => c.required && !columns.includes(c.key)).map((c) => c.key);
  if (missing.length) throw AppError.badRequest('IMPORT_MISSING_COLUMNS', { missing });
  const ignoredColumns: string[] = [];
  if (!canSensitive) {
    columns.forEach((c, i) => {
      if (c && PERSON_COLUMNS.find((d) => d.key === c)?.sensitive) {
        ignoredColumns.push(sheet.headers[i]!);
        columns[i] = null;
      }
    });
  }

  const { statusMap, campusMap, tagMap } = await lookups();
  const newTags = new Map<string, string>();
  const today = new Date().toISOString().slice(0, 10);

  const rows: ImportRow[] = sheet.rows.map(({ row, cells }) => {
    const raw = new Map<PersonColumn, CellValue>();
    columns.forEach((c, i) => {
      if (c && !raw.has(c)) raw.set(c, cells[i] ?? null);
    });
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const get = (f: PersonColumn) => {
      const v = text(raw.get(f) ?? null);
      const max = MAX_LENGTH[f];
      if (v && max && v.length > max) {
        errors.push({ field: f, code: 'TOO_LONG' });
        return v.slice(0, max);
      }
      return v;
    };
    const date = (f: 'birthDate' | 'firstVisitAt') => {
      const parsed = parseSheetDate(raw.get(f) ?? null);
      if (parsed === 'invalid') {
        errors.push({ field: f, code: 'INVALID_DATE', value: text(raw.get(f) ?? null) ?? '' });
        return null;
      }
      if (parsed && parsed > today) {
        errors.push({ field: f, code: 'DATE_IN_FUTURE', value: parsed });
        return null;
      }
      return parsed;
    };

    const firstName = get('firstName');
    const lastName = get('lastName');
    if (!firstName) errors.push({ field: 'firstName', code: 'REQUIRED' });
    if (!lastName) errors.push({ field: 'lastName', code: 'REQUIRED' });

    let email = get('email')?.toLowerCase() ?? null;
    if (email && !emailSchema.safeParse(email).success) {
      errors.push({ field: 'email', code: 'INVALID_EMAIL', value: email });
      email = null;
    }

    const genderRaw = get('gender');
    const gender = genderRaw ? (GENDER_ALIASES[fold(genderRaw)] ?? null) : null;
    if (genderRaw && !gender) warnings.push({ field: 'gender', code: 'UNKNOWN_VALUE', value: genderRaw });

    const maritalRaw = get('maritalStatus');
    const maritalStatus = maritalRaw ? (MARITAL_ALIASES[fold(maritalRaw)] ?? null) : null;
    if (maritalRaw && !maritalStatus) {
      warnings.push({ field: 'maritalStatus', code: 'UNKNOWN_VALUE', value: maritalRaw });
    }

    const statusRaw = get('status');
    const statusId = statusRaw ? (statusMap.get(fold(statusRaw)) ?? null) : null;
    if (statusRaw && !statusId) warnings.push({ field: 'status', code: 'UNKNOWN_STATUS', value: statusRaw });

    const campusRaw = get('campus');
    const campusId = campusRaw ? (campusMap.get(fold(campusRaw)) ?? null) : null;
    if (campusRaw && !campusId) warnings.push({ field: 'campus', code: 'UNKNOWN_CAMPUS', value: campusRaw });

    const tags = [
      ...new Set(
        (get('tags') ?? '')
          .split(/[,;|]/)
          .map((t) => t.trim().slice(0, 60))
          .filter(Boolean)
          .map((t) => {
            const existing = tagMap.get(fold(t));
            if (existing) return existing;
            if (!newTags.has(fold(t))) newTags.set(fold(t), t);
            return newTags.get(fold(t))!;
          }),
      ),
    ];

    return {
      row,
      data: {
        firstName: firstName ?? '',
        lastName: lastName ?? '',
        preferredName: get('preferredName'),
        gender,
        birthDate: date('birthDate'),
        email,
        phone: normalizePhone(get('phone')),
        documentNumber: normalizeDocument(get('documentNumber')),
        maritalStatus,
        address: get('address'),
        city: get('city'),
        province: get('province'),
        statusId,
        campusId,
        tags,
        firstVisitAt: date('firstVisitAt'),
        notes: get('notes'),
      },
      errors,
      warnings,
      duplicate: null,
    };
  });

  // Duplicados dentro del archivo: la segunda aparición queda advertida.
  const seen = new Map<string, number>();
  for (const r of rows) {
    for (const f of ['email', 'phone', 'documentNumber'] as const) {
      const v = r.data[f];
      if (!v) continue;
      const key = `${f}:${v}`;
      const first = seen.get(key);
      if (first !== undefined) r.warnings.push({ field: f, code: 'DUPLICATE_IN_FILE', value: String(first) });
      else seen.set(key, r.row);
    }
  }

  // Duplicados contra la base.
  const existing = await existingMatches(rows);
  for (const r of rows) {
    const match = existing.find(
      (p) =>
        (r.data.email && p.email?.toLowerCase() === r.data.email) ||
        (r.data.phone && p.phone === r.data.phone) ||
        (r.data.documentNumber && p.documentNumber === r.data.documentNumber),
    );
    if (match) {
      const reasons = [
        ...(r.data.email && match.email?.toLowerCase() === r.data.email ? ['email'] : []),
        ...(r.data.phone && match.phone === r.data.phone ? ['phone'] : []),
        ...(r.data.documentNumber && match.documentNumber === r.data.documentNumber ? ['document'] : []),
      ];
      r.duplicate = { id: match.id, firstName: match.firstName, lastName: match.lastName, reasons };
    }
  }

  const summary: ImportSummary = {
    total: rows.length,
    valid: rows.filter((r) => r.errors.length === 0).length,
    withErrors: rows.filter((r) => r.errors.length > 0).length,
    duplicates: rows.filter((r) => r.duplicate).length,
    newTags: [...newTags.values()],
    ignoredColumns,
    unknownColumns,
  };

  const db = tenantDb();
  await db.importJob.deleteMany({ where: { expiresAt: { lt: new Date() } } }); // limpieza oportunista
  const job = await db.importJob.create({
    data: {
      accountId: currentAccountId(),
      createdById: viewer.userId,
      fileName: file.originalname.slice(0, 250),
      rows: JSON.stringify(rows),
      summary: JSON.stringify(summary),
      expiresAt: new Date(Date.now() + JOB_TTL_MS),
    },
  });
  return presentJob(job);
}

function presentJob(job: {
  id: number;
  fileName: string;
  status: string;
  rows: string;
  summary: string;
  expiresAt: Date;
  createdAt: Date;
  committedAt: Date | null;
}) {
  return {
    id: job.id,
    fileName: job.fileName,
    status: job.status,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    committedAt: job.committedAt,
    summary: JSON.parse(job.summary) as ImportSummary,
    rows: JSON.parse(job.rows) as ImportRow[],
  };
}

/** Solo quien subió el archivo ve y confirma su importación. */
async function findJob(viewer: Viewer, id: number) {
  const job = await tenantDb().importJob.findFirst({ where: { id, createdById: viewer.userId } });
  if (!job) throw AppError.notFound('IMPORT_NOT_FOUND');
  return job;
}

export async function getImport(viewer: Viewer, id: number) {
  return presentJob(await findJob(viewer, id));
}

export async function commitImport(viewer: Viewer, id: number, options: { duplicates: 'skip' | 'create' }) {
  const job = await findJob(viewer, id);
  if (job.status === 'committed') throw AppError.conflict('IMPORT_ALREADY_COMMITTED');
  if (job.expiresAt < new Date()) throw AppError.conflict('IMPORT_EXPIRED');

  const rows = (JSON.parse(job.rows) as ImportRow[]).filter(
    (r) => r.errors.length === 0 && (options.duplicates === 'create' || !r.duplicate),
  );
  const summary = JSON.parse(job.summary) as ImportSummary;
  const db = tenantDb();
  const accountId = currentAccountId();

  // Etiquetas nuevas (puede que alguien las haya creado entre la vista previa y la confirmación).
  const tagNames = [...new Set(rows.flatMap((r) => r.data.tags))];
  const existing = await db.tag.findMany({ select: { id: true, name: true } });
  const tagIds = new Map(existing.map((t) => [fold(t.name), t.id]));
  for (const name of tagNames) {
    if (!tagIds.has(fold(name))) {
      const tag = await db.tag.create({ data: { accountId, name } });
      tagIds.set(fold(name), tag.id);
    }
  }

  const fallbackStatus = await defaultStatusId();
  // Sede o estado desactivados entre la vista previa y la confirmación: se descartan.
  const [activeStatuses, activeCampuses] = await Promise.all([
    db.catalogItem.findMany({ where: { type: 'person_status', isActive: true }, select: { id: true } }),
    db.campus.findMany({ select: { id: true } }),
  ]);
  const statusOk = new Set(activeStatuses.map((s) => s.id));
  const campusOk = new Set(activeCampuses.map((c) => c.id));
  const toDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);

  let created = 0;
  for (let i = 0; i < rows.length; i += COMMIT_CHUNK) {
    const chunk = rows.slice(i, i + COMMIT_CHUNK);
    await db.$transaction(
      async (tx) => {
        for (const { data } of chunk) {
          const statusId = data.statusId && statusOk.has(data.statusId) ? data.statusId : fallbackStatus;
          const person: Prisma.PersonUncheckedCreateInput = {
            accountId,
            firstName: data.firstName,
            lastName: data.lastName,
            preferredName: data.preferredName,
            gender: data.gender,
            birthDate: toDate(data.birthDate),
            email: data.email,
            phone: data.phone,
            documentNumber: data.documentNumber,
            maritalStatus: data.maritalStatus,
            address: data.address,
            city: data.city,
            province: data.province,
            campusId: data.campusId && campusOk.has(data.campusId) ? data.campusId : null,
            firstVisitAt: toDate(data.firstVisitAt),
            notes: data.notes,
            statusId,
            source: 'import',
            createdById: viewer.userId,
            searchText: searchTextOf(data),
            // Escrituras anidadas: ver createPerson (el chequeo de padres no ve la fila recién creada).
            statusHistory: { create: { accountId, toStatusId: statusId, changedById: viewer.userId } },
            ...(data.tags.length
              ? { tags: { create: data.tags.map((t) => ({ tagId: tagIds.get(fold(t))! })) } }
              : {}),
          };
          await tx.person.create({ data: person, select: { id: true } });
          created++;
        }
      },
      { timeout: 60_000 },
    );
  }

  const final: ImportSummary = { ...summary, created, skipped: summary.total - created };
  // Una vez confirmada, las filas (datos personales) ya no hacen falta.
  await db.importJob.update({
    where: { id },
    data: { status: 'committed', committedAt: new Date(), rows: '[]', summary: JSON.stringify(final) },
  });
  await audit({
    action: 'people.import',
    entity: 'ImportJob',
    entityId: id,
    after: { fileName: job.fileName, created, skipped: final.skipped, duplicates: options.duplicates },
  });
  return { id, status: 'committed', summary: final };
}
