import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import { logger } from '../../../core/logger.js';

/**
 * Datos de ejemplo de la iglesia demo, módulo por módulo. Los usan el seed y el restablecimiento de
 * la demo (reset.service). Cada parte es idempotente: si ya hay datos de ese módulo, no hace nada.
 *
 * REGLA: todo módulo nuevo con datos de iglesia suma acá su `seedDemo<Algo>`. El test de
 * demo-reset falla si algún modelo de ACCOUNT_DATA queda vacío en la demo.
 */
export async function seedDemoData(prisma: PrismaClient, accountId: number) {
  await seedDemoPeople(prisma, accountId);
  await seedDemoPositions(prisma, accountId);
  await seedDemoNewcomers(prisma, accountId);
  await seedDemoCells(prisma, accountId);
  await seedDemoMultiplications(prisma, accountId);
  await seedDemoReports(prisma, accountId);
  await seedDemoConsolidation(prisma, accountId);
  await seedDemoFollowUps(prisma, accountId);
  await seedDemoFinance(prisma, accountId);
  await seedDemoOfferings(prisma, accountId);
  await seedDemoPeriods(prisma, accountId);
  await seedDemoCalendar(prisma, accountId);
  await seedDemoRegistrations(prisma, accountId);
  await seedDemoAttendance(prisma, accountId);
  await seedDemoMinistries(prisma, accountId);
  await seedDemoAssignments(prisma, accountId);
  await seedDemoSongs(prisma, accountId);
  await seedDemoSetlists(prisma, accountId);
  await seedDemoInventory(prisma, accountId);
  await seedDemoLoans(prisma, accountId);
  await seedDemoNotifications(prisma, accountId);
  await seedDemoAnnouncements(prisma, accountId);
  await seedDemoPrayerRequests(prisma, accountId);
  await seedDemoCourses(prisma, accountId);
  await seedDemoCourseSessions(prisma, accountId);
}

/**
 * Libro de caja de ejemplo (~3 meses): diezmos nominales y ofrendas de los domingos, alquiler y
 * servicios mensuales, depósitos de la caja al banco y una caja en dólares. Idempotente.
 */
async function seedDemoFinance(prisma: PrismaClient, accountId: number) {
  if ((await prisma.financeMovement.count({ where: { accountId } })) > 0) return;
  const { CATEGORY_KINDS, DEFAULT_CATEGORIES } = await import('../../finance/finance.service.js');
  const { addDays, dayOfWeek, todayIn, toDate } = await import('../../../core/time/local-date.js');
  if ((await prisma.financeCategory.count({ where: { accountId } })) === 0) {
    await prisma.financeCategory.createMany({
      data: CATEGORY_KINDS.flatMap((kind) =>
        DEFAULT_CATEGORIES[kind].map((systemKey, i) => ({
          accountId,
          kind,
          systemKey,
          sortOrder: (i + 1) * 10,
        })),
      ),
    });
  }
  const categories = await prisma.financeCategory.findMany({ where: { accountId } });
  const cat = (key: string) => categories.find((c) => c.systemKey === key)!.id;
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const today = todayIn(account.timezone);
  const start = addDays(today, -98);
  const treasurer =
    (await prisma.user.findFirst({ where: { accountId, email: 'demo-tesorero@shaddai.local' } })) ??
    (await prisma.user.findFirstOrThrow({ where: { accountId } }));

  // La caja general la crea la plantilla en las cuentas nuevas; la demo puede ser anterior.
  const cash =
    (await prisma.financeAccount.findFirst({
      where: { accountId, type: 'cash', currency: account.currency },
    })) ??
    (await prisma.financeAccount.create({
      data: {
        accountId,
        name: 'Caja general',
        type: 'cash',
        currency: account.currency,
        openingDate: toDate(start),
      },
    }));
  await prisma.financeAccount.update({
    where: { id: cash.id },
    data: { openingDate: toDate(start), openingBalance: 85_000 },
  });
  const bank = await prisma.financeAccount.create({
    data: {
      accountId,
      name: 'Banco Nación',
      type: 'bank',
      currency: account.currency,
      openingBalance: 420_000,
      openingDate: toDate(start),
      responsibleUserId: treasurer.id,
    },
  });
  const usd = await prisma.financeAccount.create({
    data: {
      accountId,
      name: 'Caja en dólares',
      type: 'cash',
      currency: 'USD',
      openingBalance: 600,
      openingDate: toDate(start),
    },
  });

  const givers = await prisma.person.findMany({
    where: { accountId, deletedAt: null, status: { systemKey: 'member' } },
    orderBy: { id: 'asc' },
    take: 8,
  });
  let seed = 7;
  const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  const round = (v: number, step: number) => Math.max(step, Math.round(v / step) * step);
  type Row = {
    financeAccountId: number;
    categoryId: number | null;
    kind: string;
    date: string;
    amount: number;
  } & {
    personId?: number;
    isAnonymous?: boolean;
    paymentMethod?: string;
    description?: string;
  };
  const rows: Row[] = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (dayOfWeek(d) === 0) {
      // Domingo: diezmos nominales (algunos por transferencia al banco) y ofrenda del culto.
      for (const g of givers) {
        if (rnd() < 0.35) continue;
        const byTransfer = rnd() < 0.3;
        rows.push({
          financeAccountId: byTransfer ? bank.id : cash.id,
          categoryId: cat('tithe'),
          kind: 'income',
          date: d,
          amount: round(8_000 + rnd() * 45_000, 500),
          personId: g.id,
          paymentMethod: byTransfer ? 'transfer' : 'cash',
        });
      }
      rows.push({
        financeAccountId: cash.id,
        categoryId: cat('offering'),
        kind: 'income',
        date: d,
        amount: round(25_000 + rnd() * 60_000, 100),
        isAnonymous: true,
        paymentMethod: 'cash',
        description: 'Ofrenda del culto',
      });
    }
    const day = Number(d.slice(8, 10));
    if (day === 5) {
      rows.push({
        financeAccountId: bank.id,
        categoryId: cat('rent'),
        kind: 'expense',
        date: d,
        amount: 210_000,
        paymentMethod: 'transfer',
        description: 'Alquiler del templo',
      });
      rows.push({
        financeAccountId: bank.id,
        categoryId: cat('utilities'),
        kind: 'expense',
        date: d,
        amount: round(35_000 + rnd() * 25_000, 10),
        paymentMethod: 'transfer',
        description: 'Luz y gas',
      });
    }
    if (day === 12) {
      rows.push({
        financeAccountId: cash.id,
        categoryId: cat('supplies'),
        kind: 'expense',
        date: d,
        amount: round(8_000 + rnd() * 20_000, 10),
        paymentMethod: 'cash',
        description: 'Artículos de limpieza',
      });
      rows.push({
        financeAccountId: bank.id,
        categoryId: cat('missions'),
        kind: 'expense',
        date: d,
        amount: 50_000,
        paymentMethod: 'transfer',
        description: 'Aporte a misioneros',
      });
    }
  }
  rows.push({
    financeAccountId: usd.id,
    categoryId: cat('special_offering'),
    kind: 'income',
    date: addDays(start, 20),
    amount: 200,
    isAnonymous: true,
    paymentMethod: 'cash',
    description: 'Ofrenda misionera',
  });
  rows.push({
    financeAccountId: usd.id,
    categoryId: cat('missions'),
    kind: 'expense',
    date: addDays(start, 50),
    amount: 350,
    paymentMethod: 'cash',
    description: 'Envío a misión en Bolivia',
  });

  await prisma.financeMovement.createMany({
    data: rows.map((r) => ({ ...r, accountId, date: toDate(r.date), createdById: treasurer.id })),
  });
  // Depósitos quincenales de la caja al banco (transferencias con sus dos patas enlazadas).
  let transfers = 0;
  for (let d = addDays(start, 14); d <= today; d = addDays(d, 14)) {
    const base = {
      accountId,
      date: toDate(d),
      amount: 150_000,
      description: 'Depósito en el banco',
      createdById: treasurer.id,
    };
    const out = await prisma.financeMovement.create({
      data: { ...base, financeAccountId: cash.id, kind: 'transfer_out' },
    });
    const inbound = await prisma.financeMovement.create({
      data: { ...base, financeAccountId: bank.id, kind: 'transfer_in', transferPairId: out.id },
    });
    await prisma.financeMovement.update({ where: { id: out.id }, data: { transferPairId: inbound.id } });
    transfers++;
  }
  logger.info(`✔ ${rows.length} movimientos y ${transfers} transferencias de ejemplo en 3 cajas`);
}

