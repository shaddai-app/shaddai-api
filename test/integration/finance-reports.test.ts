import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../../src/core/time/local-date.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const today = () => todayIn('America/Argentina/Buenos_Aires');
const year = () => Number(today().slice(0, 4));

async function post(headers: Headers, url: string, body: object, status = 201) {
  const res = await request(app).post(api(url)).set(headers).send(body);
  if (res.status !== status) throw new Error(`${url}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
const get = async (headers: Headers, url: string) => {
  const res = await request(app).get(api(url)).set(headers);
  if (res.status !== 200) throw new Error(`${url}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
/** Descarga binaria (supertest no junta el cuerpo de un PDF o un Excel si no se le pide). */
const download = (headers: Headers, url: string) =>
  request(app)
    .get(api(url))
    .set(headers)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

async function categories(headers: Headers) {
  const res = await get(headers, '/finance/categories');
  const id = (kind: string, key: string) =>
    res.items.find((c: { kind: string; systemKey: string }) => c.kind === kind && c.systemKey === key)
      .id as number;
  return { tithe: id('income', 'tithe'), offering: id('income', 'offering'), rent: id('expense', 'rent') };
}

/** Iglesia con una caja en pesos y otra en dólares, y movimientos de este año (uno anulado). */
async function setup() {
  const c = await provisionChurch();
  // Del 1 de enero (o de hace 60 días si recién empieza el año) para tener dos meses de datos.
  const start = `${year()}-01-01` < addDays(today(), -60) ? `${year()}-01-01` : addDays(today(), -60);
  const ars = (
    await post(c.headers, '/finance/accounts', {
      name: 'Caja',
      type: 'cash',
      openingBalance: 1000,
      openingDate: start,
    })
  ).id;
  const usd = (
    await post(c.headers, '/finance/accounts', {
      name: 'Dólares',
      type: 'cash',
      currency: 'USD',
      openingDate: start,
    })
  ).id;
  const cat = await categories(c.headers);
  const person = (
    await post(c.headers, '/people', {
      firstName: 'Ana',
      lastName: 'Pérez',
      documentNumber: '30111222',
      allowDuplicate: true,
    })
  ).id;
  const move = (body: object) => post(c.headers, '/finance/movements', { date: today(), ...body });
  const tithe = await move({
    kind: 'income',
    financeAccountId: ars,
    categoryId: cat.tithe,
    amount: 5000,
    personId: person,
  });
  await move({ kind: 'income', financeAccountId: ars, categoryId: cat.offering, amount: 1200.5 });
  await move({ kind: 'expense', financeAccountId: ars, categoryId: cat.rent, amount: 3000 });
  await move({ kind: 'income', financeAccountId: usd, categoryId: cat.tithe, amount: 50, personId: person });
  const voided = await move({ kind: 'income', financeAccountId: ars, categoryId: cat.offering, amount: 999 });
  await post(c.headers, `/finance/movements/${voided.id}/void`, { reason: 'error' }, 200);
  return { ...c, ars, usd, cat, person, tithe: tithe.id as number };
}

describe('reportes de finanzas', () => {
  it('estado de resultados por categoría y moneda (sin anulados), en JSON, PDF y Excel', async () => {
    const s = await setup();
    const data = await get(s.headers, `/finance/reports/income-statement?from=${year()}-01-01&to=${today()}`);
    expect(data.currencies).toEqual([
      {
        currency: 'ARS',
        income: [
          { category: expect.objectContaining({ systemKey: 'tithe' }), amount: 5000 },
          { category: expect.objectContaining({ systemKey: 'offering' }), amount: 1200.5 },
        ],
        expense: [{ category: expect.objectContaining({ systemKey: 'rent' }), amount: 3000 }],
        totalIncome: 6200.5,
        totalExpense: 3000,
        net: 3200.5,
      },
      expect.objectContaining({ currency: 'USD', totalIncome: 50, net: 50 }),
    ]);
    const onlyUsd = await get(s.headers, `/finance/reports/income-statement?financeAccountId=${s.usd}`);
    expect(onlyUsd.currencies.map((c: { currency: string }) => c.currency)).toEqual(['USD']);

    const pdf = await download(s.headers, '/finance/reports/income-statement?format=pdf&lang=es');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('estado-de-resultados-');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const xlsx = await download(s.headers, '/finance/reports/income-statement?format=xlsx&lang=en');
    expect(xlsx.headers['content-disposition']).toContain('income-statement-');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.body as unknown as ArrayBuffer);
    const sheet = book.worksheets[0]!;
    expect(sheet.getCell('A2').value).toBe('Income statement');
    const values = sheet
      .getSheetValues()
      .flat()
      .filter((v) => typeof v === 'number');
    expect(values).toEqual(expect.arrayContaining([5000, 1200.5, 6200.5, 3000, 3200.5, 50]));
  });

  it('saldos a una fecha y evolución mensual por rubro', async () => {
    const s = await setup();
    const bal = await get(s.headers, '/finance/reports/balances');
    expect(bal.items).toEqual([
      expect.objectContaining({ name: 'Caja', currency: 'ARS', balance: 4200.5 }),
      expect.objectContaining({ name: 'Caja general', balance: 0 }), // la de la plantilla
      expect.objectContaining({ name: 'Dólares', currency: 'USD', balance: 50 }),
    ]);
    const before = await get(s.headers, `/finance/reports/balances?asOf=${addDays(today(), -1)}`);
    // Ayer: solo el saldo inicial, y sin la caja general (se abrió hoy).
    expect(before.items.map((i: { name: string; balance: number }) => [i.name, i.balance])).toEqual([
      ['Caja', 1000],
      ['Dólares', 0],
    ]);

    const trend = await get(s.headers, '/finance/reports/tithes-trend');
    const ars = trend.currencies.find((c: { currency: string }) => c.currency === 'ARS');
    const month = ars.months.find((m: { month: number }) => m.month === Number(today().slice(5, 7)));
    expect(month).toEqual({
      month: month.month,
      tithe: 5000,
      offering: 1200.5,
      otherIncome: 0,
      expense: 3000,
      net: 3200.5,
    });
    expect(ars.totals.net).toBe(3200.5);
    // Arranca en el primer mes con datos (todo es de este mes), no en enero en cero.
    expect(ars.months).toHaveLength(1);
    const pdf = await download(s.headers, '/finance/reports/tithes-trend?format=pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('aportes por persona: solo con diezmos nominales; el documento solo con datos sensibles', async () => {
    const s = await setup();
    const pastor = await actor({ 'finanzas.ver': 'all', 'finanzas.reportes': 'all' }, s.accountId);
    const treasurer = await actor(
      { 'finanzas.ver': 'all', 'finanzas.reportes': 'all', 'finanzas.diezmos_nominales': 'all' },
      s.accountId,
    );
    await request(app).get(api('/finance/reports/contributions')).set(pastor.headers).expect(403);
    // El pastor igual ve los reportes de totales.
    await request(app).get(api('/finance/reports/income-statement')).set(pastor.headers).expect(200);

    const data = await get(treasurer.headers, '/finance/reports/contributions');
    expect(data.items).toEqual([
      {
        person: { id: s.person, firstName: 'Ana', lastName: 'Pérez' },
        byCurrency: [
          { currency: 'ARS', tithe: 5000, other: 0, total: 5000, count: 1 },
          { currency: 'USD', tithe: 50, other: 0, total: 50, count: 1 },
        ],
      },
    ]);
    const owner = await get(s.headers, '/finance/reports/contributions');
    expect(owner.items[0].person.documentNumber).toBe('30111222');

    const xlsx = await download(treasurer.headers, '/finance/reports/contributions?format=xlsx');
    expect(xlsx.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'finance.report.contributions' } })).toBe(1);
  });

  it('aportes de la ficha, constancia anual y recibo', async () => {
    const s = await setup();
    const mine = await get(s.headers, `/people/${s.person}/contributions`);
    expect(mine).toMatchObject({
      year: year(),
      totals: [
        { currency: 'ARS', total: 5000 },
        { currency: 'USD', total: 50 },
      ],
    });
    expect(mine.movements).toHaveLength(2);
    expect(mine.years[0]).toBe(year());

    const cert = await download(s.headers, `/people/${s.person}/contributions/certificate?year=${year()}`);
    expect(cert.status).toBe(200);
    expect(cert.headers['content-disposition']).toContain(`constancia-de-aportes-${year()}-perez-ana.pdf`);
    expect(await prisma.auditLog.count({ where: { action: 'finance.certificate.issue' } })).toBe(1);

    const pastor = await actor({ 'finanzas.ver': 'all', 'finanzas.reportes': 'all' }, s.accountId);
    await request(app)
      .get(api(`/people/${s.person}/contributions`))
      .set(pastor.headers)
      .expect(403);

    const receipt = await download(s.headers, `/finance/movements/${s.tithe}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.headers['content-disposition']).toContain(`recibo-${s.tithe}.pdf`);
    // El pastor también puede sacar el recibo (sin el nombre del aportante).
    expect((await download(pastor.headers, `/finance/movements/${s.tithe}/receipt`)).status).toBe(200);
    const expense = await prisma.financeMovement.findFirstOrThrow({ where: { kind: 'expense' } });
    const notIncome = await request(app)
      .get(api(`/finance/movements/${expense.id}/receipt`))
      .set(s.headers);
    expect(notIncome.body.error.code).toBe('RECEIPT_NOT_AVAILABLE');

    // Otra iglesia no ve la persona ni el movimiento.
    const other = await provisionChurch();
    await request(app)
      .get(api(`/people/${s.person}/contributions`))
      .set(other.headers)
      .expect(404);
    await request(app)
      .get(api(`/finance/movements/${s.tithe}/receipt`))
      .set(other.headers)
      .expect(404);
  });
});
