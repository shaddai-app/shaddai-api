import request from 'supertest';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;

async function catalog(accountId: number, type: string, systemKey: string) {
  return prisma.catalogItem.findFirstOrThrow({ where: { accountId, type, systemKey } });
}

async function createPerson(headers: Headers, body: Record<string, unknown>) {
  const res = await request(app).post(api('/people')).set(headers).send(body);
  if (res.status !== 201) throw new Error(`Alta falló: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: number } & Record<string, unknown>;
}

describe('catálogos', () => {
  it('lista los catálogos sembrados y permite renombrar, crear, ordenar y desactivar', async () => {
    const church = await provisionChurch();
    const list = await request(app).get(api('/catalogs/person_status')).set(church.headers);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { systemKey: string }) => i.systemKey)).toEqual([
      'visitor',
      'new',
      'attendee',
      'member',
      'inactive',
      'transferred',
      'deceased',
    ]);

    const visitor = list.body.items[0];
    const renamed = await request(app)
      .patch(api(`/catalogs/person_status/${visitor.id}`))
      .set(church.headers)
      .send({ name: 'Amigo', color: 'teal' });
    expect(renamed.body).toMatchObject({ name: 'Amigo', systemKey: 'visitor', color: 'teal' });
    const back = await request(app)
      .patch(api(`/catalogs/person_status/${visitor.id}`))
      .set(church.headers)
      .send({ name: null });
    expect(back.body.name).toBeNull();

    const custom = await request(app)
      .post(api('/catalogs/milestone'))
      .set(church.headers)
      .send({ name: 'Retiro de parejas' });
    expect(custom.status).toBe(201);
    expect(custom.body).toMatchObject({ systemKey: null, name: 'Retiro de parejas', sortOrder: 70 });
    const noName = await request(app)
      .patch(api(`/catalogs/milestone/${custom.body.id}`))
      .set(church.headers)
      .send({ name: null });
    expect(noName.body.error.code).toBe('CATALOG_NAME_REQUIRED');

    const ids = list.body.items.map((i: { id: number }) => i.id).reverse();
    const reordered = await request(app)
      .put(api('/catalogs/person_status/order'))
      .set(church.headers)
      .send({ ids });
    expect(reordered.body.items.map((i: { id: number }) => i.id)).toEqual(ids);

    const inactive = await request(app)
      .patch(api(`/catalogs/person_status/${visitor.id}`))
      .set(church.headers)
      .send({ isActive: false });
    expect(inactive.body.isActive).toBe(false);
    const active = await request(app).get(api('/catalogs/person_status')).set(church.headers);
    expect(active.body.items).toHaveLength(6);
    const all = await request(app)
      .get(api('/catalogs/person_status?includeInactive=true'))
      .set(church.headers);
    expect(all.body.items).toHaveLength(7);
  });

  it('no se borran ítems del sistema ni en uso, y siempre queda un estado activo', async () => {
    const church = await provisionChurch();
    const member = await catalog(church.accountId, 'person_status', 'member');
    const sys = await request(app)
      .delete(api(`/catalogs/person_status/${member.id}`))
      .set(church.headers);
    expect(sys.body.error.code).toBe('CATALOG_SYSTEM_ITEM');

    const custom = await request(app)
      .post(api('/catalogs/person_status'))
      .set(church.headers)
      .send({ name: 'En pausa' });
    await createPerson(church.headers, { firstName: 'Ana', lastName: 'Gómez', statusId: custom.body.id });
    const inUse = await request(app)
      .delete(api(`/catalogs/person_status/${custom.body.id}`))
      .set(church.headers);
    expect(inUse.body.error.code).toBe('CATALOG_IN_USE');

    const unused = await request(app)
      .post(api('/catalogs/position'))
      .set(church.headers)
      .send({ name: 'Obrero' });
    expect(
      (
        await request(app)
          .delete(api(`/catalogs/position/${unused.body.id}`))
          .set(church.headers)
      ).status,
    ).toBe(204);

    await prisma.catalogItem.updateMany({
      where: { accountId: church.accountId, type: 'person_status', id: { not: member.id } },
      data: { isActive: false },
    });
    const last = await request(app)
      .patch(api(`/catalogs/person_status/${member.id}`))
      .set(church.headers)
      .send({ isActive: false });
    expect(last.body.error.code).toBe('CATALOG_LAST_ACTIVE_STATUS');
  });

  it('una cuenta no toca catálogos de otra', async () => {
    const a = await provisionChurch();
    const b = await provisionChurch();
    const foreign = await catalog(b.accountId, 'milestone', 'conversion');
    const res = await request(app)
      .patch(api(`/catalogs/milestone/${foreign.id}`))
      .set(a.headers)
      .send({ name: 'x' });
    expect(res.status).toBe(404);
    const wrongType = await catalog(a.accountId, 'milestone', 'conversion');
    const asStatus = await request(app)
      .patch(api(`/catalogs/person_status/${wrongType.id}`))
      .set(a.headers)
      .send({ name: 'x' });
    expect(asStatus.status).toBe(404);
  });
});

describe('etiquetas', () => {
  it('nombre único por cuenta y conteo de personas', async () => {
    const church = await provisionChurch();
    const tag = await request(app)
      .post(api('/tags'))
      .set(church.headers)
      .send({ name: 'Jóvenes', color: 'grape' });
    expect(tag.status).toBe(201);
    const dup = await request(app).post(api('/tags')).set(church.headers).send({ name: 'Jóvenes' });
    expect(dup.body.error.code).toBe('TAG_NAME_IN_USE');

    await createPerson(church.headers, { firstName: 'Lucas', lastName: 'Díaz', tagIds: [tag.body.id] });
    const list = await request(app).get(api('/tags')).set(church.headers);
    expect(list.body.items).toEqual([{ id: tag.body.id, name: 'Jóvenes', color: 'grape', peopleCount: 1 }]);

    const other = await provisionChurch();
    const sameName = await request(app).post(api('/tags')).set(other.headers).send({ name: 'Jóvenes' });
    expect(sameName.status).toBe(201);
  });
});

describe('personas: alta, búsqueda y ficha', () => {
  it('alta con estado por defecto, historial inicial y teléfono/documento normalizados', async () => {
    const church = await provisionChurch();
    const person = await createPerson(church.headers, {
      firstName: '  Juan ',
      lastName: 'Pérez',
      phone: '+54 9 (11) 5555-1234',
      documentNumber: '30.123.456',
      birthDate: '1990-05-17',
      consent: true,
    });
    expect(person).toMatchObject({
      firstName: 'Juan',
      phone: '+5491155551234',
      documentNumber: '30123456',
      birthDate: '1990-05-17',
      source: 'manual',
      consentVersion: '2026-09',
      status: { systemKey: 'visitor' },
      access: { edit: true, sensitive: true, delete: true, merge: true },
    });
    const history = await prisma.personStatusHistory.findMany({ where: { personId: person.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatusId: null,
      toStatusId: (person.status as { id: number }).id,
    });
  });

  it('busca por varias palabras y filtra por estado y etiqueta', async () => {
    const church = await provisionChurch();
    const member = await catalog(church.accountId, 'person_status', 'member');
    const tag = await request(app).post(api('/tags')).set(church.headers).send({ name: 'Coro' });
    await createPerson(church.headers, { firstName: 'Juan', lastName: 'Pérez', statusId: member.id });
    await createPerson(church.headers, { firstName: 'Juana', lastName: 'Martínez', tagIds: [tag.body.id] });
    await createPerson(church.headers, { firstName: 'Pedro', lastName: 'Juárez', phone: '11 4444-9999' });

    const names = async (qs: string) =>
      (
        await request(app)
          .get(api(`/people?${qs}`))
          .set(church.headers)
      ).body.items.map((p: { firstName: string }) => p.firstName);
    expect(await names('q=juan per')).toEqual(['Juan']);
    // Orden por apellido (Martínez, Pérez); sin acentos "juarez" encuentra a Juárez.
    expect(await names('q=juan')).toEqual(['Juana', 'Juan']);
    expect(await names('q=juarez')).toEqual(['Pedro']);
    expect(await names('q=MARTINEZ')).toEqual(['Juana']);
    expect(await names(`statusId=${member.id}`)).toEqual(['Juan']);
    expect(await names(`tagId=${tag.body.id}`)).toEqual(['Juana']);
    expect(await names('q=4444')).toEqual(['Pedro']);
    const recent = await request(app).get(api('/people?sort=recent&pageSize=1')).set(church.headers);
    expect(recent.body).toMatchObject({ total: 3, pageSize: 1, items: [{ firstName: 'Pedro' }] });
  });

  it('sin personas.ver_sensibles la respuesta no trae los campos sensibles ni se pueden escribir', async () => {
    const church = await provisionChurch();
    const person = await createPerson(church.headers, {
      firstName: 'Marta',
      lastName: 'Sosa',
      documentNumber: '28999111',
      maritalStatus: 'married',
      address: 'Calle Falsa 123',
      pastoralNotes: 'Atraviesa un duelo',
      city: 'Quilmes',
    });
    const reader = await actor({ 'personas.ver': 'all', 'personas.editar': 'all' }, church.accountId);
    const res = await request(app)
      .get(api(`/people/${person.id}`))
      .set(reader.headers);
    expect(res.status).toBe(200);
    expect(res.body.city).toBe('Quilmes');
    for (const field of ['documentNumber', 'maritalStatus', 'address', 'lat', 'lng', 'pastoralNotes']) {
      expect(res.body, field).not.toHaveProperty(field);
    }
    expect(JSON.stringify(res.body)).not.toContain('duelo');
    expect(res.body.access.sensitive).toBe(false);

    const write = await request(app)
      .patch(api(`/people/${person.id}`))
      .set(reader.headers)
      .send({ pastoralNotes: 'x' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('SENSITIVE_FIELDS_FORBIDDEN');
    const ok = await request(app)
      .patch(api(`/people/${person.id}`))
      .set(reader.headers)
      .send({ city: 'Bernal' });
    expect(ok.body.city).toBe('Bernal');

    // El que sí puede ver sensibles deja rastro en la auditoría.
    await request(app)
      .get(api(`/people/${person.id}`))
      .set(church.headers);
    expect(
      await prisma.auditLog.count({
        where: { action: 'people.sensitive.view', entityId: String(person.id) },
      }),
    ).toBe(1);
  });

  it('alcance "propio": ve y edita solo las personas que cargó y su propia ficha', async () => {
    const church = await provisionChurch();
    const others = await createPerson(church.headers, { firstName: 'Ajena', lastName: 'Persona' });
    const leader = await actor(
      { 'personas.ver': 'own', 'personas.crear': 'all', 'personas.editar': 'own' },
      church.accountId,
    );
    const mine = await createPerson(leader.headers, { firstName: 'Propia', lastName: 'Persona' });

    const list = await request(app).get(api('/people')).set(leader.headers);
    expect(list.body.items.map((p: { id: number }) => p.id)).toEqual([mine.id]);
    expect(
      (
        await request(app)
          .get(api(`/people/${others.id}`))
          .set(leader.headers)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(api(`/people/${others.id}`))
          .set(leader.headers)
          .send({ city: 'x' })
      ).status,
    ).toBe(404);

    await prisma.user.update({ where: { id: leader.user.id }, data: { personId: others.id } });
    const afterLink = await request(app).get(api('/people')).set(leader.headers);
    expect(afterLink.body.total).toBe(2);
  });

  it('ve a todos pero solo edita lo propio → 403 al editar ajenos', async () => {
    const church = await provisionChurch();
    const other = await createPerson(church.headers, { firstName: 'Otra', lastName: 'Persona' });
    const u = await actor({ 'personas.ver': 'all', 'personas.editar': 'own' }, church.accountId);
    const res = await request(app)
      .patch(api(`/people/${other.id}`))
      .set(u.headers)
      .send({ city: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERSON_EDIT_FORBIDDEN');
    const detail = await request(app)
      .get(api(`/people/${other.id}`))
      .set(u.headers);
    expect(detail.body.access.edit).toBe(false);
  });

  it('no acepta referencias (sede, etiqueta, estado, hogar) de otra cuenta', async () => {
    const a = await provisionChurch();
    const b = await provisionChurch();
    const campusB = await prisma.campus.findFirstOrThrow({ where: { accountId: b.accountId } });
    const statusB = await catalog(b.accountId, 'person_status', 'member');
    const tagB = await request(app).post(api('/tags')).set(b.headers).send({ name: 'B' });
    const householdB = await request(app).post(api('/households')).set(b.headers).send({ name: 'Familia B' });

    const tries = [
      [{ campusId: campusB.id }, 'CAMPUS_INVALID'],
      [{ statusId: statusB.id }, 'STATUS_INVALID'],
      [{ tagIds: [tagB.body.id] }, 'TAG_INVALID'],
      [{ householdId: householdB.body.id }, 'HOUSEHOLD_INVALID'],
    ] as const;
    for (const [extra, code] of tries) {
      const res = await request(app)
        .post(api('/people'))
        .set(a.headers)
        .send({ firstName: 'X', lastName: 'Y', ...extra });
      expect(res.status, code).toBe(400);
      expect(res.body.error.code).toBe(code);
    }
    const personB = await createPerson(b.headers, { firstName: 'De', lastName: 'B' });
    expect(
      (
        await request(app)
          .get(api(`/people/${personB.id}`))
          .set(a.headers)
      ).status,
    ).toBe(404);
  });
});

describe('duplicados y fusión', () => {
  it('bloquea el alta ante un duplicado fuerte salvo que se confirme', async () => {
    const church = await provisionChurch();
    const first = await createPerson(church.headers, {
      firstName: 'Carla',
      lastName: 'Ruiz',
      phone: '11-5555-0000',
    });
    const again = await request(app)
      .post(api('/people'))
      .set(church.headers)
      .send({ firstName: 'Carlita', lastName: 'Ruiz', phone: '1155550000' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PERSON_DUPLICATE_SUSPECTED');
    expect(again.body.error.details.items[0]).toMatchObject({
      id: first.id,
      reasons: ['phone'],
      strong: true,
    });

    // Mismo nombre sin otro dato en común: solo advertencia (no bloquea).
    const sameName = await request(app)
      .get(api('/people/duplicates?firstName=carla&lastName=RUIZ'))
      .set(church.headers);
    expect(sameName.body).toMatchObject({ strong: false, items: [{ id: first.id, reasons: ['name'] }] });
    expect(
      (
        await request(app)
          .post(api('/people'))
          .set(church.headers)
          .send({ firstName: 'Carla', lastName: 'Ruiz' })
      ).status,
    ).toBe(201);

    const forced = await request(app)
      .post(api('/people'))
      .set(church.headers)
      .send({ firstName: 'Carlita', lastName: 'Ruiz', phone: '1155550000', allowDuplicate: true });
    expect(forced.status).toBe(201);
  });

  it('con alcance propio no ve los duplicados ajenos, solo cuántos hay', async () => {
    const church = await provisionChurch();
    await createPerson(church.headers, { firstName: 'Ana', lastName: 'Luz', email: 'ana@x.com' });
    const leader = await actor({ 'personas.ver': 'own', 'personas.crear': 'all' }, church.accountId);
    const res = await request(app).get(api('/people/duplicates?email=ANA@x.com')).set(leader.headers);
    expect(res.body).toEqual({ items: [], hiddenCount: 1, strong: true });
  });

  it('fusiona historial, hitos, etiquetas y usuario, completa vacíos y da de baja la origen', async () => {
    const church = await provisionChurch();
    const conversion = await catalog(church.accountId, 'milestone', 'conversion');
    const tagA = await request(app).post(api('/tags')).set(church.headers).send({ name: 'A' });
    const tagB = await request(app).post(api('/tags')).set(church.headers).send({ name: 'B' });
    const target = await createPerson(church.headers, {
      firstName: 'Rosa',
      lastName: 'Paz',
      tagIds: [tagA.body.id],
      notes: 'Nota destino',
    });
    const source = await createPerson(church.headers, {
      firstName: 'Rosa',
      lastName: 'Paz',
      email: 'rosa@paz.com',
      birthDate: '1985-02-02',
      tagIds: [tagA.body.id, tagB.body.id],
      notes: 'Nota origen',
      allowDuplicate: true,
    });
    await request(app)
      .post(api(`/people/${source.id}/milestones`))
      .set(church.headers)
      .send({ milestoneTypeId: conversion.id, date: '2020-01-01' });
    await prisma.user.update({ where: { id: church.ownerId }, data: { personId: source.id } });

    const merged = await request(app)
      .post(api(`/people/${source.id}/merge`))
      .set(church.headers)
      .send({ intoId: target.id });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({
      id: target.id,
      email: 'rosa@paz.com',
      birthDate: '1985-02-02',
      notes: 'Nota destino\n\nNota origen',
      milestones: [{ type: { systemKey: 'conversion' }, date: '2020-01-01' }],
    });
    expect(merged.body.tags.map((t: { name: string }) => t.name).sort()).toEqual(['A', 'B']);
    const gone = await prisma.person.findUniqueOrThrow({ where: { id: source.id } });
    expect(gone.mergedIntoId).toBe(target.id);
    expect(gone.deletedAt).not.toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: church.ownerId } })).personId).toBe(target.id);
    expect(await prisma.personStatusHistory.count({ where: { personId: target.id } })).toBe(2);
    expect(
      (
        await request(app)
          .get(api(`/people/${source.id}`))
          .set(church.headers)
      ).status,
    ).toBe(404);
  });
});

describe('estado, hitos, cargos, historial y baja', () => {
  it('registra cambios de estado con nota y los muestra en el historial', async () => {
    const church = await provisionChurch();
    const member = await catalog(church.accountId, 'person_status', 'member');
    const baptism = await catalog(church.accountId, 'milestone', 'water_baptism');
    const deacon = await catalog(church.accountId, 'position', 'deacon');
    const p = await createPerson(church.headers, { firstName: 'Pablo', lastName: 'Ríos' });

    const changed = await request(app)
      .post(api(`/people/${p.id}/status`))
      .set(church.headers)
      .send({ statusId: member.id, note: 'Completó la clase de membresía' });
    expect(changed.body.status.systemKey).toBe('member');

    const withMilestone = await request(app)
      .post(api(`/people/${p.id}/milestones`))
      .set(church.headers)
      .send({ milestoneTypeId: baptism.id, date: '2024-03-10', notes: 'Río Luján' });
    expect(withMilestone.status).toBe(201);
    const future = await request(app)
      .post(api(`/people/${p.id}/milestones`))
      .set(church.headers)
      .send({ milestoneTypeId: baptism.id, date: '2999-01-01' });
    expect(future.status).toBe(400);

    const pos = await request(app)
      .post(api(`/people/${p.id}/positions`))
      .set(church.headers)
      .send({ positionId: deacon.id, since: '2022-01-01' });
    const positionId = pos.body.positions[0].id;
    const ended = await request(app)
      .patch(api(`/people/${p.id}/positions/${positionId}`))
      .set(church.headers)
      .send({ until: '2023-12-31' });
    expect(ended.body.positions[0]).toMatchObject({ since: '2022-01-01', until: '2023-12-31' });
    const bad = await request(app)
      .patch(api(`/people/${p.id}/positions/${positionId}`))
      .set(church.headers)
      .send({ until: '2021-01-01' });
    expect(bad.body.error.code).toBe('DATE_RANGE_INVALID');

    const timeline = await request(app)
      .get(api(`/people/${p.id}/timeline`))
      .set(church.headers);
    expect(timeline.body.items.map((i: { type: string }) => i.type)).toEqual([
      'status', // hoy
      'created', // hoy, antes del cambio de estado
      'milestone', // 2024-03-10
      'position_end', // 2023-12-31
      'position_start', // 2022-01-01
    ]);
    expect(timeline.body.items[0]).toMatchObject({
      from: { systemKey: 'visitor' },
      to: { systemKey: 'member' },
      note: 'Completó la clase de membresía',
      by: { id: church.ownerId },
    });

    const milestoneId = withMilestone.body.milestones[0].id;
    const removed = await request(app)
      .delete(api(`/people/${p.id}/milestones/${milestoneId}`))
      .set(church.headers);
    expect(removed.body.milestones).toEqual([]);
  });

  it('la baja es lógica y desvincula al usuario', async () => {
    const church = await provisionChurch();
    const p = await createPerson(church.headers, { firstName: 'Baja', lastName: 'Lógica' });
    await prisma.user.update({ where: { id: church.ownerId }, data: { personId: p.id } });
    expect(
      (
        await request(app)
          .delete(api(`/people/${p.id}`))
          .set(church.headers)
      ).status,
    ).toBe(204);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: p.id } })).deletedAt).not.toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: church.ownerId } })).personId).toBeNull();
    expect((await request(app).get(api('/people')).set(church.headers)).body.total).toBe(0);
  });
});

describe('vínculo usuario ↔ persona', () => {
  it('se vincula desde usuarios, una persona con un solo usuario', async () => {
    const church = await provisionChurch();
    const p = await createPerson(church.headers, { firstName: 'Dueño', lastName: 'Iglesia' });
    const linked = await request(app)
      .patch(api(`/users/${church.ownerId}`))
      .set(church.headers)
      .send({ personId: p.id });
    expect(linked.body.person).toEqual({ id: p.id, firstName: 'Dueño', lastName: 'Iglesia' });

    const other = await actor({}, church.accountId);
    const clash = await request(app)
      .patch(api(`/users/${other.user.id}`))
      .set(church.headers)
      .send({ personId: p.id });
    expect(clash.body.error.code).toBe('PERSON_ALREADY_LINKED');

    const me = await request(app).get(api('/me')).set(church.headers);
    expect(me.body.user.personId).toBe(p.id);
    const detail = await request(app)
      .get(api(`/people/${p.id}`))
      .set(church.headers);
    expect(detail.body.user).toMatchObject({ id: church.ownerId });
  });
});

describe('hogares', () => {
  it('crea con integrantes, oculta la dirección sin sensibles y se disuelve', async () => {
    const church = await provisionChurch();
    const dad = await createPerson(church.headers, { firstName: 'Luis', lastName: 'Vega' });
    const kid = await createPerson(church.headers, {
      firstName: 'Tomi',
      lastName: 'Vega',
      birthDate: '2015-06-01',
    });
    const created = await request(app)
      .post(api('/households'))
      .set(church.headers)
      .send({
        name: 'Familia Vega',
        address: 'Mitre 450',
        city: 'Lanús',
        members: [
          { personId: dad.id, role: 'head' },
          { personId: kid.id, role: 'child' },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Familia Vega',
      address: 'Mitre 450',
      access: { sensitive: true },
    });
    expect(created.body.members.map((m: { householdRole: string }) => m.householdRole)).toEqual([
      'head',
      'child',
    ]);

    const detail = await request(app)
      .get(api(`/people/${kid.id}`))
      .set(church.headers);
    expect(detail.body.household).toMatchObject({ name: 'Familia Vega', members: [{ id: dad.id }] });

    const reader = await actor({ 'personas.ver': 'all', 'personas.editar': 'all' }, church.accountId);
    const hidden = await request(app)
      .get(api(`/households/${created.body.id}`))
      .set(reader.headers);
    expect(hidden.body).not.toHaveProperty('address');
    expect(hidden.body.city).toBe('Lanús');
    const write = await request(app)
      .patch(api(`/households/${created.body.id}`))
      .set(reader.headers)
      .send({ address: 'x' });
    expect(write.body.error.code).toBe('SENSITIVE_FIELDS_FORBIDDEN');

    const list = await request(app).get(api('/households?q=vega')).set(reader.headers);
    expect(list.body.items).toEqual([
      { id: created.body.id, name: 'Familia Vega', city: 'Lanús', memberCount: 2 },
    ]);

    expect(
      (
        await request(app)
          .delete(api(`/households/${created.body.id}`))
          .set(church.headers)
      ).status,
    ).toBe(204);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: dad.id } })).householdId).toBeNull();
  });

  it('con alcance propio no ve hogares sin integrantes suyos', async () => {
    const church = await provisionChurch();
    const p = await createPerson(church.headers, { firstName: 'Alguien', lastName: 'Más' });
    await request(app)
      .post(api('/households'))
      .set(church.headers)
      .send({ name: 'Familia Ajena', members: [{ personId: p.id, role: 'head' }] });
    const leader = await actor(
      { 'personas.ver': 'own', 'personas.crear': 'all', 'personas.editar': 'own' },
      church.accountId,
    );
    expect((await request(app).get(api('/households')).set(leader.headers)).body.total).toBe(0);
    const empty = await request(app).post(api('/households')).set(leader.headers).send({ name: 'Vacía' });
    expect(empty.body.error.code).toBe('HOUSEHOLD_MEMBERS_REQUIRED');
  });
});

describe('fotos de personas', () => {
  it('solo las ve quien ve a la persona', async () => {
    const church = await provisionChurch();
    const p = await createPerson(church.headers, { firstName: 'Con', lastName: 'Foto' });
    const png = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .png()
      .toBuffer();
    const upload = await request(app)
      .post(api(`/people/${p.id}/photo`))
      .set(church.headers)
      .attach('file', png, 'foto.png');
    expect(upload.status).toBe(201);
    const fileId = upload.body.photoFileId;

    const own = await request(app)
      .get(api(`/files/${fileId}`))
      .set(church.headers);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('image/webp');

    const leader = await actor({ 'personas.ver': 'own' }, church.accountId);
    expect(
      (
        await request(app)
          .get(api(`/files/${fileId}`))
          .set(leader.headers)
      ).status,
    ).toBe(404);
    const nobody = await actor({}, church.accountId);
    expect(
      (
        await request(app)
          .get(api(`/files/${fileId}`))
          .set(nobody.headers)
      ).status,
    ).toBe(404);
  });
});