/**
 * Pendientes y arqueos de ejemplo: las ofrendas de célula de las últimas dos semanas quedan
 * pendientes (las anteriores, confirmadas en la caja general), un arqueo confirmado de la reunión de
 * oración del miércoles y un borrador del último domingo con billetes y sobres nominales. Idempotente.
 */
async function seedDemoOfferings(prisma: PrismaClient, accountId: number) {
  if ((await prisma.offeringCount.count({ where: { accountId } })) > 0) return;
  const { addDays, dayOfWeek, todayIn, toDate } = await import('../../../core/time/local-date.js');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const today = todayIn(account.timezone);
  const cash = await prisma.financeAccount.findFirst({
    where: { accountId, type: 'cash', currency: account.currency },
    orderBy: { id: 'asc' },
  });
  if (!cash) return;
  const categories = await prisma.financeCategory.findMany({ where: { accountId } });
  const cat = (key: string) => categories.find((c) => c.systemKey === key)!.id;
  const treasurer =
    (await prisma.user.findFirst({ where: { accountId, email: 'demo-tesorero@shaddai.local' } })) ??
    (await prisma.user.findFirstOrThrow({ where: { accountId } }));

  const reports = await prisma.cellReport.findMany({
    where: { accountId, offeringAmount: { gt: 0 }, financeMovements: { none: {} } },
    orderBy: { meetingDate: 'asc' },
  });
  const recent = addDays(today, -14);
  for (const r of reports) {
    const pending = r.meetingDate.toISOString().slice(0, 10) >= recent;
    await prisma.financeMovement.create({
      data: {
        accountId,
        financeAccountId: pending ? null : cash.id,
        categoryId: cat('offering'),
        kind: 'income',
        date: r.meetingDate,
        amount: r.offeringAmount!,
        paymentMethod: 'cash',
        status: pending ? 'pending' : 'confirmed',
        cellReportId: r.id,
        createdById: r.submittedById,
        ...(pending ? {} : { confirmedAt: eveningOf(r.meetingDate, 4), confirmedById: treasurer.id }),
      },
    });
  }

  const people = await prisma.person.findMany({
    where: { accountId, deletedAt: null, status: { systemKey: 'member' } },
    orderBy: { id: 'asc' },
    take: 12,
  });
  if (people.length < 4) return;
  const [c1, c2, c3, c4] = people as [
    (typeof people)[0],
    (typeof people)[0],
    (typeof people)[0],
    (typeof people)[0],
  ];
  let wednesday = today;
  while (dayOfWeek(wednesday) !== 3) wednesday = addDays(wednesday, -1);
  let sunday = today;
  while (dayOfWeek(sunday) !== 0) sunday = addDays(sunday, -1);

  const confirmedLines = [
    { categoryId: cat('offering'), paymentMethod: 'cash', denomination: 1000, quantity: 9, amount: 9000 },
    { categoryId: cat('offering'), paymentMethod: 'cash', denomination: 500, quantity: 6, amount: 3000 },
    { categoryId: cat('tithe'), paymentMethod: 'cash', amount: 18000, personId: c3.id },
  ];
  const confirmedAt = eveningOf(toDate(wednesday), 0);
  const prayer = await prisma.offeringCount.create({
    data: {
      accountId,
      financeAccountId: cash.id,
      date: toDate(wednesday),
      title: 'Reunión de oración (miércoles)',
      counter1PersonId: c1.id,
      counter2PersonId: c2.id,
      status: 'confirmed',
      createdById: treasurer.id,
      confirmedAt,
      confirmedById: treasurer.id,
      lines: { create: confirmedLines.map((l, i) => ({ ...l, sortOrder: i })) },
    },
  });
  await prisma.financeMovement.createMany({
    data: [
      { categoryId: cat('offering'), paymentMethod: 'cash', amount: 12000, personId: null },
      { categoryId: cat('tithe'), paymentMethod: 'cash', amount: 18000, personId: c3.id },
    ].map((m) => ({
      ...m,
      accountId,
      financeAccountId: cash.id,
      kind: 'income',
      date: toDate(wednesday),
      description: prayer.title,
      offeringCountId: prayer.id,
      createdById: treasurer.id,
    })),
  });

  const draftLines = [
    { categoryId: cat('offering'), paymentMethod: 'cash', denomination: 2000, quantity: 14, amount: 28000 },
    { categoryId: cat('offering'), paymentMethod: 'cash', denomination: 1000, quantity: 23, amount: 23000 },
    { categoryId: cat('offering'), paymentMethod: 'cash', denomination: 100, quantity: 37, amount: 3700 },
    { categoryId: cat('offering'), paymentMethod: 'transfer', amount: 12500 },
    { categoryId: cat('tithe'), paymentMethod: 'cash', amount: 35000, personId: c4.id },
    { categoryId: cat('tithe'), paymentMethod: 'transfer', amount: 42000, personId: c3.id },
  ];
  await prisma.offeringCount.create({
    data: {
      accountId,
      financeAccountId: cash.id,
      date: toDate(sunday),
      title: 'Culto domingo 18 h',
      counter1PersonId: c2.id,
      counter2PersonId: c4.id,
      createdById: treasurer.id,
      lines: { create: draftLines.map((l, i) => ({ ...l, sortOrder: i })) },
    },
  });
  logger.info(`✔ ${reports.length} ofrendas de célula (pendientes las recientes) y 2 arqueos de ejemplo`);
}

/** Las 19 h de Argentina (22 h UTC) del día + days: hora creíble para las fechas de confirmación. */
const eveningOf = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000 + 22 * 3_600_000);

/**
 * Cierres de ejemplo: los meses viejos quedan cerrados y el anterior al actual abierto (para probar el
 * cierre). Usa el mismo servicio que la API, con un contexto armado a mano. Idempotente.
 */
async function seedDemoPeriods(prisma: PrismaClient, accountId: number) {
  if ((await prisma.financePeriod.count({ where: { accountId } })) > 0) return;
  const { runInContext } = await import('../../../core/context.js');
  const { closePeriod, listPeriods } = await import('../../finance/periods.service.js');
  const treasurer =
    (await prisma.user.findFirst({ where: { accountId, email: 'demo-tesorero@shaddai.local' } })) ??
    (await prisma.user.findFirstOrThrow({ where: { accountId } }));
  const viewer = { userId: treasurer.id } as Parameters<typeof closePeriod>[0];
  const closed = await runInContext({ requestId: 'seed', userId: treasurer.id, accountId }, async () => {
    // Del más viejo al más nuevo, dejando abiertos el mes actual y el anterior.
    const months = (await listPeriods()).items.slice(2).reverse();
    for (const m of months) await closePeriod(viewer, m, null);
    return months.length;
  });
  logger.info(`✔ ${closed} meses cerrados de ejemplo`);
}

/**
 * Calendario de ejemplo: cultos de los domingos (10 y 18 h), reunión de oración de los miércoles,
 * reunión de líderes el primer sábado de cada mes, un miércoles feriado cancelado, un culto con
 * horario especial y dos eventos especiales. Usa el servicio de la API. Idempotente.
 */
