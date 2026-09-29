import multer from 'multer';
import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { tenantDb, currentAccountId } from '../../core/db/tenant.js';
import { processImage, saveFile } from '../../core/files/files.service.js';
import { AppError } from '../../core/http/errors.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { viewerOf } from '../people/people.scope.js';
import * as inventory from './inventory.service.js';
import { renderLabels } from './labels.js';

const t = tenantRouter();
export const inventoryRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });

t.get('/inventory/items', 'inventario.ver', async (req, res) => {
  res.json(await inventory.listItems(parse(inventory.ListItemsQuery, req.query)));
});

t.get('/inventory/items/:id', 'inventario.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await inventory.getItem(id));
});

t.post('/inventory/items', 'inventario.gestionar', async (req, res) => {
  const input = parse(inventory.CreateItemSchema, req.body);
  res.status(201).json(await inventory.createItem(await viewerOf(req), input));
});

t.patch('/inventory/items/:id', 'inventario.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await inventory.updateItem(id, parse(inventory.UpdateItemSchema, req.body)));
});

t.delete('/inventory/items/:id', 'inventario.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await inventory.deleteItem(id);
  res.status(204).end();
});

// El QR lleva al front (/i/<token>); el front pregunta acá a qué equipo corresponde.
t.get('/inventory/q/:token', 'inventario.ver', async (req, res) => {
  const { token } = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }), req.params);
  res.json(await inventory.resolveQr(token));
});

// ───────────── Foto ─────────────

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1_048_576, files: 1 },
});

t.post('/inventory/items/:id/photo', 'inventario.gestionar', photoUpload.single('file'), async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await inventory.getItem(id); // 404 antes de guardar el archivo
  if (!req.file) throw AppError.badRequest('FILE_REQUIRED');
  const data = await processImage(req.file.buffer, 1024);
  const file = await saveFile({
    data,
    originalName: req.file.originalname,
    mimeType: 'image/webp',
    purpose: 'inventory',
  });
  await inventory.setPhoto(id, file.id);
  res.status(201).json({ photoFileId: file.id });
});

t.delete('/inventory/items/:id/photo', 'inventario.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await inventory.setPhoto(id, null);
  res.status(204).end();
});

// ───────────── Mantenimiento ─────────────

t.post('/inventory/items/:id/maintenance', 'inventario.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(inventory.MaintenanceSchema, req.body);
  res.status(201).json(await inventory.addMaintenance(await viewerOf(req), id, input));
});

t.delete('/inventory/maintenance/:id', 'inventario.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await inventory.deleteMaintenance(id));
});

// ───────────── Etiquetas ─────────────

async function sendLabels(res: Parameters<Parameters<typeof t.get>[2]>[1], ids: number[], filename: string) {
  const items = await inventory.itemsForLabels(ids);
  if (!items.length) throw AppError.notFound('INVENTORY_ITEM_NOT_FOUND');
  const { name } = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { name: true },
  });
  const buffer = await renderLabels(name, items);
  await audit({ action: 'inventory.labels.print', entity: 'InventoryItem', after: { count: items.length } });
  res.attachment(filename).type('application/pdf').setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}

t.get('/inventory/items/:id/label.pdf', 'inventario.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await sendLabels(res, [id], `etiqueta-${id}.pdf`);
});

t.get('/inventory/labels.pdf', 'inventario.gestionar', async (req, res) => {
  const { ids } = parse(inventory.LabelsQuery, req.query);
  await sendLabels(res, ids, 'etiquetas.pdf');
});
