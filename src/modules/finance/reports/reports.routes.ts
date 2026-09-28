import type { Response } from 'express';
import { z } from 'zod';
import { audit } from '../../../core/audit/audit.js';
import { tenantRouter } from '../../../core/http/secure-router.js';
import { parse } from '../../../core/http/validate.js';
import { viewerOf } from '../../people/people.scope.js';
import type { ReportLocale } from './labels.js';
import { formatter } from './render.js';
import * as out from './reports.output.js';
import * as reports from './reports.service.js';

const t = tenantRouter();
export const financeReportsRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const Output = z.object({ format: reports.ReportFormat, lang: reports.ReportLang });

const MIME = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

function send(res: Response, format: 'pdf' | 'xlsx', file: { buffer: Buffer; filename: string }) {
  res.attachment(file.filename).type(MIME[format]).setHeader('Cache-Control', 'no-store');
  res.send(file.buffer);
}

/** Idioma del archivo: el que pide el usuario o el de la iglesia. */
async function context(lang: ReportLocale | undefined) {
  const church = await reports.churchInfo();
  const locale =
    lang ??
    ((['es', 'en', 'pt'].includes(church.defaultLocale) ? church.defaultLocale : 'es') as ReportLocale);
  return { church, fmt: formatter(locale) };
}

/**
 * Un reporte en JSON (pantalla), PDF o Excel. Las descargas de datos nominales quedan auditadas.
 */
function report<Q extends z.ZodType, D>(
  path: string,
  query: Q,
  load: (req: Parameters<Parameters<typeof t.get>[2]>[0], q: z.infer<Q>) => Promise<D>,
  pdf: (
    fmt: ReturnType<typeof formatter>,
    church: Awaited<ReturnType<typeof reports.churchInfo>>,
    data: D,
  ) => Promise<{ buffer: Buffer; filename: string }>,
  xlsx: typeof pdf,
  auditName?: string,
) {
  t.get(`/finance/reports/${path}`, 'finanzas.reportes', async (req, res) => {
    const { format, lang, ...rest } = parse(Output.and(query), req.query) as z.infer<typeof Output> &
      z.infer<Q>;
    const data = await load(req, rest as z.infer<Q>);
    if (format === 'json') {
      res.json(data);
      return;
    }
    const { church, fmt } = await context(lang);
    if (auditName) await audit({ action: auditName, entity: 'FinanceReport', after: { format, ...rest } });
    send(res, format, await (format === 'pdf' ? pdf : xlsx)(fmt, church, data));
  });
}

report(
  'income-statement',
  reports.IncomeStatementQuery,
  (_req, q) => reports.incomeStatement(q),
  out.incomeStatementPdf,
  out.incomeStatementXlsx,
);
report(
  'balances',
  reports.BalancesQuery,
  (_req, q) => reports.balancesReport(q),
  out.balancesPdf,
  out.balancesXlsx,
);
report('tithes-trend', reports.TrendQuery, (_req, q) => reports.monthlyTrend(q), out.trendPdf, out.trendXlsx);
report(
  'contributions',
  reports.ContributionsQuery,
  async (req, q) => reports.contributions(await viewerOf(req), q),
  out.contributionsPdf,
  out.contributionsXlsx,
  'finance.report.contributions',
);

// ───────────── Aportes de una persona (ficha) ─────────────

const YearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

t.get('/people/:id/contributions', 'finanzas.diezmos_nominales', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { year } = parse(YearQuery, req.query);
  res.json(await reports.personContributions(await viewerOf(req), id, year));
});

t.get('/people/:id/contributions/certificate', 'finanzas.diezmos_nominales', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { year, lang } = parse(YearQuery.extend({ lang: reports.ReportLang }), req.query);
  const data = await reports.personContributions(await viewerOf(req), id, year);
  const { church, fmt } = await context(lang);
  await audit({
    action: 'finance.certificate.issue',
    entity: 'Person',
    entityId: id,
    after: { year: data.year },
  });
  send(res, 'pdf', await out.certificatePdf(fmt, church, data));
});

// ───────────── Recibo ─────────────

t.get('/finance/movements/:id/receipt', 'finanzas.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { lang } = parse(z.object({ lang: reports.ReportLang }), req.query);
  const data = await reports.receiptData(await viewerOf(req), id);
  const { church, fmt } = await context(lang);
  send(res, 'pdf', await out.receiptPdf(fmt, church, data));
});