async function seedDemoCalendar(prisma: PrismaClient, accountId: number) {
  if ((await prisma.calendarEvent.count({ where: { accountId } })) > 0) return;
  const { runInContext } = await import('../../../core/context.js');
  const { addDays, dayOfWeek, todayIn } = await import('../../../core/time/local-date.js');
  const calendar = await import('../../calendar/calendar.service.js');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  const today = todayIn(account.timezone);
  const next = (from: string, weekday: number) => {
    let d = from;
    while (dayOfWeek(d) !== weekday) d = addDays(d, 1);
    return d;
  };
  const start = next(addDays(today, -90), 0); // un domingo de hace unos 3 meses
  const viewer = { userId: admin.id } as Parameters<typeof calendar.createEvent>[0];
  await runInContext({ requestId: 'seed', userId: admin.id, accountId }, async () => {
    const weekly = { freq: 'weekly' as const, interval: 1 };
    await calendar.createEvent(viewer, {
      type: 'service',
      title: 'Culto dominical',
      location: 'Templo central',
      startsAt: `${start}T10:00`,
      endsAt: `${start}T12:00`,
      allDay: false,
      recurrence: weekly,
    });
    const evening = await calendar.createEvent(viewer, {
      type: 'service',
      title: 'Culto de la tarde',
      location: 'Templo central',
      startsAt: `${start}T18:00`,
      endsAt: `${start}T20:00`,
      allDay: false,
      recurrence: weekly,
    });
    const wednesday = next(start, 3);
    const prayer = await calendar.createEvent(viewer, {
      type: 'meeting',
      title: 'Reunión de oración',
      startsAt: `${wednesday}T20:00`,
      endsAt: `${wednesday}T21:30`,
      allDay: false,
      recurrence: weekly,
    });
    const firstSaturday = next(`${start.slice(0, 8)}01`, 6);
    await calendar.createEvent(viewer, {
      type: 'meeting',
      title: 'Reunión de líderes',
      startsAt: `${firstSaturday}T10:00`,
      endsAt: `${firstSaturday}T12:00`,
      allDay: false,
      recurrence: { freq: 'monthly', interval: 1, monthlyBy: 'weekday' },
    });
    // Un miércoles feriado (en dos semanas) y un domingo con horario especial.
    await calendar.setException(prayer.id, {
      originalStart: `${next(addDays(today, 14), 3)}T20:00`,
      cancelled: true,
      note: 'Feriado',
    });
    const specialSunday = next(addDays(today, 7), 0);
    await calendar.setException(evening.id, {
      originalStart: `${specialSunday}T18:00`,
      cancelled: false,
      newStartsAt: `${specialSunday}T19:00`,
      note: 'Horario especial: concierto de alabanza',
    });
    const friday = next(addDays(today, 20), 5);
    await calendar.createEvent(viewer, {
      type: 'special',
      title: 'Retiro de jóvenes',
      location: 'Campamento Monte Hermón',
      startsAt: `${friday}T00:00`,
      endsAt: `${addDays(friday, 2)}T23:59`,
      allDay: true,
    });
    const saturday = next(addDays(today, 10), 6);
    await calendar.createEvent(viewer, {
      type: 'special',
      title: 'Bautismos',
      description: 'Traer ropa para cambiarse y toalla.',
      location: 'Templo central',
      startsAt: `${saturday}T16:00`,
      endsAt: `${saturday}T18:00`,
      allDay: false,
    });
  });
  logger.info('✔ Calendario de ejemplo: 4 series, 2 excepciones y 2 eventos especiales');
}

/**
 * Inscripciones de ejemplo: el retiro de jóvenes con cupo de 12, lista de espera, precio y enlace
 * público (casi lleno) y los bautismos con inscripción sin precio. Idempotente.
 */
