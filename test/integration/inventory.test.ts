import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const code = (res: request.Response) => res.body.error?.code;
const send = (headers: Headers, method: 'post' | 'patch' | 'delete', url: string, body?: object) =>
  request(app)[method](api(url)).set(headers).send(body);
const get = (headers: Headers, url: string) => request(app).get(api(url)).set(headers);
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

async function setup() {
  const c = await provisionChurch();
  const categories = await prisma.catalogItem.findMany({
    where: { accountId: c.accountId, type: 'inventory_category' },
  });
  const cat = (key: string) => categories.find((x) => x.systemKey === key)!.id;
  return { c, audio: cat('audio'), video: cat('video') };
}

const tokenOf = (qrUrl: string) => qrUrl.split('/i/')[1]!;

describe('inventario', () => {
  it('equipos: código, búsqueda, estados, mantenimiento, QR, etiquetas y baja', async () => {
    const { c, audio, video } = await setup();

    const mixer = await send(c.headers, 'post', '/inventory/items', {
      name: 'Consola de sonido',
      categoryId: audio,
      brand: 'Behringer',
      model: 'X32',
      serialNumber: 'SN-123',
      purchaseDate: '2024-03-10',
      purchaseValue: 1500000.5,
      location: 'Cabina',
    });
    expect(mixer.status).toBe(201);
    expect(mixer.body).toMatchObject({
      code: 'EQ-0001',
      status: 'ok',
      category: { id: audio, systemKey: 'audio' },
      purchaseDate: '2024-03-10',
      purchaseValue: 1500000.5,
      maintenance: [],
      maintenanceCost: 0,
    });
    expect(mixer.body.qrUrl).toMatch(/\/i\/[A-Za-z0-9_-]{22}$/);
    expect(mixer.body).not.toHaveProperty('qrToken');

    const projector = (
      await send(c.headers, 'post', '/inventory/items', {
        code: 'proy-01',
        name: 'Proyector salón',
        categoryId: video,
        status: 'faulty',
      })
    ).body;
    expect(projector.code).toBe('PROY-01');
    expect(
      code(
        await send(c.headers, 'post', '/inventory/items', {
          code: 'PROY-01',
          name: 'Otro',
          categoryId: video,
        }),
      ),
    ).toBe('INVENTORY_CODE_IN_USE');
    const status = await prisma.catalogItem.findFirst({
      where: { accountId: c.accountId, type: 'person_status' },
    });
    expect(
      code(await send(c.headers, 'post', '/inventory/items', { name: 'Mal', categoryId: status!.id })),
    ).toBe('INVENTORY_CATEGORY_INVALID');

    // Búsqueda sin acentos ni mayúsculas, por marca o por código; conteos por estado.
    expect((await get(c.headers, '/inventory/items?q=CONSOLA behringer')).body.items).toHaveLength(1);
    expect((await get(c.headers, '/inventory/items?q=proyector')).body.items[0].id).toBe(projector.id);
    const all = (await get(c.headers, '/inventory/items')).body;
    expect(all.total).toBe(2);
    expect(all.counts).toEqual({ ok: 1, faulty: 1, repair: 0, retired: 0 });
    expect((await get(c.headers, `/inventory/items?categoryId=${video}`)).body.items).toHaveLength(1);

    // Dado de baja: no aparece salvo que se pida.
    await send(c.headers, 'patch', `/inventory/items/${projector.id}`, { status: 'retired' });
    expect((await get(c.headers, '/inventory/items')).body.total).toBe(1);
    expect((await get(c.headers, '/inventory/items?includeRetired=true')).body.total).toBe(2);
    expect((await get(c.headers, '/inventory/items?status=retired')).body.items[0].id).toBe(projector.id);

    // Edición: el código nuevo se valida y la búsqueda se actualiza.
    const edited = await send(c.headers, 'patch', `/inventory/items/${mixer.body.id}`, {
      code: 'MIX-01',
      brand: null,
      purchaseValue: null,
    });
    expect(edited.body).toMatchObject({ code: 'MIX-01', brand: null, purchaseValue: null, model: 'X32' });
    expect((await get(c.headers, '/inventory/items?q=behringer')).body.total).toBe(0);
    expect((await get(c.headers, '/inventory/items?q=mix-01')).body.total).toBe(1);

    // Mantenimiento: puede cambiar el estado del equipo; suma el costo.
    const repair = await send(c.headers, 'post', `/inventory/items/${mixer.body.id}/maintenance`, {
      date: '2026-09-01',
      type: 'repair',
      description: 'Cambio de fader',
      cost: 25000,
      vendor: 'Service Audio',
      status: 'repair',
    });
    expect(repair.status).toBe(201);
    expect(repair.body).toMatchObject({ status: 'repair', maintenanceCost: 25000 });
    const check = await send(c.headers, 'post', `/inventory/items/${mixer.body.id}/maintenance`, {
      date: '2026-09-15',
      type: 'check',
      description: 'Revisión general',
      cost: 5000.25,
      status: 'ok',
    });
    expect(check.body).toMatchObject({ status: 'ok', maintenanceCost: 30000.25 });
    expect(check.body.maintenance.map((m: { date: string }) => m.date)).toEqual(['2026-09-15', '2026-09-01']);
    expect(
      code(
        await send(c.headers, 'post', `/inventory/items/${mixer.body.id}/maintenance`, {
          date: '2026-09-15',
          type: 'broken',
          description: 'x',
        }),
      ),
    ).toBe('VALIDATION_ERROR');
    const afterDelete = await send(
      c.headers,
      'delete',
      `/inventory/maintenance/${check.body.maintenance[0].id}`,
    );
    expect(afterDelete.body).toMatchObject({ maintenanceCost: 25000, status: 'ok' });

    // QR: el token lleva al equipo.
    const token = tokenOf(mixer.body.qrUrl);
    expect((await get(c.headers, `/inventory/q/${token}`)).body).toEqual({ id: mixer.body.id });
    expect(code(await get(c.headers, `/inventory/q/${'x'.repeat(22)}`))).toBe('INVENTORY_ITEM_NOT_FOUND');

    // Etiquetas: una o varias en una hoja.
    const one = await download(c.headers, `/inventory/items/${mixer.body.id}/label.pdf`);
    expect(one.status).toBe(200);
    expect(one.headers['content-type']).toBe('application/pdf');
    expect((one.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const many = await download(c.headers, `/inventory/labels.pdf?ids=${mixer.body.id},${projector.id}`);
    expect(many.status).toBe(200);
    expect(code(await get(c.headers, '/inventory/labels.pdf?ids=999999'))).toBe('INVENTORY_ITEM_NOT_FOUND');

    // Una categoría propia en uso no se puede borrar.
    const kitchen = (await send(c.headers, 'post', '/catalogs/inventory_category', { name: 'Cocina' })).body;
    await send(c.headers, 'post', '/inventory/items', { name: 'Pava eléctrica', categoryId: kitchen.id });
    expect(code(await send(c.headers, 'delete', `/catalogs/inventory_category/${kitchen.id}`))).toBe(
      'CATALOG_IN_USE',
    );

    // Baja: desaparece, el QR deja de andar y el código queda libre.
    expect((await send(c.headers, 'delete', `/inventory/items/${mixer.body.id}`)).status).toBe(204);
    expect(code(await get(c.headers, `/inventory/items/${mixer.body.id}`))).toBe('INVENTORY_ITEM_NOT_FOUND');
    expect(code(await get(c.headers, `/inventory/q/${token}`))).toBe('INVENTORY_ITEM_NOT_FOUND');
    const reused = await send(c.headers, 'post', '/inventory/items', {
      code: 'MIX-01',
      name: 'Consola nueva',
      categoryId: audio,
    });
    expect(reused.status).toBe(201);
    // El siguiente código automático no pisa a los existentes.
    const auto = await send(c.headers, 'post', '/inventory/items', { name: 'Micrófono', categoryId: audio });
    expect(auto.body.code).toMatch(/^EQ-\d{4}$/);
  });

  it('permisos: ver sin gestionar, fotos y otra iglesia', async () => {
    const { c, audio } = await setup();
    const item = (await send(c.headers, 'post', '/inventory/items', { name: 'Parlante', categoryId: audio }))
      .body;
    const png = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 20, g: 80, b: 160 } },
    })
      .png()
      .toBuffer();
    const upload = await request(app)
      .post(api(`/inventory/items/${item.id}/photo`))
      .set(c.headers)
      .attach('file', png, 'parlante.png');
    expect(upload.status).toBe(201);
    const fileId = upload.body.photoFileId;
    expect((await get(c.headers, `/inventory/items/${item.id}`)).body.photoFileId).toBe(fileId);

    const viewer = await actor({ 'inventario.ver': 'all' }, c.accountId);
    expect((await get(viewer.headers, '/inventory/items')).body.total).toBe(1);
    expect((await get(viewer.headers, `/inventory/q/${tokenOf(item.qrUrl)}`)).body).toEqual({ id: item.id });
    expect((await get(viewer.headers, `/files/${fileId}`)).status).toBe(200);
    expect(
      (await send(viewer.headers, 'post', '/inventory/items', { name: 'X', categoryId: audio })).status,
    ).toBe(403);
    expect((await send(viewer.headers, 'patch', `/inventory/items/${item.id}`, { name: 'X' })).status).toBe(
      403,
    );
    expect((await get(viewer.headers, `/inventory/items/${item.id}/label.pdf`)).status).toBe(403);

    const nobody = await actor({}, c.accountId);
    expect((await get(nobody.headers, '/inventory/items')).status).toBe(403);
    expect((await get(nobody.headers, `/files/${fileId}`)).status).toBe(404);

    // Otra iglesia: ni la ficha ni el QR.
    const other = await provisionChurch();
    expect(code(await get(other.headers, `/inventory/items/${item.id}`))).toBe('INVENTORY_ITEM_NOT_FOUND');
    expect(code(await get(other.headers, `/inventory/q/${tokenOf(item.qrUrl)}`))).toBe(
      'INVENTORY_ITEM_NOT_FOUND',
    );
    expect(
      code(await send(other.headers, 'post', '/inventory/items', { name: 'X', categoryId: audio })),
    ).toBe('INVENTORY_CATEGORY_INVALID');

    // Quitar la foto la borra.
    expect((await send(c.headers, 'delete', `/inventory/items/${item.id}/photo`)).status).toBe(204);
    expect((await get(c.headers, `/files/${fileId}`)).status).toBe(404);
  });
});
