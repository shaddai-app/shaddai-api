import multer from 'multer';
import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { tenantDb } from '../../core/db/tenant.js';
import { deleteFile, processImage, saveFile } from '../../core/files/files.service.js';
import { AppError } from '../../core/http/errors.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import {
  ChangeStatusSchema,
  CreatePersonSchema,
  dateOnly,
  DuplicatesQuery,
  IdParam,
  ListPeopleQuery,
  MergeSchema,
  MilestoneSchema,
  PositionSchema,
  SetTagsSchema,
  SubIdParam,
  UpdatePersonSchema,
} from './people.schemas.js';
import { canOnPerson, viewerOf } from './people.scope.js';
import * as people from './people.service.js';

const t = tenantRouter();
export const peopleRouter = t.router;

t.get('/people', 'personas.ver', async (req, res) => {
  res.json(await people.listPeople(await viewerOf(req), parse(ListPeopleQuery, req.query)));
});

// Antes de /people/:id para que "duplicates" no se tome como id.
t.get('/people/duplicates', ['personas.crear', 'personas.editar', 'personas.fusionar'], async (req, res) => {
  res.json(await people.findDuplicates(await viewerOf(req), parse(DuplicatesQuery, req.query)));
});

t.get('/people/:id', 'personas.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await people.getPerson(await viewerOf(req), id, { auditView: true }));
});

t.get('/people/:id/timeline', 'personas.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await people.timeline(await viewerOf(req), id));
});

t.post('/people', 'personas.crear', async (req, res) => {
  const input = parse(CreatePersonSchema, req.body);
  res.status(201).json(await people.createPerson(await viewerOf(req), input));
});

t.patch('/people/:id', 'personas.editar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await people.updatePerson(await viewerOf(req), id, parse(UpdatePersonSchema, req.body)));
});

t.delete('/people/:id', 'personas.eliminar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await people.deletePerson(await viewerOf(req), id);
  res.status(204).end();
});

t.post('/people/:id/status', 'personas.editar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await people.changeStatus(await viewerOf(req), id, parse(ChangeStatusSchema, req.body)));
});

t.post('/people/:id/milestones', 'personas.editar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.status(201).json(await people.addMilestone(await viewerOf(req), id, parse(MilestoneSchema, req.body)));
});

t.patch('/people/:id/milestones/:subId', 'personas.editar', async (req, res) => {
  const { id, subId } = parse(SubIdParam, req.params);
  const input = parse(MilestoneSchema.partial(), req.body);
  res.json(await people.updateMilestone(await viewerOf(req), id, subId, input));
});

t.delete('/people/:id/milestones/:subId', 'personas.editar', async (req, res) => {
  const { id, subId } = parse(SubIdParam, req.params);
  res.json(await people.removeMilestone(await viewerOf(req), id, subId));
});

t.post('/people/:id/positions', 'personas.editar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.status(201).json(await people.addPosition(await viewerOf(req), id, parse(PositionSchema, req.body)));
});

const PositionPatch = z.object({ since: dateOnly.nullable(), until: dateOnly.nullable() }).partial().strict();

t.patch('/people/:id/positions/:subId', 'personas.editar', async (req, res) => {
  const { id, subId } = parse(SubIdParam, req.params);
  res.json(await people.updatePosition(await viewerOf(req), id, subId, parse(PositionPatch, req.body)));
});

t.delete('/people/:id/positions/:subId', 'personas.editar', async (req, res) => {
  const { id, subId } = parse(SubIdParam, req.params);
  res.json(await people.removePosition(await viewerOf(req), id, subId));
});

t.put('/people/:id/tags', 'personas.editar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { tagIds } = parse(SetTagsSchema, req.body);
  res.json(await people.setTags(await viewerOf(req), id, tagIds));
});

t.post('/people/:id/merge', 'personas.fusionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { intoId } = parse(MergeSchema, req.body);
  res.json(await people.mergePeople(await viewerOf(req), id, intoId));
});

// ───────────── Foto ─────────────

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1_048_576, files: 1 },
});

async function assertEditable(req: Parameters<typeof viewerOf>[0], id: number) {
  const viewer = await viewerOf(req);
  if (!(await canOnPerson(viewer, 'personas.ver', id))) throw AppError.notFound('PERSON_NOT_FOUND');
  if (!(await canOnPerson(viewer, 'personas.editar', id))) throw AppError.forbidden('PERSON_EDIT_FORBIDDEN');
}

t.post('/people/:id/photo', 'personas.editar', photoUpload.single('file'), async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await assertEditable(req, id);
  if (!req.file) throw AppError.badRequest('FILE_REQUIRED');
  const data = await processImage(req.file.buffer, 640);
  const file = await saveFile({
    data,
    originalName: req.file.originalname,
    mimeType: 'image/webp',
    purpose: 'photo',
  });
  const db = tenantDb();
  const { photoFileId: previous } = await db.person.findUniqueOrThrow({
    where: { id },
    select: { photoFileId: true },
  });
  await db.person.update({ where: { id }, data: { photoFileId: file.id } });
  if (previous) await deleteFile(previous);
  await audit({ action: 'people.photo.update', entity: 'Person', entityId: id, after: { fileId: file.id } });
  res.status(201).json({ photoFileId: file.id });
});

t.delete('/people/:id/photo', 'personas.editar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await assertEditable(req, id);
  const db = tenantDb();
  const { photoFileId } = await db.person.findUniqueOrThrow({ where: { id }, select: { photoFileId: true } });
  if (photoFileId) {
    await db.person.update({ where: { id }, data: { photoFileId: null } });
    await deleteFile(photoFileId);
    await audit({ action: 'people.photo.delete', entity: 'Person', entityId: id });
  }
  res.status(204).end();
});