async function seedDemoRegistrations(prisma: PrismaClient, accountId: number) {
  if ((await prisma.eventRegistration.count({ where: { accountId } })) > 0) return;
  const retreat = await prisma.calendarEvent.findFirst({
    where: { accountId, title: 'Retiro de jóvenes', deletedAt: null },
  });
  const baptisms = await prisma.calendarEvent.findFirst({
    where: { accountId, title: 'Bautismos', deletedAt: null },
  });
  if (!retreat || !baptisms) return;
  await prisma.calendarEvent.update({
    where: { id: retreat.id },
    data: { registrationEnabled: true, capacity: 12, waitlistEnabled: true, price: 25_000, isPublic: true },
  });
  await prisma.calendarEvent.update({ where: { id: baptisms.id }, data: { registrationEnabled: true } });
  const people = await prisma.person.findMany({
    where: { accountId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    orderBy: { id: 'desc' },
    take: 16,
  });
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  const row = (eventId: number, at: Date, p: (typeof people)[number], status: string) => ({
    accountId,
    eventId,
    occurrenceStart: at,
    personId: p.id,
    name: `${p.firstName} ${p.lastName}`,
    email: p.email,
    phone: p.phone,
    status,
    createdById: admin.id,
  });
  await prisma.eventRegistration.createMany({
    data: [
      ...people.slice(0, 11).map((p) => row(retreat.id, retreat.startsAt, p, 'confirmed')),
      ...people.slice(11, 15).map((p) => row(baptisms.id, baptisms.startsAt, p, 'confirmed')),
    ],
  });
  logger.info('✔ Inscripciones de ejemplo: retiro (11 de 12, público) y bautismos');
}

/**
 * Asistencia de ejemplo de los cultos de los últimos 3 meses (con una tendencia en alza y alguna
 * semana floja). Deja sin cargar el último culto, para ver los pendientes. Idempotente.
 */
async function seedDemoAttendance(prisma: PrismaClient, accountId: number) {
  if ((await prisma.serviceAttendance.count({ where: { accountId } })) > 0) return;
  const { runInContext } = await import('../../../core/context.js');
  const { addDays, todayIn } = await import('../../../core/time/local-date.js');
  const attendance = await import('../../calendar/attendance.service.js');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  const today = todayIn(account.timezone);
  const viewer = { userId: admin.id } as Parameters<typeof attendance.saveAttendance>[0];
  const saved = await runInContext({ requestId: 'seed', userId: admin.id, accountId }, async () => {
    const { items } = await attendance.listAttendance({ from: addDays(today, -100), to: today });
    const pending = items.filter((i) => i.pending).reverse(); // del más viejo al más nuevo
    const toLoad = pending.slice(0, -1);
    for (const [n, item] of toLoad.entries()) {
      const evening = item.startsAt.slice(11) >= '17:00';
      const base = (evening ? 70 : 120) + n; // crece de a poco
      const dip = n % 5 === 3 ? -25 : 0; // alguna semana floja (lluvia, fin de semana largo)
      const adults = base + dip + ((n * 7) % 11);
      const children = evening ? 8 + (n % 4) : 25 + ((n * 3) % 9);
      await attendance.saveAttendance(viewer, item.eventId, item.originalStart, {
        adults,
        children,
        newcomers: n % 3 === 0 ? 4 : n % 3,
        online: evening ? 15 + (n % 6) : 40 + ((n * 5) % 17),
        notes: dip ? 'Día de lluvia' : null,
      });
    }
    return toLoad.length;
  });
  logger.info(`✔ Asistencia de ejemplo: ${saved} cultos cargados y el último pendiente`);
}

/**
 * Ministerios de ejemplo (alabanza, técnica, ujieres y niños) con sus puestos habituales, un líder y
 * algunos integrantes de la base. Idempotente.
 */
async function seedDemoMinistries(prisma: PrismaClient, accountId: number) {
  if ((await prisma.ministry.count({ where: { accountId } })) > 0) return;
  const { runInContext } = await import('../../../core/context.js');
  const { todayIn, toDate } = await import('../../../core/time/local-date.js');
  const ministries = await import('../../ministries/ministries.service.js');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  const people = await prisma.person.findMany({
    where: { accountId, deletedAt: null, status: { systemKey: { in: ['member', 'attendee'] } } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (people.length < 12) return;
  const viewer = {
    userId: admin.id,
    personId: null,
    permissions: { 'ministerios.gestionar': 'all', 'ministerios.ver': 'all' },
  } as unknown as Parameters<typeof ministries.createMinistry>[0];
  const plan = [
    { name: 'Alabanza', kind: 'worship', color: 'grape', team: people.slice(0, 7) },
    { name: 'Técnica', kind: 'tech', color: 'cyan', team: people.slice(7, 10) },
    { name: 'Ujieres', kind: 'ushers', color: 'orange', team: people.slice(10, 14) },
    { name: 'Niños', kind: 'kids', color: 'pink', team: people.slice(2, 5) },
  ] as const;
  const joinedAt = toDate(todayIn(account.timezone));
  await runInContext({ requestId: 'seed', userId: admin.id, accountId }, async () => {
    for (const m of plan) {
      const [leader, ...rest] = m.team;
      const created = await ministries.createMinistry(viewer, {
        name: m.name,
        kind: m.kind,
        color: m.color,
        withDefaultRoles: true,
        leaderPersonId: leader!.id,
      });
      await prisma.ministryMember.createMany({
        data: rest.map((p, i) => ({
          accountId,
          ministryId: created.id,
          personId: p.id,
          role: i === 0 ? 'coleader' : 'servant',
          joinedAt,
        })),
      });
    }
  });
  logger.info('✔ Ministerios de ejemplo: alabanza, técnica, ujieres y niños');
}

/**
 * Turnos de ejemplo para los próximos 3 domingos (culto de la mañana): alabanza y técnica con
 * algunos aceptados, uno rechazado y el resto pendientes, más una no disponibilidad. Idempotente.
 */
async function seedDemoAssignments(prisma: PrismaClient, accountId: number) {
  if ((await prisma.serviceAssignment.count({ where: { accountId } })) > 0) return;
  const { addDays, dayOfWeek, todayIn, toDate } = await import('../../../core/time/local-date.js');
  const service = await prisma.calendarEvent.findFirst({
    where: { accountId, title: 'Culto dominical', deletedAt: null },
  });
  const ministries = await prisma.ministry.findMany({
    where: { accountId, kind: { in: ['worship', 'tech'] }, deletedAt: null },
    include: {
      roles: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      members: { where: { leftAt: null }, orderBy: { id: 'asc' } },
    },
  });
  if (!service || ministries.length === 0) return;
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  let sunday = addDays(todayIn(account.timezone), 1);
  while (dayOfWeek(sunday) !== 0) sunday = addDays(sunday, 1);
  const time = service.startsAt.toISOString().slice(11, 16);
  const rows: Prisma.ServiceAssignmentCreateManyInput[] = [];
  for (let week = 0; week < 3; week++) {
    const occurrenceStart = new Date(`${addDays(sunday, week * 7)}T${time}:00Z`);
    for (const m of ministries) {
      // Cada integrante en un puesto distinto, rotando semana a semana.
      m.members.slice(0, m.roles.length).forEach((member, i) => {
        const role = m.roles[(i + week) % m.roles.length]!;
        const status =
          week === 0 ? (i === 1 ? 'declined' : 'accepted') : week === 1 && i === 0 ? 'accepted' : 'pending';
        rows.push({
          accountId,
          eventId: service.id,
          occurrenceStart,
          ministryId: m.id,
          serviceRoleId: role.id,
          personId: member.personId,
          status,
          respondedAt: status === 'pending' ? null : new Date(),
          declineReason: status === 'declined' ? 'Estoy de viaje ese fin de semana' : null,
          assignedById: admin.id,
        });
      });
    }
  }
  await prisma.serviceAssignment.createMany({ data: rows });
  const someone = ministries[0]!.members[2];
  if (someone) {
    await prisma.unavailability.create({
      data: {
        accountId,
        personId: someone.personId,
        fromDate: toDate(addDays(sunday, 14)),
        toDate: toDate(addDays(sunday, 20)),
        reason: 'Vacaciones',
        createdById: admin.id,
      },
    });
  }
  logger.info(`✔ Turnos de ejemplo: ${rows.length} en los próximos 3 domingos`);
}

/**
 * Canciones de ejemplo con letra propia de la demo (no son canciones reales) en ChordPro, para
 * probar la vista, la transposición y el modo escenario. Idempotente.
 */
async function seedDemoSongs(prisma: PrismaClient, accountId: number) {
  if ((await prisma.song.count({ where: { accountId } })) > 0) return;
  const { fold } = await import('../../people/people.service.js');
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  const songs = [
    {
      title: 'Amanecer de gracia',
      author: 'Equipo de alabanza Demo',
      originalKey: 'G',
      bpm: 72,
      timeSignature: '4/4',
      tags: 'Adoración,Lenta',
      chordPro: [
        '{title: Amanecer de gracia}',
        '{key: G}',
        '',
        '{start_of_verse: Verso 1}',
        '[G]Cada mañana [D/F#]nueva es tu [Em]luz',
        '[C]llena mi casa [G]de tu [D]paz',
        '[G]Aunque la noche [D/F#]fue larga y [Em]fría',
        '[C]tu fidelidad [D]nunca se [G]va',
        '{end_of_verse}',
        '',
        '{start_of_chorus}',
        '[C]Canto a tu [G]nombre, [D]canto a tu [Em]amor',
        '[C]eres mi [G]fuerza, [D]mi [G]Señor',
        '{end_of_chorus}',
      ].join('\n'),
    },
    {
      title: 'Río de vida',
      author: 'Equipo de alabanza Demo',
      originalKey: 'D',
      bpm: 128,
      timeSignature: '4/4',
      tags: 'Celebración,Rápida',
      chordPro: [
        '{title: Río de vida}',
        '{key: D}',
        '',
        '{start_of_verse}',
        '[D]Hay un río que [A]corre',
        '[Bm]hay un canto que [G]nace',
        '[D]todo lo que es[A]taba seco',
        '[G]vuelve a flore[A]cer',
        '{end_of_verse}',
        '',
        '{start_of_chorus}',
        '[G]Salta mi co[D]razón, [A]danza mi [Bm]ser',
        '[G]tu alegría es mi [A]fuerza otra [D]vez',
        '{end_of_chorus}',
      ].join('\n'),
      links: [{ type: 'other', url: 'https://example.com/rio-de-vida', label: 'Guía de ensayo (ejemplo)' }],
    },
    {
      title: 'En tu presencia',
      author: 'Equipo de alabanza Demo',
      originalKey: 'Am',
      bpm: 66,
      timeSignature: '6/8',
      tags: 'Adoración,Santa cena',
      chordPro: [
        '{title: En tu presencia}',
        '{key: Am}',
        '',
        '{comment: Intro suave, solo teclado}',
        '{start_of_verse}',
        '[Am]En tu pre[F]sencia me [C]quiero que[G]dar',
        '[Am]donde tu [F]voz me en[E]seña a esperar',
        '{end_of_verse}',
      ].join('\n'),
    },
  ];
  for (const { links, ...s } of songs as ((typeof songs)[number] & {
    links?: { type: string; url: string; label: string }[];
  })[]) {
    await prisma.song.create({
      data: {
        accountId,
        ...s,
        searchText: fold(`${s.title} ${s.author}`),
        createdById: admin.id,
        links: { create: links ?? [] },
      },
    });
  }
  logger.info(`✔ Canciones de ejemplo: ${songs.length}`);
}

/**
 * Listas de canciones de ejemplo para el culto de la mañana: el domingo pasado (historial) y el
 * próximo (con los músicos de los turnos). Idempotente.
 */
async function seedDemoSetlists(prisma: PrismaClient, accountId: number) {
  if ((await prisma.setlist.count({ where: { accountId } })) > 0) return;
  const { addDays, dayOfWeek, todayIn } = await import('../../../core/time/local-date.js');
  const service = await prisma.calendarEvent.findFirst({
    where: { accountId, title: 'Culto dominical', deletedAt: null },
  });
  const songs = await prisma.song.findMany({ where: { accountId, deletedAt: null }, orderBy: { id: 'asc' } });
  if (!service || songs.length < 3) return;
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  const today = todayIn(account.timezone);
  let next = addDays(today, 1);
  while (dayOfWeek(next) !== 0) next = addDays(next, 1);
  const time = service.startsAt.toISOString().slice(11, 16);
  const at = (day: string) => new Date(`${day}T${time}:00Z`);
  const [grace, river, presence] = songs;
  const lists = [
    {
      day: addDays(next, -7),
      notes: null,
      items: [
        { songId: river!.id, key: 'D' },
        { songId: grace!.id, key: 'A' },
      ],
    },
    {
      day: next,
      notes: 'Santa cena al final: «En tu presencia» suave, solo teclado al comienzo.',
      items: [
        { songId: river!.id, key: 'E', notes: 'Arranca la batería' },
        { songId: grace!.id, key: 'G' },
        { songId: presence!.id, key: 'Am' },
      ],
    },
  ];
  for (const l of lists) {
    await prisma.setlist.create({
      data: {
        accountId,
        eventId: service.id,
        occurrenceStart: at(l.day),
        notes: l.notes,
        status: 'published',
        createdById: admin.id,
        items: {
          create: l.items.map((i, index) => ({
            ...i,
            notes: 'notes' in i ? i.notes : null,
            position: index + 1,
          })),
        },
      },
    });
  }
  logger.info('✔ Listas de canciones de ejemplo: domingo pasado y próximo');
}

async function seedDemoInventory(prisma: PrismaClient, accountId: number) {
  if ((await prisma.inventoryItem.count({ where: { accountId } })) > 0) return;
  const { randomBytes } = await import('node:crypto');
  const { fold } = await import('../../people/people.service.js');
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  const campus = await prisma.campus.findFirst({ where: { accountId, isMain: true } });
  const categories = await prisma.catalogItem.findMany({ where: { accountId, type: 'inventory_category' } });
  const cat = (key: string) => categories.find((c) => c.systemKey === key)!.id;
  const items = [
    {
      code: 'EQ-0001',
      name: 'Consola digital',
      category: 'audio',
      brand: 'Behringer',
      model: 'X32',
      serialNumber: 'S1804-0231',
      location: 'Cabina de sonido',
      purchaseDate: '2022-05-14',
      purchaseValue: '1850000',
    },
    {
      code: 'EQ-0002',
      name: 'Micrófono inalámbrico 1',
      category: 'audio',
      brand: 'Shure',
      model: 'BLX24/SM58',
      location: 'Cabina de sonido',
    },
    {
      code: 'EQ-0003',
      name: 'Micrófono inalámbrico 2',
      category: 'audio',
      brand: 'Shure',
      model: 'BLX24/SM58',
      location: 'Cabina de sonido',
      status: 'faulty',
      notes: 'Se corta la señal a partir de la mitad del salón.',
    },
    {
      code: 'EQ-0004',
      name: 'Proyector del salón',
      category: 'video',
      brand: 'Epson',
      model: 'PowerLite X49',
      location: 'Salón principal',
      purchaseDate: '2023-02-01',
      purchaseValue: '920000',
    },
    {
      code: 'EQ-0005',
      name: 'Teclado',
      category: 'instruments',
      brand: 'Yamaha',
      model: 'PSR-E473',
      location: 'Escenario',
    },
    {
      code: 'EQ-0006',
      name: 'Batería acústica',
      category: 'instruments',
      brand: 'Mapex',
      model: 'Tornado',
      location: 'Escenario',
    },
    {
      code: 'EQ-0007',
      name: 'Notebook de proyección',
      category: 'computers',
      brand: 'Lenovo',
      model: 'IdeaPad 3',
      serialNumber: 'PF3K9X2',
      location: 'Cabina de sonido',
      status: 'repair',
    },
    {
      code: 'EQ-0008',
      name: 'Barra LED par 64',
      category: 'lighting',
      brand: 'Gbr',
      model: 'Par 64 LED',
      location: 'Escenario',
    },
    { code: 'EQ-0009', name: 'Sillas plásticas (lote de 50)', category: 'furniture', location: 'Depósito' },
  ];
  const created = new Map<string, number>();
  for (const { category, purchaseDate, purchaseValue, ...item } of items) {
    const row = await prisma.inventoryItem.create({
      data: {
        accountId,
        campusId: campus?.id ?? null,
        categoryId: cat(category),
        ...item,
        purchaseDate: purchaseDate ? new Date(`${purchaseDate}T00:00:00Z`) : null,
        purchaseValue: purchaseValue ?? null,
        qrToken: randomBytes(16).toString('base64url'),
        searchText: fold(
          [item.name, item.code, item.brand, item.model, item.serialNumber].filter(Boolean).join(' '),
        ),
        createdById: admin.id,
      },
    });
    created.set(item.code, row.id);
  }
  await prisma.inventoryMaintenance.createMany({
    data: [
      {
        accountId,
        itemId: created.get('EQ-0001')!,
        date: new Date('2026-03-10T00:00:00Z'),
        type: 'preventive',
        description: 'Limpieza de faders y actualización de firmware.',
        cost: '35000',
        vendor: 'Audio Service Sur',
        createdById: admin.id,
      },
      {
        accountId,
        itemId: created.get('EQ-0004')!,
        date: new Date('2026-07-22T00:00:00Z'),
        type: 'repair',
        description: 'Cambio de lámpara.',
        cost: '120000',
        vendor: 'Proyectar SRL',
        createdById: admin.id,
      },
      {
        accountId,
        itemId: created.get('EQ-0007')!,
        date: new Date('2026-09-20T00:00:00Z'),
        type: 'repair',
        description: 'No enciende: llevada al servicio técnico.',
        createdById: admin.id,
      },
    ],
  });
  logger.info(`✔ Inventario de ejemplo: ${items.length} equipos con mantenimiento`);
}

async function seedDemoLoans(prisma: PrismaClient, accountId: number) {
  if ((await prisma.inventoryLoan.count({ where: { accountId } })) > 0) return;
  const { addDays, todayIn, toDate } = await import('../../../core/time/local-date.js');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  const item = (code: string) =>
    prisma.inventoryItem.findFirst({ where: { accountId, code, deletedAt: null } });
  const people = await prisma.person.findMany({
    where: { accountId, deletedAt: null },
    orderBy: { id: 'asc' },
    take: 3,
  });
  const [keyboard, mic, projector] = await Promise.all([item('EQ-0005'), item('EQ-0002'), item('EQ-0004')]);
  if (!keyboard || !mic || !projector || people.length < 3) return;
  const today = todayIn(account.timezone);
  const loans = [
    { itemId: keyboard.id, person: people[0]!, from: -2, due: 5, conditionOut: 'Con fuente y atril' },
    { itemId: mic.id, person: people[1]!, from: -12, due: -2, conditionOut: 'Con pilas nuevas' },
    { itemId: projector.id, person: people[2]!, from: -40, due: -33, conditionOut: null, returned: -33 },
  ];
  for (const l of loans) {
    await prisma.inventoryLoan.create({
      data: {
        accountId,
        itemId: l.itemId,
        borrowerPersonId: l.person.id,
        borrowedAt: toDate(addDays(today, l.from)),
        dueAt: toDate(addDays(today, l.due)),
        conditionOut: l.conditionOut,
        notes: l.returned === undefined ? null : 'Para el campamento de jóvenes',
        returnedAt: l.returned === undefined ? null : new Date(`${addDays(today, l.returned)}T20:00:00Z`),
        conditionIn: l.returned === undefined ? null : 'Sin novedades',
        returnedById: l.returned === undefined ? null : admin.id,
        createdById: admin.id,
      },
    });
  }
  logger.info('✔ Préstamos de ejemplo: uno al día, uno vencido y uno devuelto');
}

/** Avisos de ejemplo para el admin de la demo, a partir del turno rechazado del seed. */
async function seedDemoNotifications(prisma: PrismaClient, accountId: number) {
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  if ((await prisma.notification.count({ where: { userId: admin.id } })) > 0) return;
  const { dateToLocal } = await import('../../../core/time/local-date.js');
  const declined = await prisma.serviceAssignment.findFirst({
    where: { accountId, status: 'declined' },
    include: { person: true, ministry: true, serviceRole: true, event: true },
  });
  if (!declined) return;
  const startsAt = dateToLocal(declined.occurrenceStart);
  await prisma.notification.create({
    data: {
      accountId,
      userId: admin.id,
      type: 'assignment.declined',
      params: JSON.stringify({
        person: `${declined.person.firstName} ${declined.person.lastName}`,
        ministry: declined.ministry.name,
        role: declined.serviceRole.name,
        event: declined.event.title,
        startsAt,
        reason: declined.declineReason,
      }),
      link: `/ministerios/${declined.ministryId}/turnos?desde=${startsAt.slice(0, 10)}`,
    },
  });
  logger.info('✔ Aviso de ejemplo para el admin de la demo');
}

async function seedDemoAnnouncements(prisma: PrismaClient, accountId: number) {
  if ((await prisma.announcement.count({ where: { accountId } })) > 0) return;
  const pastor = await prisma.user.findFirstOrThrow({
    where: { accountId, email: 'demo-pastor@shaddai.local' },
  });
  const worship = await prisma.ministry.findFirst({ where: { accountId, kind: 'worship', deletedAt: null } });
  const day = 86_400_000;
  const now = Date.now();
  // Ya publicados: marcados como avisados para que el programador no los mande al levantar la API.
  const published = { notify: true, notifiedAt: new Date(now) };
  await prisma.announcement.create({
    data: {
      accountId,
      createdById: pastor.id,
      title: 'Retiro de jóvenes: inscripciones abiertas',
      body: 'Del 14 al 16 de noviembre en el campamento de Pilar. Los cupos son limitados: anotate desde el calendario o hablá con tu líder de célula.',
      publishAt: new Date(now - 2 * day),
      expiresAt: new Date(now + 30 * day),
      pinned: true,
      ...published,
    },
  });
  await prisma.announcement.create({
    data: {
      accountId,
      createdById: pastor.id,
      title: 'Nuevo horario de oración',
      body: 'Desde este martes la reunión de oración pasa a las 19:30.\nGracias por acompañar.',
      publishAt: new Date(now - 5 * day),
      ...published,
    },
  });
  if (worship) {
    await prisma.announcement.create({
      data: {
        accountId,
        createdById: pastor.id,
        title: 'Ensayo general el sábado',
        body: 'Para el equipo de alabanza: ensayo general el sábado a las 17 en el templo.',
        publishAt: new Date(now - day),
        expiresAt: new Date(now + 6 * day),
        audiences: { create: [{ kind: 'ministry', refId: worship.id }] },
        ...published,
      },
    });
  }
  // Programado: el programador lo publica y lo avisa cuando llegue la fecha.
  await prisma.announcement.create({
    data: {
      accountId,
      createdById: pastor.id,
      title: 'Cena de fin de año',
      body: 'Reservá la fecha: viernes 12 de diciembre. Más información pronto.',
      publishAt: new Date(now + 3 * day),
    },
  });
  logger.info('✔ Anuncios de ejemplo');
}

/**
 * Discipulado de ejemplo: Escuela de líderes (3 niveles, el primero lo da el líder demo) con
 * inscripciones activas, completadas y una baja, y Clases de bautismo. Idempotente.
 */
async function seedDemoCourses(prisma: PrismaClient, accountId: number) {
  if ((await prisma.course.count({ where: { accountId } })) > 0) return;
  const milestone = async (systemKey: string) =>
    (await prisma.catalogItem.findFirst({ where: { accountId, type: 'milestone', systemKey } }))?.id ?? null;
  const leader = await prisma.user.findFirst({ where: { accountId, email: 'demo-lider@shaddai.local' } });
  // Adultos, sin contar al maestro del primer nivel.
  const people = await prisma.person.findMany({
    where: {
      accountId,
      deletedAt: null,
      birthDate: { lt: new Date('2008-01-01') },
      ...(leader?.personId ? { id: { not: leader.personId } } : {}),
    },
    orderBy: { id: 'asc' },
    take: 12,
  });
  const day = 86_400_000;
  const date = (daysAgo: number) =>
    new Date(`${new Date(Date.now() - daysAgo * day).toISOString().slice(0, 10)}T00:00:00Z`);

  const school = await prisma.course.create({
    data: {
      accountId,
      name: 'Escuela de líderes',
      description: 'Formación para quienes van a liderar una célula. Tres niveles de un trimestre cada uno.',
      milestoneTypeId: await milestone('leaders_school'),
      levels: {
        create: [
          {
            accountId,
            name: 'Nivel 1: Fundamentos',
            sortOrder: 10,
            teacherPersonId: leader?.personId ?? null,
          },
          { accountId, name: 'Nivel 2: Vida de célula', sortOrder: 20 },
          { accountId, name: 'Nivel 3: Liderazgo', sortOrder: 30 },
        ],
      },
    },
    include: { levels: { orderBy: { sortOrder: 'asc' } } },
  });
  const [n1, n2] = school.levels;
  const enroll = (levelId: number, personId: number, enrolledDaysAgo: number, extra = {}) =>
    prisma.courseEnrollment.create({
      data: { accountId, levelId, personId, enrolledAt: date(enrolledDaysAgo), ...extra },
    });
  for (const p of people.slice(0, 5)) await enroll(n1!.id, p.id, 40);
  for (const p of people.slice(5, 8)) {
    await enroll(n1!.id, p.id, 130, { status: 'completed', completedAt: date(45) });
    await enroll(n2!.id, p.id, 40);
  }
  if (people[8]) await enroll(n1!.id, people[8].id, 130, { status: 'dropped', droppedAt: date(90) });

  const baptism = await prisma.course.create({
    data: {
      accountId,
      name: 'Clases de bautismo',
      description: 'Cuatro encuentros antes del bautismo.',
      milestoneTypeId: await milestone('water_baptism'),
      levels: { create: [{ accountId, name: 'Clases', sortOrder: 10 }] },
    },
    include: { levels: true },
  });
  for (const p of people.slice(9, 12)) await enroll(baptism.levels[0]!.id, p.id, 10);
  logger.info('✔ Cursos de discipulado de ejemplo');
}

/**
 * Clases semanales de ejemplo con asistencia en los niveles con alumnos de la Escuela de líderes
 * (75% mínimo). La asistencia varía por alumno para que el avance tenga casos por debajo. Idempotente.
 */
async function seedDemoCourseSessions(prisma: PrismaClient, accountId: number) {
  if ((await prisma.courseSession.count({ where: { accountId } })) > 0) return;
  const course = await prisma.course.findFirst({
    where: { accountId, name: 'Escuela de líderes', deletedAt: null },
    include: { levels: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!course) return;
  const topics = ['Identidad en Cristo', 'La oración', 'La Palabra', 'El Espíritu Santo', 'La iglesia'];
  const day = 86_400_000;
  for (const level of course.levels.slice(0, 2)) {
    await prisma.courseLevel.update({ where: { id: level.id }, data: { minAttendancePct: 75 } });
    const enrollments = await prisma.courseEnrollment.findMany({
      where: { levelId: level.id, status: 'active' },
      orderBy: { id: 'asc' },
    });
    if (!enrollments.length) continue;
    const start = enrollments[0]!.enrolledAt.getTime();
    for (const [week, topic] of topics.entries()) {
      const date = new Date(start + (week * 7 + 3) * day);
      if (date.getTime() > Date.now()) break;
      await prisma.courseSession.create({
        data: {
          accountId,
          levelId: level.id,
          date,
          topic,
          attendance: {
            // El último alumno falta casi siempre; el resto, una vez cada tanto.
            create: enrollments.map((e, i) => ({
              enrollmentId: e.id,
              present: i === enrollments.length - 1 ? week === 0 : (week + i) % 4 !== 3,
            })),
          },
        },
      });
    }
  }
  logger.info('✔ Clases de discipulado de ejemplo');
}

/** Peticiones de oración de ejemplo: públicas (una anónima y una respondida) y una para pastores. */
async function seedDemoPrayerRequests(prisma: PrismaClient, accountId: number) {
  if ((await prisma.prayerRequest.count({ where: { accountId } })) > 0) return;
  const users = await prisma.user.findMany({
    where: {
      accountId,
      email: { in: ['demo-pastor@shaddai.local', 'demo-tesorero@shaddai.local', 'demo-lider@shaddai.local'] },
    },
  });
  const user = (email: string) => users.find((u) => u.email === email)!.id;
  const pastor = user('demo-pastor@shaddai.local');
  const treasurer = user('demo-tesorero@shaddai.local');
  const leader = user('demo-lider@shaddai.local');
  const day = 86_400_000;
  const now = Date.now();
  const request = (data: Omit<Prisma.PrayerRequestUncheckedCreateInput, 'accountId'>, prayedBy: number[]) =>
    prisma.prayerRequest.create({
      data: { accountId, ...data, prayers: { create: prayedBy.map((userId) => ({ userId })) } },
    });
  await request(
    {
      createdById: treasurer,
      visibility: 'public',
      body: 'Por la salud de mi mamá: la operan el jueves. Gracias por orar.',
      createdAt: new Date(now - day),
    },
    [pastor, leader],
  );
  await request(
    {
      createdById: leader,
      visibility: 'public',
      anonymous: true,
      body: 'Por mi familia, para que haya paz en casa.',
      createdAt: new Date(now - 3 * day),
    },
    [pastor],
  );
  await request(
    {
      createdById: leader,
      visibility: 'public',
      body: 'Por trabajo: hace dos meses que estoy buscando.',
      status: 'answered',
      answeredAt: new Date(now - 2 * day),
      testimony: '¡Empiezo el lunes en un trabajo nuevo! Gracias a todos por orar.',
      createdAt: new Date(now - 20 * day),
    },
    [pastor, treasurer],
  );
  await request(
    {
      createdById: treasurer,
      visibility: 'pastors',
      body: 'Necesito consejo por una situación delicada en el trabajo. ¿Podemos hablar esta semana?',
      createdAt: new Date(now - 2 * day),
    },
    [],
  );
  logger.info('✔ Peticiones de oración de ejemplo');
}

async function seedDemoConsolidation(prisma: PrismaClient, accountId: number) {
  if ((await prisma.consolidationCase.count({ where: { accountId } })) > 0) return;
  const { DEFAULT_STEPS } = await import('../../consolidation/consolidation.service.js');
  const { addDays, todayIn, toDate } = await import('../../../core/time/local-date.js');
  if ((await prisma.consolidationStep.count({ where: { accountId } })) === 0) {
    await prisma.consolidationStep.createMany({
      data: DEFAULT_STEPS.map(([systemKey, dueDays], i) => ({
        accountId,
        systemKey,
        dueDays,
        sortOrder: (i + 1) * 10,
      })),
    });
  }
  const steps = await prisma.consolidationStep.findMany({
    where: { accountId },
    orderBy: { sortOrder: 'asc' },
  });
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const pastor = await prisma.user.findFirst({ where: { accountId, email: 'demo-pastor@shaddai.local' } });
  const people = await prisma.person.findMany({
    where: { accountId, deletedAt: null, status: { systemKey: { in: ['visitor', 'new'] } } },
    orderBy: { id: 'asc' },
    take: 8,
  });
  const today = todayIn(account.timezone);
  for (const [i, p] of people.entries()) {
    const opened = addDays(today, -(3 + i * 6)); // el más viejo queda con pasos vencidos
    const doneCount = Math.min(i % 4, steps.length - 1);
    await prisma.consolidationCase.create({
      data: {
        accountId,
        personId: p.id,
        consolidatorUserId: pastor && i % 2 === 0 ? pastor.id : null,
        source: p.source === 'form' ? 'form' : 'manual',
        openedAt: toDate(opened),
        currentStepId: steps[doneCount]!.id,
        steps: {
          create: steps.map((s, k) => ({
            stepId: s.id,
            dueAt: toDate(addDays(opened, s.dueDays)),
            completedAt: k < doneCount ? toDate(addDays(opened, 1 + k)) : null,
          })),
        },
      },
    });
  }
  logger.info(`✔ ${people.length} casos de consolidación de ejemplo`);
}

/**
 * Reportes de las últimas 4 semanas para las células demo (una célula sin reportar la semana
 * pasada y una reunión suspendida), para que el semáforo tenga colores. Idempotente.
 */
async function seedDemoReports(prisma: PrismaClient, accountId: number) {
  if ((await prisma.cellReport.count({ where: { accountId } })) > 0) return;
  const { addDays, meetingDateInWeek, todayIn, toDate, weekStart } =
    await import('../../../core/time/local-date.js');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  const cells = await prisma.cell.findMany({
    where: { accountId, status: 'active' },
    include: { members: { where: { leftAt: null } } },
    orderBy: { id: 'asc' },
  });
  const today = todayIn(account.timezone);
  let created = 0;
  for (let w = 1; w <= 4; w++) {
    const start = weekStart(addDays(today, -7 * w), account.weekStartsOn);
    for (const [i, cell] of cells.entries()) {
      if (w === 1 && i === cells.length - 1) continue; // la última no reportó la semana pasada
      const date = meetingDateInWeek(start, account.weekStartsOn, cell.meetingDay);
      const held = !(w === 2 && i === 1); // una reunión suspendida
      const present = held ? cell.members.filter((_, k) => (k + w) % 4 !== 0) : [];
      await prisma.cellReport.create({
        data: {
          accountId,
          cellId: cell.id,
          meetingDate: toDate(date),
          held,
          notHeldReason: held ? null : 'Feriado largo',
          topic: held ? ['La fe', 'La oración', 'El perdón', 'La familia'][w - 1] : null,
          anonymousVisitors: held ? (i + w) % 3 : 0,
          childrenCount: held ? (i * w) % 4 : 0,
          offeringAmount: held ? 1500 + i * 250 + w * 100 : null,
          submittedById: admin.id,
          submittedAt: toDate(addDays(date, 1)),
          attendance: { create: present.map((m) => ({ personId: m.personId })) },
        },
      });
      created++;
    }
  }
  logger.info(`✔ ${created} reportes de célula de ejemplo`);
}

/**
 * Redes, zonas y células de ejemplo (Quilmes/Lanús) con líderes e integrantes tomados de las
 * personas demo. El usuario demo-lider queda vinculado al líder de la primera célula.
 * Idempotente: solo corre si la iglesia demo no tiene redes.
 */
async function seedDemoCells(prisma: PrismaClient, accountId: number) {
  if ((await prisma.network.count({ where: { accountId } })) > 0) return;
  const adults = await prisma.person.findMany({
    where: { accountId, deletedAt: null, householdRole: { in: ['head', 'spouse'] } },
    orderBy: { id: 'asc' },
  });
  const others = await prisma.person.findMany({
    where: { accountId, deletedAt: null, householdRole: 'child' },
    orderBy: { id: 'asc' },
  });
  if (adults.length < 8) return;
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const [youth, families] = await Promise.all([
    prisma.network.create({
      data: { accountId, name: 'Red de Jóvenes', color: 'grape', leaderPersonId: adults[0]!.id },
    }),
    prisma.network.create({
      data: { accountId, name: 'Red de Familias', color: 'teal', leaderPersonId: adults[1]!.id },
    }),
  ]);
  const zones = await Promise.all([
    prisma.zone.create({
      data: { accountId, networkId: youth.id, name: 'Zona Centro', supervisorPersonId: adults[2]!.id },
    }),
    prisma.zone.create({
      data: { accountId, networkId: families.id, name: 'Zona Bernal', supervisorPersonId: adults[3]!.id },
    }),
    prisma.zone.create({ data: { accountId, networkId: families.id, name: 'Zona Lanús' } }),
  ]);
  const cells = [
    {
      name: 'Célula Esperanza',
      zone: 0,
      day: 5,
      time: '20:00',
      addr: 'Rivadavia 450',
      hood: 'Quilmes Centro',
      lat: -34.7242,
      lng: -58.2526,
    },
    {
      name: 'Célula Renuevo',
      zone: 0,
      day: 6,
      time: '18:30',
      addr: 'Alem 1200',
      hood: 'Quilmes Oeste',
      lat: -34.7318,
      lng: -58.2771,
    },
    {
      name: 'Célula Familia Unida',
      zone: 1,
      day: 3,
      time: '20:30',
      addr: 'Zapiola 300',
      hood: 'Bernal',
      lat: -34.7089,
      lng: -58.2817,
    },
    {
      name: 'Célula Casa de Paz',
      zone: 1,
      day: 4,
      time: '20:00',
      addr: 'Belgrano 750',
      hood: 'Bernal Oeste',
      lat: -34.7152,
      lng: -58.2994,
    },
    {
      name: 'Célula Lanús Este',
      zone: 2,
      day: 2,
      time: '19:30',
      addr: 'Hipólito Yrigoyen 3900',
      hood: 'Lanús Este',
      lat: -34.7013,
      lng: -58.3915,
    },
  ];
  const pool = [...adults.slice(8), ...others];
  let leaderIndex = 4;
  for (const [i, c] of cells.entries()) {
    const leader = adults[leaderIndex++ % adults.length]!;
    const cell = await prisma.cell.create({
      data: {
        accountId,
        zoneId: zones[c.zone]!.id,
        name: c.name,
        code: `C${String(i + 1).padStart(2, '0')}`,
        meetingDay: c.day,
        meetingTime: c.time,
        address: c.addr,
        neighborhood: c.hood,
        city: c.hood.startsWith('Lanús') ? 'Lanús' : 'Quilmes',
        lat: c.lat,
        lng: c.lng,
        leaderPersonId: leader.id,
        startedAt: new Date(Date.UTC(2022 + (i % 3), i * 2, 1)),
      },
    });
    const members = [leader, ...pool.splice(0, 4)];
    await prisma.cellMember.createMany({
      data: members.map((m) => ({ accountId, cellId: cell.id, personId: m.id, joinedAt: today })),
    });
    if (i === 0) {
      await prisma.user.updateMany({
        where: { accountId, email: 'demo-lider@shaddai.local' },
        data: { personId: leader.id },
      });
    }
  }
  logger.info(`✔ ${cells.length} células de ejemplo en ${zones.length} zonas`);
}

const FAMILIES = [
  'González',
  'Rodríguez',
  'Fernández',
  'López',
  'Martínez',
  'Pérez',
  'Gómez',
  'Sánchez',
  'Romero',
  'Díaz',
  'Álvarez',
  'Benítez',
];
const ADULTS = [
  ['Juan', 'M'],
  ['María', 'F'],
  ['Carlos', 'M'],
  ['Laura', 'F'],
  ['Diego', 'M'],
  ['Silvia', 'F'],
  ['Martín', 'M'],
  ['Gabriela', 'F'],
  ['Pablo', 'M'],
  ['Andrea', 'F'],
  ['Sergio', 'M'],
  ['Natalia', 'F'],
] as const;
const KIDS = [
  ['Tomás', 'M'],
  ['Valentina', 'F'],
  ['Mateo', 'M'],
  ['Sofía', 'F'],
  ['Benjamín', 'M'],
  ['Martina', 'F'],
] as const;

/**
 * Personas de ejemplo (familias con hijos, estados e hitos variados). Idempotente: solo corre si la
 * iglesia demo todavía no tiene personas. Datos inventados y deterministas.
 */
async function seedDemoPeople(prisma: PrismaClient, accountId: number) {
  if ((await prisma.person.count({ where: { accountId } })) > 0) return;
  const { searchTextOf } = await import('../../people/people.service.js');
  const catalog = async (type: string) =>
    new Map(
      (await prisma.catalogItem.findMany({ where: { accountId, type } })).map((c) => [c.systemKey!, c.id]),
    );
  const [statuses, milestones] = [await catalog('person_status'), await catalog('milestone')];
  const campus = await prisma.campus.findFirstOrThrow({ where: { accountId, isMain: true } });
  const tags = await Promise.all(
    [
      ['Jóvenes', 'grape'],
      ['Voluntario', 'teal'],
      ['Matrimonios', 'pink'],
    ].map(([name, color]) => prisma.tag.create({ data: { accountId, name: name!, color } })),
  );
  const cycle = ['member', 'member', 'attendee', 'new', 'visitor', 'member', 'inactive'];
  let n = 0;

  for (const [i, lastName] of FAMILIES.entries()) {
    const household = await prisma.household.create({
      data: {
        accountId,
        name: `Familia ${lastName}`,
        city: i % 2 ? 'Quilmes' : 'Lanús',
        province: 'Buenos Aires',
      },
    });
    const [first, second] = [ADULTS[i % ADULTS.length]!, ADULTS[(i + 5) % ADULTS.length]!];
    const members = [
      { name: first, role: 'head', year: 1970 + i },
      ...(first[1] !== second[1] ? [{ name: second, role: 'spouse', year: 1972 + i }] : []),
      ...(i % 3 !== 2 ? [{ name: KIDS[i % KIDS.length]!, role: 'child', year: 2008 + (i % 10) }] : []),
    ];
    for (const m of members) {
      n++;
      const statusKey = m.role === 'child' ? 'attendee' : cycle[n % cycle.length]!;
      const person = await prisma.person.create({
        data: {
          accountId,
          campusId: campus.id,
          householdId: household.id,
          householdRole: m.role,
          firstName: m.name[0],
          lastName,
          gender: m.name[1],
          birthDate: new Date(Date.UTC(m.year, (n * 7) % 12, 1 + (n % 27))),
          phone: m.role === 'child' ? null : `+54911${String(40000000 + n * 7919).slice(0, 8)}`,
          email:
            m.role === 'child'
              ? null
              : `${m.name[0].toLowerCase()}.${n}@ejemplo.com`.normalize('NFD').replace(/\p{Diacritic}/gu, ''),
          city: household.city,
          province: household.province,
          statusId: statuses.get(statusKey)!,
          source: 'manual',
          firstVisitAt: new Date(Date.UTC(2015 + (n % 10), n % 12, 1)),
          searchText: searchTextOf({ firstName: m.name[0], lastName }),
        },
      });
      await prisma.personStatusHistory.create({
        data: { accountId, personId: person.id, toStatusId: person.statusId },
      });
      if (statusKey === 'member') {
        await prisma.personMilestone.createMany({
          data: [
            {
              accountId,
              personId: person.id,
              milestoneTypeId: milestones.get('conversion')!,
              date: new Date(Date.UTC(2010 + (n % 10), 2, 10)),
            },
            {
              accountId,
              personId: person.id,
              milestoneTypeId: milestones.get('water_baptism')!,
              date: new Date(Date.UTC(2011 + (n % 10), 10, 20)),
            },
          ],
        });
      }
      const personTags = [
        ...(m.role === 'child' || m.year > 2000 ? [tags[0]!] : []),
        ...(n % 4 === 0 ? [tags[1]!] : []),
        ...(m.role !== 'child' && members.length > 1 && m.role !== 'head' ? [tags[2]!] : []),
      ];
      if (personTags.length) {
        await prisma.personTag.createMany({
          data: personTags.map((t) => ({ personId: person.id, tagId: t.id })),
        });
      }
    }
  }
  logger.info(`✔ ${n} personas de ejemplo en la iglesia demo`);
}

/** Cargos de ejemplo (pastor, anciano y diáconos) sobre miembros adultos. Idempotente. */
async function seedDemoPositions(prisma: PrismaClient, accountId: number) {
  if ((await prisma.personPosition.count({ where: { accountId } })) > 0) return;
  const positions = new Map(
    (await prisma.catalogItem.findMany({ where: { accountId, type: 'position' } })).map((c) => [
      c.systemKey!,
      c.id,
    ]),
  );
  const adults = await prisma.person.findMany({
    where: { accountId, householdRole: 'head' },
    orderBy: { id: 'asc' },
    take: 4,
    select: { id: true },
  });
  const keys = ['pastor', 'elder', 'deacon', 'deacon'];
  await prisma.personPosition.createMany({
    data: adults.map((p, i) => ({
      accountId,
      personId: p.id,
      positionId: positions.get(keys[i]!)!,
      since: new Date(Date.UTC(2015 + i, 2, 1)),
    })),
  });
}

/** Dos visitantes que llenaron el formulario público y esperan revisión. Idempotente. */
async function seedDemoNewcomers(prisma: PrismaClient, accountId: number) {
  if ((await prisma.newcomerSubmission.count({ where: { accountId } })) > 0) return;
  const { CONSENT_VERSION } = await import('../../people/people.schemas.js');
  const base = { accountId, consent: true, consentVersion: CONSENT_VERSION, locale: 'es', city: 'Quilmes' };
  await prisma.newcomerSubmission.createMany({
    data: [
      {
        ...base,
        firstName: 'Valentina',
        lastName: 'Ríos',
        phone: '+5491155550101',
        howHeard: 'Me invitó una amiga',
        wantsVisit: true,
      },
      {
        ...base,
        firstName: 'Martín',
        lastName: 'Acosta',
        email: 'martin.acosta@ejemplo.com',
        howHeard: 'Instagram',
      },
    ],
  });
}

/** Una multiplicación de ejemplo: la última célula nació de la primera hace 4 meses. Idempotente. */
async function seedDemoMultiplications(prisma: PrismaClient, accountId: number) {
  if ((await prisma.cellMultiplication.count({ where: { accountId } })) > 0) return;
  const { addDays, todayIn, toDate } = await import('../../../core/time/local-date.js');
  const cells = await prisma.cell.findMany({ where: { accountId }, orderBy: { id: 'asc' } });
  if (cells.length < 2) return;
  const [mother, child] = [cells[0]!, cells[cells.length - 1]!];
  const admin = await prisma.user.findFirstOrThrow({ where: { accountId, isAccountOwner: true } });
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const date = toDate(addDays(todayIn(account.timezone), -120));
  await prisma.cell.update({ where: { id: child.id }, data: { parentCellId: mother.id, startedAt: date } });
  await prisma.cellMultiplication.create({
    data: {
      accountId,
      motherCellId: mother.id,
      childCellId: child.id,
      date,
      notes: 'Primera multiplicación de la red',
      createdById: admin.id,
    },
  });
}

/** Seguimientos (llamadas, visitas, mensajes) de los casos de consolidación demo. Idempotente. */
async function seedDemoFollowUps(prisma: PrismaClient, accountId: number) {
  if ((await prisma.followUp.count({ where: { accountId } })) > 0) return;
  const { addDays, todayIn, toDate } = await import('../../../core/time/local-date.js');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const author =
    (await prisma.user.findFirst({ where: { accountId, email: 'demo-pastor@shaddai.local' } })) ??
    (await prisma.user.findFirstOrThrow({ where: { accountId } }));
  const cases = await prisma.consolidationCase.findMany({ where: { accountId }, orderBy: { id: 'asc' } });
  const today = todayIn(account.timezone);
  const kinds = [
    { type: 'call', notes: 'Llamada de bienvenida. Contenta con el culto del domingo.' },
    { type: 'whatsapp', notes: 'Le mandamos la dirección de la célula más cercana.' },
    { type: 'visit', notes: 'Visita en la casa con su familia. Pidió oración por trabajo.' },
  ];
  await prisma.followUp.createMany({
    data: cases.flatMap((c, i) =>
      kinds.slice(0, 1 + (i % kinds.length)).map((k, j) => ({
        accountId,
        personId: c.personId,
        caseId: c.id,
        type: k.type,
        date: toDate(addDays(today, -(2 + i + j * 3))),
        notes: k.notes,
        nextAction: j === 0 ? 'Invitar a la célula' : null,
        nextActionAt: j === 0 ? toDate(addDays(today, 3 + i)) : null,
        createdById: author.id,
      })),
    ),
  });
}
