import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/core/excel/spreadsheet.js';
import { parseSheetDate } from '../../src/modules/people/people.import.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;

async function xlsx(rows: (string | number | Date | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja 1');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function readXlsx(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const rows: unknown[][] = [];
  wb.worksheets[0]!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  return rows;
}

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

function upload(headers: Headers, file: Buffer, name: string) {
  return request(app).post(api('/people/import')).set(headers).attach('file', file, name);
}

describe('utilidades de planilla', () => {
  it('interpreta fechas argentinas, ISO, de Excel y rechaza las inválidas', () => {
    expect(parseSheetDate('17/05/1990')).toBe('1990-05-17');
    expect(parseSheetDate('5-3-85')).toBe('1985-03-05');
    expect(parseSheetDate('01/02/05')).toBe('2005-02-01');
    expect(parseSheetDate('1990-05-17')).toBe('1990-05-17');
    expect(parseSheetDate('05/25/1990')).toBe('1990-05-25'); // segundo número > 12 → mm/dd
    expect(parseSheetDate(new Date(Date.UTC(2001, 0, 31)))).toBe('2001-01-31');
    expect(parseSheetDate('33000')).toBe('1990-05-07'); // =FECHA(1990;5;7) en Excel
    expect(parseSheetDate('31/02/2000')).toBe('invalid');
    expect(parseSheetDate('ayer')).toBe('invalid');
    expect(parseSheetDate(null)).toBeNull();
  });

  it('parsea CSV con ; , comillas y saltos de línea', () => {
    expect(parseCsv('a;b;c\r\n1;"dos; tres";"con ""comillas"""\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'dos; tres', 'con "comillas"'],
    ]);
    expect(parseCsv('x,y\n"multi\nlínea",2')).toEqual([
      ['x', 'y'],
      ['multi\nlínea', '2'],
    ]);
  });
});

describe('importación de personas', () => {
  it('500 filas: vista previa con errores por fila y confirmación', async () => {
    const church = await provisionChurch();
    await request(app)
      .post(api('/people'))
      .set(church.headers)
      .send({ firstName: 'Ya', lastName: 'Existe', phone: '11 5555 0003' });
    await request(app).post(api('/tags')).set(church.headers).send({ name: 'Coro' });

    const header = [
      'Nombre',
      'Apellido',
      'Teléfono',
      'E-mail',
      'Fecha de nacimiento',
      'Estado',
      'Etiquetas',
      'Columna rara',
    ];
    const data: (string | Date | null)[][] = Array.from({ length: 500 }, (_, i) => [
      `Persona${i}`,
      `Apellido${i}`,
      `11 5555 ${String(i).padStart(4, '0')}`,
      null,
      new Date(Date.UTC(1980 + (i % 30), i % 12, 1 + (i % 28))),
      i % 2 ? 'Miembro' : 'visitante',
      i % 10 === 0 ? 'coro, Jóvenes' : null,
      'x',
    ]);
    data[10]![1] = null; // sin apellido → error
    data[20]![4] = '31/02/1990'; // fecha inválida → error
    data[30]![4] = '01/01/2999'; // futura → error
    data[40]![3] = 'no-es-email'; // email inválido → error
    data[50]![5] = 'Desconocido'; // estado desconocido → advertencia (estado por defecto)
    data[60]![2] = data[61]![2]!; // teléfono repetido en el archivo → advertencia
    // Fila 4 (índice 3) tiene el teléfono de la persona existente → duplicado.

    const preview = await upload(church.headers, await xlsx([header, ...data]), 'miembros.xlsx');
    expect(preview.status).toBe(201);
    expect(preview.body.summary).toMatchObject({
      total: 500,
      valid: 496,
      withErrors: 4,
      duplicates: 1,
      newTags: ['Jóvenes'],
      unknownColumns: ['Columna rara'],
      ignoredColumns: [],
    });
    const byRow = new Map(preview.body.rows.map((r: { row: number }) => [r.row, r]));
    // Fila de Excel = índice + 2 (encabezado en la fila 1).
    expect((byRow.get(12) as { errors: unknown[] }).errors).toEqual([
      { field: 'lastName', code: 'REQUIRED' },
    ]);
    expect((byRow.get(22) as { errors: unknown[] }).errors).toEqual([
      { field: 'birthDate', code: 'INVALID_DATE', value: '31/02/1990' },
    ]);
    expect((byRow.get(32) as { errors: { code: string }[] }).errors[0]!.code).toBe('DATE_IN_FUTURE');
    expect((byRow.get(42) as { errors: { code: string }[] }).errors[0]!.code).toBe('INVALID_EMAIL');
    expect((byRow.get(52) as { warnings: unknown[] }).warnings).toEqual([
      { field: 'status', code: 'UNKNOWN_STATUS', value: 'Desconocido' },
    ]);
    expect((byRow.get(63) as { warnings: { code: string }[] }).warnings[0]!.code).toBe('DUPLICATE_IN_FILE');
    expect((byRow.get(5) as { duplicate: unknown }).duplicate).toMatchObject({
      firstName: 'Ya',
      reasons: ['phone'],
    });
    expect((byRow.get(2) as { data: { tags: string[]; phone: string } }).data).toMatchObject({
      tags: ['Coro', 'Jóvenes'],
      phone: '1155550000',
    });

    const started = Date.now();
    const commit = await request(app)
      .post(api(`/people/import/${preview.body.id}/commit`))
      .set(church.headers)
      .send({ duplicates: 'skip' });
    expect(commit.status).toBe(200);
    expect(commit.body.summary).toMatchObject({ created: 495, skipped: 5 });
    expect(Date.now() - started).toBeLessThan(60_000);

    expect(await prisma.person.count({ where: { accountId: church.accountId, source: 'import' } })).toBe(495);
    expect(await prisma.personStatusHistory.count({ where: { accountId: church.accountId } })).toBe(496);
    const member = await prisma.person.findFirstOrThrow({
      where: { firstName: 'Persona1', accountId: church.accountId },
      include: { status: true },
    });
    expect(member.status.systemKey).toBe('member');
    expect(member.searchText).toBe('persona1 apellido1');
    const youth = await prisma.tag.findFirstOrThrow({
      where: { accountId: church.accountId, name: 'Jóvenes' },
      include: { _count: { select: { people: true } } },
    });
    expect(youth._count.people).toBe(46); // 50 múltiplos de 10, menos las 4 filas con error

    const job = await prisma.importJob.findUniqueOrThrow({ where: { id: preview.body.id } });
    expect(job).toMatchObject({ status: 'committed', rows: '[]' });
    const again = await request(app)
      .post(api(`/people/import/${preview.body.id}/commit`))
      .set(church.headers)
      .send({});
    expect(again.body.error.code).toBe('IMPORT_ALREADY_COMMITTED');
    expect(await prisma.auditLog.count({ where: { action: 'people.import' } })).toBe(1);
  }, 120_000);

  it('lee CSV de Excel en castellano (Windows-1252, ";") y crea duplicados si se pide', async () => {
    const church = await provisionChurch();
    await request(app)
      .post(api('/people'))
      .set(church.headers)
      .send({ firstName: 'Ana', lastName: 'Núñez', email: 'ana@x.com' });
    const csv =
      'Nombre;Apellido;Correo;Nacimiento;Género\r\nAna;Núñez;ana@x.com;3/4/88;F\r\nJosé;Peña;;;varón\r\n';
    const buffer = Buffer.from(csv, 'latin1'); // como lo guarda Excel en Windows en castellano
    const preview = await upload(church.headers, buffer, 'personas.csv');
    expect(preview.status).toBe(201);
    expect(preview.body.rows.map((r: { data: object }) => r.data)).toMatchObject([
      { firstName: 'Ana', lastName: 'Núñez', birthDate: '1988-04-03', gender: 'F' },
      { firstName: 'José', lastName: 'Peña', gender: 'M' },
    ]);
    const commit = await request(app)
      .post(api(`/people/import/${preview.body.id}/commit`))
      .set(church.headers)
      .send({ duplicates: 'create' });
    expect(commit.body.summary.created).toBe(2);
  });

  it('sin columnas obligatorias → 400; sensibles ignoradas sin permiso; solo el autor ve su importación', async () => {
    const church = await provisionChurch();
    const noLast = await upload(church.headers, await xlsx([['Nombre'], ['Ana']]), 'x.xlsx');
    expect(noLast.body.error).toMatchObject({
      code: 'IMPORT_MISSING_COLUMNS',
      details: { missing: ['lastName'] },
    });

    const importer = await actor({ 'personas.importar': 'all' }, church.accountId);
    const file = await xlsx([
      ['Nombre', 'Apellido', 'DNI', 'Dirección'],
      ['Ana', 'Sosa', '30.111.222', 'Mitre 1'],
    ]);
    const preview = await upload(importer.headers, file, 'x.xlsx');
    expect(preview.body.summary.ignoredColumns).toEqual(['DNI', 'Dirección']);
    expect(preview.body.rows[0].data).toMatchObject({ documentNumber: null, address: null });

    expect(
      (
        await request(app)
          .get(api(`/people/import/${preview.body.id}`))
          .set(church.headers)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get(api(`/people/import/${preview.body.id}`))
          .set(importer.headers)
      ).status,
    ).toBe(200);
  });

  it('rechaza archivos que no son planillas', async () => {
    const church = await provisionChurch();
    const res = await upload(church.headers, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'roto.xlsx');
    expect(res.body.error.code).toBe('IMPORT_FILE_UNREADABLE');
  });

  it('descarga la plantilla en el idioma pedido', async () => {
    const church = await provisionChurch();
    const res = await request(app)
      .get(api('/people/import/template?locale=pt'))
      .set(church.headers)
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    const rows = await readXlsx(res.body as Buffer);
    expect(rows[0]!.slice(0, 3)).toEqual(['Nome', 'Sobrenome', 'Apelido']);
    expect(rows[1]![0]).toBe('João');
  });
});

describe('exportación', () => {
  it('exporta con filtros; los sensibles solo con permiso total', async () => {
    const church = await provisionChurch();
    const tag = await request(app).post(api('/tags')).set(church.headers).send({ name: 'Coro' });
    await request(app)
      .post(api('/people'))
      .set(church.headers)
      .send({
        firstName: 'Ana',
        lastName: 'Sosa',
        documentNumber: '30111222',
        birthDate: '1990-05-17',
        gender: 'F',
        tagIds: [tag.body.id],
      });
    await request(app).post(api('/people')).set(church.headers).send({ firstName: 'Beto', lastName: 'Paz' });

    const full = await request(app)
      .get(api(`/people/export?tagId=${tag.body.id}`))
      .set(church.headers)
      .buffer(true)
      .parse(binary);
    const rows = await readXlsx(full.body as Buffer);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Documento');
    const doc = rows[0]!.indexOf('Documento');
    expect(rows[1]![doc]).toBe('30111222');
    expect(rows[1]![rows[0]!.indexOf('Género')]).toBe('Femenino');
    expect(rows[1]![rows[0]!.indexOf('Estado')]).toBe('Visitante');
    expect(rows[1]![rows[0]!.indexOf('Etiquetas')]).toBe('Coro');

    const exporter = await actor({ 'personas.ver': 'all', 'personas.exportar': 'all' }, church.accountId);
    const csv = await request(app).get(api('/people/export?format=csv&locale=en')).set(exporter.headers);
    expect(csv.headers['content-type']).toContain('text/csv');
    const [head, ...lines] = parseCsv(
      csv.text.replace(new RegExp('^' + String.fromCharCode(0xfeff)), ''),
    ).filter((r) => r.length > 1);
    expect(head).not.toContain('ID number');
    expect(head!.slice(0, 2)).toEqual(['First name', 'Last name']);
    expect(lines.map((l) => l[0])).toEqual(['Beto', 'Ana']);
    expect(csv.text).not.toContain('30111222');
    expect(await prisma.auditLog.count({ where: { action: 'people.export' } })).toBe(2);
  });
});

describe('formulario público "Soy nuevo"', () => {
  const body = {
    firstName: 'Lucía',
    lastName: 'Méndez',
    phone: '11 4000 1234',
    howHeard: 'Una amiga',
    prayer: 'Por la salud de mi mamá',
    wantsVisit: true,
    consent: true,
  };

  async function slugOf(accountId: number) {
    return (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).slug;
  }

  it('el envío aparece en la bandeja y al aceptarlo crea la persona', async () => {
    const church = await provisionChurch();
    const slug = await slugOf(church.accountId);

    const config = await request(app).get(api(`/public/${slug}/newcomer-form`));
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({ church: { slug, logoUrl: null }, consentVersion: '2026-09' });

    const sent = await request(app)
      .post(api(`/public/${slug}/newcomer`))
      .send(body);
    expect(sent.status).toBe(201);

    const inbox = await request(app).get(api('/newcomers')).set(church.headers);
    expect(inbox.body).toMatchObject({
      pendingCount: 1,
      total: 1,
      items: [{ firstName: 'Lucía', phone: '1140001234' }],
    });
    const id = inbox.body.items[0].id;
    const detail = await request(app)
      .get(api(`/newcomers/${id}`))
      .set(church.headers);
    expect(detail.body.duplicates).toMatchObject({ items: [], strong: false });

    const accepted = await request(app)
      .post(api(`/newcomers/${id}/accept`))
      .set(church.headers)
      .send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'accepted', reviewedById: church.ownerId });
    const person = await prisma.person.findUniqueOrThrow({ where: { id: accepted.body.personId } });
    expect(person).toMatchObject({
      source: 'form',
      firstName: 'Lucía',
      phone: '1140001234',
      consentVersion: '2026-09',
      notes: 'Cómo nos conoció: Una amiga\nPidió que lo visiten',
      pastoralNotes: 'Pedido de oración (formulario): Por la salud de mi mamá',
    });
    expect(person.consentAt).not.toBeNull();
    expect(person.firstVisitAt).not.toBeNull();

    const twice = await request(app)
      .post(api(`/newcomers/${id}/accept`))
      .set(church.headers)
      .send({});
    expect(twice.body.error.code).toBe('NEWCOMER_ALREADY_REVIEWED');
    expect((await request(app).get(api('/newcomers')).set(church.headers)).body.pendingCount).toBe(0);
  });

  it('vincular a una ficha existente solo completa lo que falta', async () => {
    const church = await provisionChurch();
    const slug = await slugOf(church.accountId);
    const existing = await request(app).post(api('/people')).set(church.headers).send({
      firstName: 'Lucía',
      lastName: 'Méndez',
      phone: '11 4000 1234',
      city: 'Bernal',
      notes: 'Previa',
    });
    await request(app)
      .post(api(`/public/${slug}/newcomer`))
      .send({ ...body, email: 'lucia@mail.com', city: 'Quilmes' });
    const [item] = (await request(app).get(api('/newcomers')).set(church.headers)).body.items;
    const detail = await request(app)
      .get(api(`/newcomers/${item.id}`))
      .set(church.headers);
    expect(detail.body.duplicates).toMatchObject({ strong: true, items: [{ id: existing.body.id }] });

    const blocked = await request(app)
      .post(api(`/newcomers/${item.id}/accept`))
      .set(church.headers)
      .send({});
    expect(blocked.body.error.code).toBe('PERSON_DUPLICATE_SUSPECTED');

    await request(app)
      .post(api(`/newcomers/${item.id}/accept`))
      .set(church.headers)
      .send({ personId: existing.body.id });
    const person = await prisma.person.findUniqueOrThrow({ where: { id: existing.body.id } });
    expect(person).toMatchObject({
      city: 'Bernal',
      email: 'lucia@mail.com',
      notes: 'Previa\n\nCómo nos conoció: Una amiga\nPidió que lo visiten',
    });
  });

  it('rechazos, trampa para bots, validaciones e iglesias suspendidas', async () => {
    const church = await provisionChurch();
    const slug = await slugOf(church.accountId);

    const noContact = await request(app)
      .post(api(`/public/${slug}/newcomer`))
      .send({ ...body, phone: '' });
    expect(noContact.status).toBe(400);
    const noConsent = await request(app)
      .post(api(`/public/${slug}/newcomer`))
      .send({ ...body, consent: false });
    expect(noConsent.status).toBe(400);

    const bot = await request(app)
      .post(api(`/public/${slug}/newcomer`))
      .send({ ...body, website: 'http://spam' });
    expect(bot.status).toBe(201);
    expect(await prisma.newcomerSubmission.count()).toBe(0);

    await request(app)
      .post(api(`/public/${slug}/newcomer`))
      .send(body);
    const [item] = (await request(app).get(api('/newcomers')).set(church.headers)).body.items;
    const rejected = await request(app)
      .post(api(`/newcomers/${item.id}/reject`))
      .set(church.headers)
      .send({});
    expect(rejected.body.status).toBe('rejected');
    const list = await request(app).get(api('/newcomers?status=rejected')).set(church.headers);
    expect(list.body.total).toBe(1);

    await prisma.account.update({ where: { id: church.accountId }, data: { status: 'suspended' } });
    expect((await request(app).get(api(`/public/${slug}/newcomer-form`))).status).toBe(404);
    expect(
      (
        await request(app)
          .post(api(`/public/${slug}/newcomer`))
          .send(body)
      ).status,
    ).toBe(404);
    expect((await request(app).get(api('/public/no-existe/newcomer-form'))).status).toBe(404);
  });

  it('la bandeja es de cada iglesia', async () => {
    const a = await provisionChurch();
    const b = await provisionChurch();
    await request(app)
      .post(api(`/public/${await slugOf(b.accountId)}/newcomer`))
      .send(body);
    expect((await request(app).get(api('/newcomers')).set(a.headers)).body.total).toBe(0);
    const foreign = await prisma.newcomerSubmission.findFirstOrThrow();
    expect(
      (
        await request(app)
          .post(api(`/newcomers/${foreign.id}/accept`))
          .set(a.headers)
          .send({})
      ).status,
    ).toBe(404);
  });
});

describe('búsqueda global', () => {
  it('encuentra personas sin importar acentos y respeta permisos', async () => {
    const church = await provisionChurch();
    await request(app)
      .post(api('/people'))
      .set(church.headers)
      .send({ firstName: 'Martín', lastName: 'Ibáñez' });
    const all = await request(app).get(api('/search?q=martin ibanez')).set(church.headers);
    expect(all.body.people).toMatchObject([{ firstName: 'Martín', status: { systemKey: 'visitor' } }]);
    const owner = await request(app).get(api('/search?q=Dueño')).set(church.headers);
    expect(owner.body.users).toHaveLength(1);

    const nobody = await actor({}, church.accountId);
    const none = await request(app).get(api('/search?q=martin')).set(nobody.headers);
    expect(none.body).toEqual({ people: [], households: [], users: [] });
    expect((await request(app).get(api('/search?q=m')).set(church.headers)).status).toBe(400);
  });
});
