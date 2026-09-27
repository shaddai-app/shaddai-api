import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../../src/core/time/local-date.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const today = () => todayIn('America/Argentina/Buenos_Aires');

async function person(headers: Headers, firstName: string) {
  const res = await request(app)
    .post(api('/people'))
    .set(headers)
    .send({ firstName, lastName: 'Nueva', allowDuplicate: true });
  if (res.status !== 201) throw new Error(`persona: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as number;
}

async function openCase(headers: Headers, personId: number, extra: object = {}) {
  const res = await request(app)
    .post(api('/consolidation/cases'))
    .set(headers)
    .send({ personId, ...extra });
  if (res.status !== 201) throw new Error(`caso: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Usuario con el rol «Consolidador» (alcance propio). */
async function consolidator(accountId: number) {
  return actor(
    {
      'personas.ver': 'own',
      'personas.editar': 'own',
      'consolidacion.ver': 'own',
      'consolidacion.gestionar': 'own',
    },
    accountId,
  );
}

describe('pasos de consolidación', () => {
  it('cada iglesia arranca con 5 pasos; se renombran, agregan, ordenan y no queda sin pasos', async () => {
    const c = await provisionChurch();
    const list = await request(app).get(api('/consolidation/steps')).set(c.headers);
    expect(
      list.body.items.map((s: { systemKey: string; dueDays: number }) => [s.systemKey, s.dueDays]),
    ).toEqual([
      ['first_contact', 2],
      ['home_visit', 7],
      ['cell_invite', 14],
      ['encounter', 30],
      ['discipleship', 60],
    ]);
    const custom = await request(app)
      .post(api('/consolidation/steps'))
      .set(c.headers)
      .send({ name: 'Bautismo', dueDays: 90 });
    expect(custom.body).toMatchObject({ name: 'Bautismo', sortOrder: 60, systemKey: null });
    const ids = [custom.body.id, ...list.body.items.map((s: { id: number }) => s.id)];
    const ordered = await request(app).put(api('/consolidation/steps/order')).set(c.headers).send({ ids });
    expect(ordered.body.items[0].name).toBe('Bautismo');

    for (const id of ids.slice(1)) {
      await request(app)
        .patch(api(`/consolidation/steps/${id}`))
        .set(c.headers)
        .send({ isActive: false });
    }
    const last = await request(app)
      .patch(api(`/consolidation/steps/${custom.body.id}`))
      .set(c.headers)
      .send({ isActive: false });
    expect(last.body.error.code).toBe('CONSOLIDATION_LAST_STEP');
    const sys = await request(app)
      .delete(api(`/consolidation/steps/${ids[1]}`))
      .set(c.headers);
    expect(sys.body.error.code).toBe('CATALOG_SYSTEM_ITEM');
  });
});

describe('casos', () => {
  it('apertura con vencimientos por paso, avance, finalización y deshacer', async () => {
    const c = await provisionChurch();
    const p = await person(c.headers, 'Ana');
    const kase = await openCase(c.headers, p);
    expect(kase).toMatchObject({
      status: 'open',
      source: 'manual',
      openedAt: today(),
      progress: { done: 0, total: 5 },
      currentStepDueAt: addDays(today(), 2),
      overdue: false,
      access: { manage: true, assign: true },
    });
    expect(kase.steps.map((s: { dueAt: string }) => s.dueAt)).toEqual(
      [2, 7, 14, 30, 60].map((d) => addDays(today(), d)),
    );
    const dup = await request(app).post(api('/consolidation/cases')).set(c.headers).send({ personId: p });
    expect(dup.body.error).toMatchObject({ code: 'CASE_ALREADY_OPEN', details: { caseId: kase.id } });

    const [first, second] = kase.steps;
    const done1 = await request(app)
      .post(api(`/consolidation/cases/${kase.id}/steps/${first.step.id}/complete`))
      .set(c.headers)
      .send({ notes: 'La llamé' });
    expect(done1.body.currentStepId).toBe(second.step.id);
    expect(done1.body.steps[0]).toMatchObject({ completedAt: today(), notes: 'La llamé' });

    // Mover la tarjeta al último paso completa los anteriores.
    const last = kase.steps[4];
    const moved = await request(app)
      .post(api(`/consolidation/cases/${kase.id}/move`))
      .set(c.headers)
      .send({ stepId: last.step.id });
    expect(moved.body).toMatchObject({ currentStepId: last.step.id, progress: { done: 4, total: 5 } });

    const finished = await request(app)
      .post(api(`/consolidation/cases/${kase.id}/steps/${last.step.id}/complete`))
      .set(c.headers)
      .send({});
    expect(finished.body).toMatchObject({ status: 'completed', closedAt: today(), currentStepId: null });

    const undone = await request(app)
      .post(api(`/consolidation/cases/${kase.id}/steps/${last.step.id}/undo`))
      .set(c.headers);
    expect(undone.body).toMatchObject({ status: 'open', currentStepId: last.step.id, closedAt: null });

    const drop = await request(app)
      .patch(api(`/consolidation/cases/${kase.id}`))
      .set(c.headers)
      .send({ status: 'dropped' });
    expect(drop.body.error.code).toBe('CLOSE_REASON_REQUIRED');
    const dropped = await request(app)
      .patch(api(`/consolidation/cases/${kase.id}`))
      .set(c.headers)
      .send({ status: 'dropped', closeReason: 'Se mudó' });
    expect(dropped.body).toMatchObject({ status: 'dropped', closeReason: 'Se mudó' });
    const locked = await request(app)
      .post(api(`/consolidation/cases/${kase.id}/steps/${first.step.id}/undo`))
      .set(c.headers);
    expect(locked.body.error.code).toBe('CASE_DROPPED');
  });

  it('asignación: solo a usuarios con acceso a consolidación', async () => {
    const c = await provisionChurch();
    const cons = await consolidator(c.accountId);
    const nobody = await actor({}, c.accountId);
    const kase = await openCase(c.headers, await person(c.headers, 'Beto'));

    const list = await request(app).get(api('/consolidation/consolidators')).set(c.headers);
    const ids = list.body.items.map((u: { id: number }) => u.id);
    expect(ids).toContain(cons.user.id);
    expect(ids).not.toContain(nobody.user.id);

    const bad = await request(app)
      .patch(api(`/consolidation/cases/${kase.id}/assign`))
      .set(c.headers)
      .send({ consolidatorUserId: nobody.user.id });
    expect(bad.body.error.code).toBe('CONSOLIDATOR_NO_ACCESS');
    const ok = await request(app)
      .patch(api(`/consolidation/cases/${kase.id}/assign`))
      .set(c.headers)
      .send({ consolidatorUserId: cons.user.id });
    expect(ok.body.consolidator).toMatchObject({ id: cons.user.id });
  });

  it('consolidador con alcance propio: ve solo sus casos y a esas personas', async () => {
    const c = await provisionChurch();
    const cons = await consolidator(c.accountId);
    const mine = await person(c.headers, 'Mía');
    const other = await person(c.headers, 'Ajena');
    const myCase = await openCase(c.headers, mine, { consolidatorUserId: cons.user.id });
    await openCase(c.headers, other);

    const board = await request(app).get(api('/consolidation/board')).set(cons.headers);
    const ids = board.body.columns.flatMap((col: { cases: { id: number }[] }) => col.cases.map((x) => x.id));
    expect(ids).toEqual([myCase.id]);
    expect(board.body.summary).toMatchObject({ open: 1, unassigned: 0 });

    // La persona asignada entra en su alcance de personas.
    const people = await request(app).get(api('/people')).set(cons.headers);
    expect(people.body.items.map((p: { id: number }) => p.id)).toEqual([mine]);

    const step = myCase.steps[0].step.id;
    const done = await request(app)
      .post(api(`/consolidation/cases/${myCase.id}/steps/${step}/complete`))
      .set(cons.headers)
      .send({});
    expect(done.status).toBe(200);
    const assign = await request(app)
      .patch(api(`/consolidation/cases/${myCase.id}/assign`))
      .set(cons.headers)
      .send({ consolidatorUserId: null });
    expect(assign.status).toBe(403); // no tiene consolidacion.asignar
  });

  it('tablero del admin con resumen de vencidos y sin asignar', async () => {
    const c = await provisionChurch();
    const a = await openCase(c.headers, await person(c.headers, 'Uno'));
    await openCase(c.headers, await person(c.headers, 'Dos'));
    await prisma.consolidationCaseStep.updateMany({
      where: { caseId: a.id },
      data: { dueAt: new Date(`${addDays(today(), -1)}T00:00:00Z`) },
    });
    const board = await request(app).get(api('/consolidation/board')).set(c.headers);
    expect(board.body.summary).toEqual({ open: 2, overdue: 1, unassigned: 2 });
    expect(board.body.columns[0].cases).toHaveLength(2);
    const overdue = await request(app).get(api('/consolidation/cases?overdue=true')).set(c.headers);
    expect(overdue.body.items.map((x: { id: number }) => x.id)).toEqual([a.id]);
  });
});

describe('seguimientos y tareas', () => {
  it('seguimientos con próxima acción y «mis tareas»', async () => {
    const c = await provisionChurch();
    const cons = await consolidator(c.accountId);
    const p = await person(c.headers, 'Carla');
    const kase = await openCase(c.headers, p, { consolidatorUserId: cons.user.id });

    const add = await request(app)
      .post(api(`/people/${p}/follow-ups`))
      .set(cons.headers)
      .send({
        type: 'call',
        notes: 'Atendió, vendrá el domingo',
        nextAction: 'Llamar el lunes',
        nextActionAt: today(),
      });
    expect(add.status).toBe(201);
    expect(add.body.items[0]).toMatchObject({
      type: 'call',
      caseId: kase.id,
      nextActionAt: today(),
      createdBy: { id: cons.user.id },
    });
    const future = await request(app)
      .post(api(`/people/${p}/follow-ups`))
      .set(cons.headers)
      .send({ type: 'visit', date: addDays(today(), 1) });
    expect(future.body.error.code).toBe('DATE_IN_FUTURE');

    await prisma.consolidationCaseStep.updateMany({
      where: { caseId: kase.id },
      data: { dueAt: new Date(`${addDays(today(), -3)}T00:00:00Z`) },
    });
    const tasks = await request(app).get(api('/me/consolidation/tasks')).set(cons.headers);
    expect(tasks.body.actions).toMatchObject([
      { person: { id: p }, nextAction: 'Llamar el lunes', overdue: false },
    ]);
    expect(tasks.body.overdueCases.map((x: { id: number }) => x.id)).toEqual([kase.id]);

    // Un seguimiento nuevo sin próxima acción "cierra" la tarea.
    await request(app)
      .post(api(`/people/${p}/follow-ups`))
      .set(cons.headers)
      .send({ type: 'whatsapp' });
    expect((await request(app).get(api('/me/consolidation/tasks')).set(cons.headers)).body.actions).toEqual(
      [],
    );

    const detail = await request(app)
      .get(api(`/consolidation/cases/${kase.id}`))
      .set(cons.headers);
    expect(detail.body.followUps).toHaveLength(2);
    const other = await consolidator(c.accountId);
    await prisma.consolidationCase.update({
      where: { id: kase.id },
      data: { consolidatorUserId: other.user.id },
    });
    const first = detail.body.followUps[1].id;
    const denied = await request(app)
      .delete(api(`/follow-ups/${first}`))
      .set(other.headers);
    expect(denied.body.error.code).toBe('FOLLOW_UP_DELETE_FORBIDDEN');
    expect(
      (
        await request(app)
          .delete(api(`/follow-ups/${first}`))
          .set(c.headers)
      ).status,
    ).toBe(204);
  });
});

describe('entradas automáticas', () => {
  it('formulario «Soy nuevo» y visitas nuevas de célula abren casos, sin duplicar', async () => {
    const c = await provisionChurch();
    const slug = (await prisma.account.findUniqueOrThrow({ where: { id: c.accountId } })).slug;
    await request(app)
      .post(api(`/public/${slug}/newcomer`))
      .send({ firstName: 'Lucía', lastName: 'Form', phone: '11 4000 0001', consent: true });
    const [item] = (await request(app).get(api('/newcomers')).set(c.headers)).body.items;
    const accepted = await request(app)
      .post(api(`/newcomers/${item.id}/accept`))
      .set(c.headers)
      .send({});
    const formCase = await prisma.consolidationCase.findFirstOrThrow({
      where: { personId: accepted.body.personId },
    });
    expect(formCase).toMatchObject({ source: 'form', status: 'open', consolidatorUserId: null });

    const network = await request(app).post(api('/networks')).set(c.headers).send({ name: 'Red' });
    const zone = await request(app)
      .post(api('/zones'))
      .set(c.headers)
      .send({ name: 'Z', networkId: network.body.id });
    const leader = await person(c.headers, 'Líder');
    const cell = await request(app).post(api('/cells')).set(c.headers).send({
      name: 'C',
      zoneId: zone.body.id,
      meetingDay: 3,
      meetingTime: '20:00',
      address: 'x',
      leaderPersonId: leader,
    });
    await request(app)
      .post(api(`/cells/${cell.body.id}/reports`))
      .set(c.headers)
      .send({
        meetingDate: today(),
        held: true,
        newVisitors: [
          { firstName: 'Visita', lastName: 'Célula', phone: '11 4000 0002' },
          // Misma persona del formulario (teléfono y nombre): ya tiene caso abierto, no se duplica.
          { firstName: 'Lucía', lastName: 'Form', phone: '1140000001' },
        ],
      });
    const visitor = await prisma.person.findFirstOrThrow({ where: { firstName: 'Visita' } });
    expect(await prisma.consolidationCase.count({ where: { personId: visitor.id, source: 'cell' } })).toBe(1);
    expect(await prisma.consolidationCase.count({ where: { personId: accepted.body.personId } })).toBe(1);
  });

  it('fusión: un solo caso abierto por persona; la baja cierra el caso', async () => {
    const c = await provisionChurch();
    const a = await person(c.headers, 'Dup');
    const b = await person(c.headers, 'Dup');
    const caseA = await openCase(c.headers, a);
    const caseB = await openCase(c.headers, b);
    await request(app)
      .post(api(`/people/${a}/merge`))
      .set(c.headers)
      .send({ intoId: b });
    const merged = await prisma.consolidationCase.findUniqueOrThrow({ where: { id: caseA.id } });
    expect(merged).toMatchObject({ personId: b, status: 'dropped', closeReason: 'merged' });
    expect((await prisma.consolidationCase.findUniqueOrThrow({ where: { id: caseB.id } })).status).toBe(
      'open',
    );

    await request(app)
      .delete(api(`/people/${b}`))
      .set(c.headers);
    expect(await prisma.consolidationCase.findUniqueOrThrow({ where: { id: caseB.id } })).toMatchObject({
      status: 'dropped',
      closeReason: 'person_deleted',
    });
  });
});

describe('aislamiento entre iglesias', () => {
  it('casos, pasos, consolidadores y seguimientos de otra cuenta no se ven ni se tocan', async () => {
    const a = await provisionChurch();
    const b = await provisionChurch();
    const consA = await consolidator(a.accountId);
    const consB = await consolidator(b.accountId);
    const personA = await person(a.headers, 'DeA');
    const kase = await openCase(a.headers, personA, { consolidatorUserId: consA.user.id });
    const stepA = kase.steps[0].step.id;
    const followUp = await request(app)
      .post(api(`/people/${personA}/follow-ups`))
      .set(a.headers)
      .send({ type: 'call', nextAction: 'Llamar', nextActionAt: today() });
    const followUpId = followUp.body.items[0].id as number;
    const stepsB = await request(app).get(api('/consolidation/steps')).set(b.headers);
    const stepB = stepsB.body.items[0].id as number;

    // Lecturas desde B: nada de A.
    const board = await request(app).get(api('/consolidation/board')).set(b.headers);
    expect(board.body.summary).toMatchObject({ open: 0 });
    expect((await request(app).get(api('/consolidation/cases')).set(b.headers)).body.items).toEqual([]);
    expect(
      (
        await request(app)
          .get(api(`/consolidation/cases/${kase.id}`))
          .set(b.headers)
      ).status,
    ).toBe(404);
    const consolidators = await request(app).get(api('/consolidation/consolidators')).set(b.headers);
    expect(consolidators.body.items.map((u: { id: number }) => u.id)).not.toContain(consA.user.id);
    expect(
      (
        await request(app)
          .get(api(`/people/${personA}/follow-ups`))
          .set(b.headers)
      ).status,
    ).toBe(404);
    const tasksB = await request(app).get(api('/me/consolidation/tasks')).set(consB.headers);
    expect(tasksB.body.actions).toEqual([]);
    expect(tasksB.body.overdueCases).toEqual([]);

    // Escrituras desde B sobre el caso de A: 404, sin cambios.
    const writes = [
      request(app)
        .patch(api(`/consolidation/cases/${kase.id}/assign`))
        .set(b.headers)
        .send({
          consolidatorUserId: consB.user.id,
        }),
      request(app)
        .patch(api(`/consolidation/cases/${kase.id}`))
        .set(b.headers)
        .send({ status: 'dropped', closeReason: 'x' }),
      request(app)
        .post(api(`/consolidation/cases/${kase.id}/move`))
        .set(b.headers)
        .send({ stepId: stepA }),
      request(app)
        .post(api(`/consolidation/cases/${kase.id}/steps/${stepA}/complete`))
        .set(b.headers)
        .send({}),
      request(app)
        .post(api(`/consolidation/cases/${kase.id}/steps/${stepA}/undo`))
        .set(b.headers),
      request(app)
        .delete(api(`/follow-ups/${followUpId}`))
        .set(b.headers),
      request(app)
        .post(api(`/people/${personA}/follow-ups`))
        .set(b.headers)
        .send({ type: 'call' }),
    ];
    for (const res of await Promise.all(writes)) expect(res.status).toBe(404);
    expect(await prisma.consolidationCase.findUniqueOrThrow({ where: { id: kase.id } })).toMatchObject({
      status: 'open',
      consolidatorUserId: consA.user.id,
    });
    expect(
      await prisma.consolidationCaseStep.count({ where: { caseId: kase.id, completedAt: { not: null } } }),
    ).toBe(0);
    expect(await prisma.followUp.count({ where: { personId: personA } })).toBe(1);

    // FKs de otra cuenta en el cuerpo: persona, consolidador y paso.
    const foreignPerson = await request(app)
      .post(api('/consolidation/cases'))
      .set(b.headers)
      .send({ personId: personA });
    expect(foreignPerson.body.error.code).toBe('PERSON_INVALID');
    const foreignUser = await request(app)
      .patch(api(`/consolidation/cases/${kase.id}/assign`))
      .set(a.headers)
      .send({ consolidatorUserId: consB.user.id });
    expect(foreignUser.body.error.code).toBe('CONSOLIDATOR_INVALID');
    const foreignStep = await request(app)
      .post(api(`/consolidation/cases/${kase.id}/move`))
      .set(a.headers)
      .send({ stepId: stepB });
    expect(foreignStep.body.error.code).toBe('CASE_STEP_NOT_FOUND');

    // Pasos de A desde B.
    const rename = await request(app)
      .patch(api(`/consolidation/steps/${stepA}`))
      .set(b.headers)
      .send({ dueDays: 1 });
    expect(rename.body.error.code).toBe('CATALOG_ITEM_NOT_FOUND');
    const del = await request(app)
      .delete(api(`/consolidation/steps/${stepA}`))
      .set(b.headers);
    expect(del.body.error.code).toBe('CATALOG_ITEM_NOT_FOUND');
    const order = await request(app)
      .put(api('/consolidation/steps/order'))
      .set(b.headers)
      .send({ ids: [stepA, stepB] });
    expect(order.body.error.code).toBe('CATALOG_ITEM_INVALID');
    expect(await prisma.consolidationStep.findUniqueOrThrow({ where: { id: stepA } })).toMatchObject({
      dueDays: 2,
    });
  });
});
