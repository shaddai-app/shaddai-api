import { z } from 'zod';
import { geocode, geocodingEnabled } from '../../core/geocoding/geocoding.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { viewerOf } from '../people/people.scope.js';
import * as cells from './cells.service.js';

const t = tenantRouter();
export const cellsRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const MemberParam = IdParam.extend({ personId: z.coerce.number().int().positive() });

t.get('/cells', 'celulas.ver', async (req, res) => {
  res.json(await cells.listCells(await viewerOf(req), parse(cells.ListCellsQuery, req.query)));
});

// Antes de /cells/:id.
t.get('/cells/map', 'celulas.ver', async (req, res) => {
  const filters = parse(
    z.object({
      zoneId: z.coerce.number().int().positive().optional(),
      networkId: z.coerce.number().int().positive().optional(),
    }),
    req.query,
  );
  res.json(await cells.cellsMap(await viewerOf(req), filters));
});

t.get(
  '/cells/nearest',
  ['celulas.ver', 'consolidacion.gestionar', 'personas.nuevos_revisar'],
  async (req, res) => {
    const query = parse(
      z.object({
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        personId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(20).default(5),
      }),
      req.query,
    );
    res.json(await cells.nearestCells(await viewerOf(req), query));
  },
);

t.get('/cells/:id', 'celulas.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await cells.getCell(await viewerOf(req), id));
});

t.post('/cells', 'celulas.crear', async (req, res) => {
  const input = parse(cells.CreateCellSchema, req.body);
  res.status(201).json(await cells.createCell(await viewerOf(req), input));
});

t.patch('/cells/:id', 'celulas.editar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await cells.updateCell(await viewerOf(req), id, parse(cells.UpdateCellSchema, req.body)));
});

// Cerrar una célula (no se borra: conserva historial de reportes e integrantes).
t.delete('/cells/:id', 'celulas.eliminar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const viewer = await viewerOf(req);
  // Con celulas.eliminar (sin alcance) se cierra aunque no tenga celulas.editar sobre ella.
  res.json(
    await cells.updateCell(
      { ...viewer, permissions: { ...viewer.permissions, 'celulas.editar': 'all' } },
      id,
      { status: 'closed' },
    ),
  );
});

t.post('/cells/:id/members', 'celulas.editar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { personId, move } = parse(
    z.object({ personId: z.number().int().positive(), move: z.boolean().default(false) }).strict(),
    req.body,
  );
  res.status(201).json(await cells.addMember(await viewerOf(req), id, personId, move));
});

t.delete('/cells/:id/members/:personId', 'celulas.editar', async (req, res) => {
  const { id, personId } = parse(MemberParam, req.params);
  res.json(await cells.removeMember(await viewerOf(req), id, personId));
});

// ───────────── Geocodificación ─────────────

t.get('/geocode/status', 'account-user', (_req, res) => {
  res.json({ enabled: geocodingEnabled() });
});

t.post(
  '/geocode',
  ['celulas.crear', 'celulas.editar', 'personas.editar', 'estructura.gestionar'],
  async (req, res) => {
    const { q } = parse(z.object({ q: z.string().trim().min(3).max(250) }).strict(), req.body);
    res.json({ items: await geocode(q) });
  },
);
