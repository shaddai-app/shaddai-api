import { z } from 'zod';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { viewerOf } from '../people/people.scope.js';
import * as reports from './reports.service.js';

const t = tenantRouter();
/** Montar ANTES de cellsRouter: "/cells/genealogy" coincidiría con "/cells/:id". */
export const cellReportsRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });

t.get('/cells/genealogy', 'celulas.ver', async (req, res) => {
  res.json(await reports.genealogy(await viewerOf(req)));
});

t.get('/cells/:id/reports', 'celulas.ver_reportes', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const query = parse(reports.ListReportsQuery, req.query);
  res.json(await reports.listReports(await viewerOf(req), { ...query, cellId: id }));
});

t.post('/cells/:id/reports', 'celulas.reportar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(reports.CreateReportSchema, req.body);
  res.status(201).json(await reports.createReport(await viewerOf(req), id, input));
});

t.post('/cells/:id/multiply', 'celulas.multiplicar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(reports.MultiplySchema, req.body);
  res.status(201).json(await reports.multiplyCell(await viewerOf(req), id, input));
});

t.get('/cell-reports', 'celulas.ver_reportes', async (req, res) => {
  res.json(await reports.listReports(await viewerOf(req), parse(reports.ListReportsQuery, req.query)));
});

// Antes de /cell-reports/:id.
t.get('/cell-reports/compliance', 'celulas.ver_reportes', async (req, res) => {
  const query = parse(
    z.object({
      week: z.iso.date().optional(),
      zoneId: z.coerce.number().int().positive().optional(),
      networkId: z.coerce.number().int().positive().optional(),
    }),
    req.query,
  );
  res.json(await reports.compliance(await viewerOf(req), query));
});

t.get('/cell-reports/:id', ['celulas.ver_reportes', 'celulas.reportar'], async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await reports.getReport(await viewerOf(req), id));
});

t.patch('/cell-reports/:id', 'celulas.reportar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(reports.UpdateReportSchema, req.body);
  res.json(await reports.updateReport(await viewerOf(req), id, input));
});

t.delete('/cell-reports/:id', 'celulas.reportar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await reports.deleteReport(await viewerOf(req), id);
  res.status(204).end();
});
