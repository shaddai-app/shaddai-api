import multer from 'multer';
import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { tenantDb } from '../../core/db/tenant.js';
import { writeCsv, writeXlsx } from '../../core/excel/spreadsheet.js';
import { AppError } from '../../core/http/errors.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import {
  GENDER_LABELS,
  MARITAL_LABELS,
  PERSON_COLUMNS,
  STATUS_LABELS,
  type Locale,
  type PersonColumn,
} from './people.labels.js';
import { commitImport, getImport, previewImport } from './people.import.js';
import { IdParam, ListPeopleQuery } from './people.schemas.js';
import { peopleListWhere, peopleOrderBy } from './people.service.js';
import { scopeOf, viewerOf } from './people.scope.js';

const t = tenantRouter();
/** Montar ANTES de peopleRouter: "/people/export" coincidiría con "/people/:id". */
export const peopleIoRouter = t.router;

const EXPORT_MAX_ROWS = 20_000;
const LocaleQuery = z.enum(['es', 'en', 'pt']).default('es');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1_048_576, files: 1 } });

const EXAMPLE: Partial<Record<PersonColumn, Record<Locale, string>>> = {
  firstName: { es: 'Juan', en: 'John', pt: 'João' },
  lastName: { es: 'Pérez', en: 'Smith', pt: 'Silva' },
  gender: { es: 'Masculino', en: 'Male', pt: 'Masculino' },
  birthDate: { es: '17/05/1990', en: '1990-05-17', pt: '17/05/1990' },
  email: { es: 'juan.perez@ejemplo.com', en: 'john@example.com', pt: 'joao@exemplo.com' },
  phone: { es: '+54 9 11 5555-1234', en: '+1 555 0100', pt: '+55 11 95555-1234' },
  city: { es: 'Quilmes', en: 'Springfield', pt: 'São Paulo' },
  status: { es: 'Visitante', en: 'Visitor', pt: 'Visitante' },
  tags: { es: 'Jóvenes, Coro', en: 'Youth, Choir', pt: 'Jovens, Coral' },
};

t.get('/people/import/template', 'personas.importar', async (req, res) => {
  const { locale, format } = parse(
    z.object({ locale: LocaleQuery, format: z.enum(['xlsx', 'csv']).default('xlsx') }),
    req.query,
  );
  const headers = PERSON_COLUMNS.map((c) => c.header[locale]);
  const example = PERSON_COLUMNS.map((c) => EXAMPLE[c.key]?.[locale] ?? null);
  const name = { es: 'plantilla-personas', en: 'people-template', pt: 'modelo-pessoas' }[locale];
  if (format === 'csv') {
    res.attachment(`${name}.csv`).type('text/csv; charset=utf-8');
    res.send(writeCsv(headers, [example], locale === 'en' ? ',' : ';'));
    return;
  }
  res.attachment(`${name}.xlsx`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(await writeXlsx(name, headers, [example]));
});

t.post('/people/import', 'personas.importar', upload.single('file'), async (req, res) => {
  if (!req.file) throw AppError.badRequest('FILE_REQUIRED');
  res.status(201).json(await previewImport(await viewerOf(req), req.file));
});

t.get('/people/import/:id', 'personas.importar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await getImport(await viewerOf(req), id));
});

t.post('/people/import/:id/commit', 'personas.importar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const options = parse(
    z.object({ duplicates: z.enum(['skip', 'create']).default('skip') }).strict(),
    req.body,
  );
  res.json(await commitImport(await viewerOf(req), id, options));
});

// ───────────── Exportación ─────────────

const ExportQuery = ListPeopleQuery.omit({ page: true, pageSize: true }).extend({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  locale: LocaleQuery,
});

t.get('/people/export', 'personas.exportar', async (req, res) => {
  const viewer = await viewerOf(req);
  const { format, locale, ...filters } = parse(ExportQuery, req.query);
  const where = peopleListWhere(viewer, filters);

  // Sensibles solo si los puede ver en TODAS las filas exportadas.
  const sensitiveScope = scopeOf(viewer, 'personas.ver_sensibles');
  const withSensitive =
    sensitiveScope === 'all' || (sensitiveScope === 'own' && scopeOf(viewer, 'personas.ver') === 'own');
  const columns = PERSON_COLUMNS.filter((c) => withSensitive || !c.sensitive);

  const db = tenantDb();
  const total = await db.person.count({ where });
  if (total > EXPORT_MAX_ROWS)
    throw AppError.badRequest('EXPORT_TOO_MANY_ROWS', { max: EXPORT_MAX_ROWS, total });
  const people = await db.person.findMany({
    where,
    orderBy: peopleOrderBy(filters.sort),
    include: {
      status: { select: { name: true, systemKey: true } },
      campus: { select: { name: true } },
      tags: { select: { tag: { select: { name: true } } } },
    },
  });

  const dateCell = (d: Date | null) => {
    if (!d) return null;
    if (format === 'xlsx') return d;
    const iso = d.toISOString().slice(0, 10);
    return locale === 'en' ? iso : iso.split('-').reverse().join('/');
  };
  const rows = people.map((p) =>
    columns.map((c): string | Date | null => {
      switch (c.key) {
        case 'gender':
          return p.gender ? (GENDER_LABELS[p.gender as 'F' | 'M']?.[locale] ?? p.gender) : null;
        case 'maritalStatus':
          return p.maritalStatus ? (MARITAL_LABELS[p.maritalStatus]?.[locale] ?? p.maritalStatus) : null;
        case 'birthDate':
        case 'firstVisitAt':
          return dateCell(p[c.key]);
        case 'status':
          return (
            p.status.name ?? (p.status.systemKey ? STATUS_LABELS[p.status.systemKey]?.[locale] : null) ?? null
          );
        case 'campus':
          return p.campus?.name ?? null;
        case 'tags':
          return p.tags.map((pt) => pt.tag.name).join(', ') || null;
        default:
          return p[c.key];
      }
    }),
  );
  const headers = columns.map((c) => c.header[locale]);

  await audit({
    action: 'people.export',
    entity: 'Person',
    after: { count: people.length, format, withSensitive, filters },
  });

  const name = `${{ es: 'personas', en: 'people', pt: 'pessoas' }[locale]}-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'csv') {
    res.attachment(`${name}.csv`).type('text/csv; charset=utf-8');
    res.send(writeCsv(headers, rows as (string | null)[][], locale === 'en' ? ',' : ';'));
    return;
  }
  res.attachment(`${name}.xlsx`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(await writeXlsx(name, headers, rows));
});
