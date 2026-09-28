import { fileTypeFromBuffer } from 'file-type';
import multer from 'multer';
import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { tenantDb } from '../../core/db/tenant.js';
import { deleteFile, processImage, saveFile } from '../../core/files/files.service.js';
import { AppError } from '../../core/http/errors.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { viewerOf } from '../people/people.scope.js';
import * as finance from './finance.service.js';

const t = tenantRouter();
export const financeRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });

// ───────────── Resumen ─────────────

t.get('/finance/summary', 'finanzas.ver', async (req, res) => {
  res.json(await finance.summary(await viewerOf(req)));
});

// ───────────── Cajas ─────────────

t.get('/finance/accounts', ['finanzas.ver', 'finanzas.cajas'], async (req, res) => {
  const { includeInactive } = parse(z.object({ includeInactive: z.stringbool().default(false) }), req.query);
  res.json({ items: await finance.listAccounts(includeInactive) });
});

t.post('/finance/accounts', 'finanzas.cajas', async (req, res) => {
  const input = parse(finance.AccountInput.required({ name: true, type: true }), req.body);
  res.status(201).json(await finance.createAccount(input));
});

t.patch('/finance/accounts/:id', 'finanzas.cajas', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await finance.updateAccount(id, parse(finance.AccountInput, req.body)));
});

t.delete('/finance/accounts/:id', 'finanzas.cajas', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await finance.deleteAccount(id);
  res.status(204).end();
});

// ───────────── Categorías ─────────────

t.get(
  '/finance/categories',
  ['finanzas.ver', 'finanzas.categorias', 'finanzas.registrar'],
  async (req, res) => {
    const query = parse(
      z.object({
        kind: z.enum(finance.CATEGORY_KINDS).optional(),
        includeInactive: z.stringbool().default(false),
      }),
      req.query,
    );
    res.json({ items: await finance.listCategories(query) });
  },
);

t.post('/finance/categories', 'finanzas.categorias', async (req, res) => {
  const input = parse(finance.CategoryInput.required({ kind: true, name: true }), req.body);
  if (!input.name) throw AppError.badRequest('CATALOG_NAME_REQUIRED');
  res.status(201).json(await finance.createCategory({ kind: input.kind, name: input.name }));
});

// Antes de /finance/categories/:id.
t.put('/finance/categories/order', 'finanzas.categorias', async (req, res) => {
  const { ids } = parse(
    z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) }).strict(),
    req.body,
  );
  await finance.reorderCategories(ids);
  res.json({ items: await finance.listCategories({ includeInactive: true }) });
});

t.patch('/finance/categories/:id', 'finanzas.categorias', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { kind: _kind, ...input } = parse(finance.CategoryInput, req.body);
  res.json(await finance.updateCategory(id, input));
});

t.delete('/finance/categories/:id', 'finanzas.categorias', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await finance.deleteCategory(id);
  res.status(204).end();
});

// ───────────── Movimientos ─────────────

t.get('/finance/movements', 'finanzas.ver', async (req, res) => {
  res.json(await finance.listMovements(await viewerOf(req), parse(finance.ListMovementsQuery, req.query)));
});

t.get('/finance/movements/:id', 'finanzas.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await finance.getMovement(await viewerOf(req), id));
});

t.post('/finance/movements', 'finanzas.registrar', async (req, res) => {
  const input = parse(finance.CreateMovementSchema, req.body);
  res.status(201).json(await finance.createMovement(await viewerOf(req), input));
});

t.patch('/finance/movements/:id', 'finanzas.registrar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(
    await finance.updateMovement(await viewerOf(req), id, parse(finance.UpdateMovementSchema, req.body)),
  );
});

t.post('/finance/movements/:id/void', 'finanzas.anular', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(300) }).strict(), req.body);
  res.json(await finance.voidMovement(await viewerOf(req), id, reason));
});

t.post('/finance/transfers', 'finanzas.registrar', async (req, res) => {
  const input = parse(finance.TransferSchema, req.body);
  res.status(201).json(await finance.createTransfer(await viewerOf(req), input));
});

// ───────────── Comprobantes ─────────────

const MAX_ATTACHMENTS = 5;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1_048_576, files: 1 } });

/** Foto (se normaliza a webp, sin metadatos) o PDF; el tipo se valida por el contenido real. */
async function normalizeReceipt(file: Express.Multer.File) {
  const detected = await fileTypeFromBuffer(file.buffer);
  if (detected?.mime === 'application/pdf') return { data: file.buffer, mimeType: 'application/pdf' };
  return { data: await processImage(file.buffer, 2000), mimeType: 'image/webp' };
}

async function editableMovement(id: number) {
  const movement = await tenantDb().financeMovement.findUnique({ where: { id }, select: { status: true } });
  if (!movement) throw AppError.notFound('MOVEMENT_NOT_FOUND');
  if (movement.status === 'voided') throw AppError.conflict('MOVEMENT_VOIDED');
}

t.post(
  '/finance/movements/:id/attachments',
  'finanzas.registrar',
  upload.single('file'),
  async (req, res) => {
    const { id } = parse(IdParam, req.params);
    await editableMovement(id);
    if (!req.file) throw AppError.badRequest('FILE_REQUIRED');
    const db = tenantDb();
    if ((await db.movementAttachment.count({ where: { movementId: id } })) >= MAX_ATTACHMENTS) {
      throw AppError.conflict('ATTACHMENT_LIMIT', { max: MAX_ATTACHMENTS });
    }
    const { data, mimeType } = await normalizeReceipt(req.file);
    const file = await saveFile({ data, originalName: req.file.originalname, mimeType, purpose: 'receipt' });
    await db.movementAttachment.create({ data: { movementId: id, fileId: file.id } });
    await audit({
      action: 'finance.attachment.add',
      entity: 'FinanceMovement',
      entityId: id,
      after: { fileId: file.id },
    });
    res.status(201).json(await finance.getMovement(await viewerOf(req), id));
  },
);

t.delete('/finance/movements/:id/attachments/:fileId', 'finanzas.registrar', async (req, res) => {
  const { id, fileId } = parse(IdParam.extend({ fileId: z.coerce.number().int().positive() }), req.params);
  await editableMovement(id);
  const db = tenantDb();
  const { count } = await db.movementAttachment.deleteMany({ where: { movementId: id, fileId } });
  if (count === 0) throw AppError.notFound('FILE_NOT_FOUND');
  await deleteFile(fileId);
  await audit({
    action: 'finance.attachment.remove',
    entity: 'FinanceMovement',
    entityId: id,
    before: { fileId },
  });
  res.status(204).end();
});
