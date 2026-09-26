import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';

const t = tenantRouter();
export const campusRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });

const CampusInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    address: z.string().trim().max(250).nullable(),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    isActive: z.boolean(),
    isMain: z.boolean(),
  })
  .strict();

const CreateCampus = CampusInput.partial().required({ name: true });
const UpdateCampus = CampusInput.partial();

const campusSelect = {
  id: true,
  name: true,
  isMain: true,
  address: true,
  lat: true,
  lng: true,
  isActive: true,
} as const;

// Cualquier usuario de la cuenta: se usa en filtros y selectores de sede.
t.get('/campuses', 'account-user', async (_req, res) => {
  const items = await tenantDb().campus.findMany({
    select: campusSelect,
    orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
  });
  res.json({ items });
});

t.get('/campuses/:id', 'account-user', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const campus = await tenantDb().campus.findUnique({ where: { id }, select: campusSelect });
  if (!campus) throw AppError.notFound();
  res.json(campus);
});

t.post('/campuses', 'estructura.gestionar', async (req, res) => {
  const data = parse(CreateCampus, req.body);
  const db = tenantDb();
  const campus = await db.$transaction(async (tx) => {
    // Siempre hay exactamente una sede principal.
    if (data.isMain) await tx.campus.updateMany({ where: { isMain: true }, data: { isMain: false } });
    return tx.campus.create({
      data: { ...data, isActive: data.isMain ? true : data.isActive, accountId: currentAccountId() },
      select: campusSelect,
    });
  });
  await audit({ action: 'structure.campus.create', entity: 'Campus', entityId: campus.id, after: campus });
  res.status(201).json(campus);
});

t.patch('/campuses/:id', 'estructura.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const data = parse(UpdateCampus, req.body);
  const db = tenantDb();
  const before = await db.campus.findUnique({ where: { id }, select: campusSelect });
  if (!before) throw AppError.notFound();
  if (before.isMain && (data.isMain === false || data.isActive === false)) {
    throw AppError.conflict('CAMPUS_MAIN_REQUIRED');
  }

  const campus = await db.$transaction(async (tx) => {
    if (data.isMain)
      await tx.campus.updateMany({ where: { isMain: true, id: { not: id } }, data: { isMain: false } });
    return tx.campus.update({
      where: { id },
      data: { ...data, ...(data.isMain ? { isActive: true } : {}) },
      select: campusSelect,
    });
  });
  await audit({ action: 'structure.campus.update', entity: 'Campus', entityId: id, before, after: campus });
  res.json(campus);
});
