import type { Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { listAccountAudit } from '../../core/audit/audit-query.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { deleteFile, processImage, readFileObject, saveFile } from '../../core/files/files.service.js';
import { AppError } from '../../core/http/errors.js';
import { PaginationQuery } from '../../core/http/pagination.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { hasPermission } from '../../core/middleware/authorize.js';
import { canOnPerson, viewerOf } from '../people/people.scope.js';

const t = tenantRouter();
export const accountRouter = t.router;

const PRIMARY_PRESETS = ['slate', 'indigo', 'teal', 'burgundy', 'graphite', 'violet'] as const;

const publicSelect = {
  id: true,
  name: true,
  slug: true,
  status: true,
  logoFileId: true,
  defaultLocale: true,
  timezone: true,
  currency: true,
  weekStartsOn: true,
  primaryColor: true,
  structureLabels: true,
  cellMultiplyTarget: true,
  cellReportEditDays: true,
  trialEndsAt: true,
} as const;

const adminSelect = {
  ...publicSelect,
  legalName: true,
  taxId: true,
  taxCondition: true,
  ccliLicense: true,
  email: true,
  phone: true,
  address: true,
} as const;

const optionalText = (max: number) => z.string().trim().max(max).nullable();

const UpdateAccountSchema = z
  .object({
    name: z.string().trim().min(2).max(150),
    legalName: optionalText(150),
    taxId: z
      .string()
      .trim()
      .regex(/^\d{2}-?\d{8}-?\d$/)
      .nullable(),
    taxCondition: optionalText(30),
    ccliLicense: optionalText(20),
    email: z.string().trim().toLowerCase().pipe(z.email().max(150)).nullable(),
    phone: optionalText(30),
    address: optionalText(250),
    defaultLocale: z.enum(['es', 'en', 'pt']),
    timezone: z.string().trim().min(1).max(50),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((c) => c.toUpperCase()),
    weekStartsOn: z.union([z.literal(0), z.literal(1)]),
    primaryColor: z.enum(PRIMARY_PRESETS),
    structureLabels: z
      .object({ network: z.string().trim().min(1).max(40), zone: z.string().trim().min(1).max(40) })
      .partial()
      .nullable(),
    cellMultiplyTarget: z.number().int().min(2).max(200),
    cellReportEditDays: z.number().int().min(0).max(60),
  })
  .partial()
  .strict();

function present<T extends { structureLabels: string | null }>(account: T) {
  return {
    ...account,
    structureLabels: account.structureLabels ? (JSON.parse(account.structureLabels) as unknown) : null,
  };
}

// Cualquier usuario: configuración regional, color y logo que necesita el front. Datos fiscales/contacto solo admin.
t.get('/account', 'account-user', async (req, res) => {
  const full = await hasPermission(req, 'cuenta.configurar');
  const account = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: full ? adminSelect : publicSelect,
  });
  res.json(present(account));
});

t.patch('/account', 'cuenta.configurar', async (req, res) => {
  const input = parse(UpdateAccountSchema, req.body);
  const db = tenantDb();
  const before = await db.account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: adminSelect,
  });
  const { structureLabels, ...rest } = input;
  const after = await db.account.update({
    where: { id: currentAccountId() },
    data: {
      ...rest,
      ...(structureLabels !== undefined
        ? { structureLabels: structureLabels ? JSON.stringify(structureLabels) : null }
        : {}),
    },
    select: adminSelect,
  });
  await audit({ action: 'account.update', entity: 'Account', entityId: after.id, before, after });
  res.json(present(after));
});

t.get('/account/usage', 'cuenta.configurar', async (_req, res) => {
  const db = tenantDb();
  const [account, activeUsers] = await Promise.all([
    db.account.findUniqueOrThrow({
      where: { id: currentAccountId() },
      select: {
        status: true,
        trialEndsAt: true,
        userLimit: true,
        storageLimitMb: true,
        storageUsedBytes: true,
        plan: { select: { code: true, name: true } },
      },
    }),
    db.user.count({ where: { isActive: true, deletedAt: null } }),
  ]);
  const { storageUsedBytes, ...rest } = account;
  res.json({
    ...rest,
    activeUsers,
    storageUsedMb: Math.round((Number(storageUsedBytes) / 1_048_576) * 100) / 100,
  });
});

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1_048_576, files: 1 } });

t.post('/account/logo', 'cuenta.configurar', logoUpload.single('file'), async (req, res) => {
  if (!req.file) throw AppError.badRequest('FILE_REQUIRED');
  const data = await processImage(req.file.buffer, 512);
  const file = await saveFile({
    data,
    originalName: req.file.originalname,
    mimeType: 'image/webp',
    purpose: 'logo',
  });
  const db = tenantDb();
  const previous = await db.account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { logoFileId: true },
  });
  await db.account.update({ where: { id: currentAccountId() }, data: { logoFileId: file.id } });
  if (previous.logoFileId) await deleteFile(previous.logoFileId);
  await audit({
    action: 'account.logo.update',
    entity: 'Account',
    entityId: currentAccountId(),
    after: { fileId: file.id },
  });
  res.status(201).json({ logoFileId: file.id });
});

t.delete('/account/logo', 'cuenta.configurar', async (_req, res) => {
  const db = tenantDb();
  const { logoFileId } = await db.account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { logoFileId: true },
  });
  if (logoFileId) {
    await db.account.update({ where: { id: currentAccountId() }, data: { logoFileId: null } });
    await deleteFile(logoFileId);
    await audit({ action: 'account.logo.delete', entity: 'Account', entityId: currentAccountId() });
  }
  res.status(204).end();
});

// Auditoría de la iglesia (incluye cuándo entró el soporte de Shaddai).
const AuditQuery = PaginationQuery.extend({
  userId: z.coerce.number().int().positive().optional(),
  action: z.string().trim().max(60).optional(),
  entity: z.string().trim().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

t.get('/audit', 'auditoria.ver', async (req, res) => {
  res.json(await listAccountAudit(currentAccountId(), parse(AuditQuery, req.query)));
});

// Descarga de archivos. Cada propósito decide quién lo puede ver; cada módulo que agregue uno
// (comprobantes, reportes de célula) suma aquí su regla. Sin regla → 404.
const FILE_ACCESS: Record<string, (req: Request, fileId: number) => Promise<boolean>> = {
  logo: async () => true,
  // Comprobante: quien ve finanzas, si está adjunto a un movimiento de la cuenta.
  receipt: async (req, fileId) =>
    (await hasPermission(req, 'finanzas.ver')) &&
    (await tenantDb().movementAttachment.count({ where: { fileId } })) > 0,
  // Foto de persona: solo si esa persona está en el alcance de personas.ver del usuario.
  photo: async (req, fileId) => {
    const person = await tenantDb().person.findFirst({
      where: { photoFileId: fileId, deletedAt: null },
      select: { id: true },
    });
    return person !== null && canOnPerson(await viewerOf(req), 'personas.ver', person.id);
  },
};

t.get('/files/:id', 'account-user', async (req, res) => {
  const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
  const { file, data } = await readFileObject(id);
  const allowed = FILE_ACCESS[file.purpose];
  if (!allowed || !(await allowed(req, id))) throw AppError.notFound('FILE_NOT_FOUND');
  res.set({
    'Content-Type': file.mimeType,
    'Content-Length': String(data.length),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  });
  res.end(data);
});
