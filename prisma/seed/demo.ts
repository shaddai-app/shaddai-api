import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { hashPassword } from '../../src/core/auth/password.js';

export const DEMO_SLUG = 'iglesia-demo';

/**
 * SOLO DESARROLLO (SEED_DEMO=true): iglesia de prueba con usuarios de distintos roles para probar el
 * front sin usar la cuenta del superadmin. Todos comparten SEED_DEMO_PASSWORD (definida en .env).
 */
const DEMO_USERS = [
  { email: 'demo-admin@shaddai.local', firstName: 'Admin', lastName: 'Demo', role: 'admin', owner: true },
  { email: 'demo-pastor@shaddai.local', firstName: 'Pastor', lastName: 'Demo', role: 'pastor' },
  { email: 'demo-tesorero@shaddai.local', firstName: 'Tesorero', lastName: 'Demo', role: 'treasurer' },
  { email: 'demo-lider@shaddai.local', firstName: 'Líder', lastName: 'Demo', role: 'cell_leader' },
] as const;

export async function seedDemo(prisma: PrismaClient) {
  if (process.env.SEED_DEMO !== 'true') return;
  if (process.env.NODE_ENV === 'production') throw new Error('SEED_DEMO no se usa en producción.');
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 12)
    throw new Error('Definí SEED_DEMO_PASSWORD (12+ caracteres) en .env');

  const existing = await prisma.account.findUnique({ where: { slug: DEMO_SLUG } });
  if (existing) {
    console.log('✔ Iglesia demo ya existe');
    await seedDemoPeople(prisma, existing.id);
    await seedDemoCells(prisma, existing.id);
    await seedDemoReports(prisma, existing.id);
    await seedDemoConsolidation(prisma, existing.id);
    await seedDemoFinance(prisma, existing.id);
    await seedDemoOfferings(prisma, existing.id);
    await seedDemoPeriods(prisma, existing.id);
    await seedDemoCalendar(prisma, existing.id);
    await seedDemoRegistrations(prisma, existing.id);
    await seedDemoAttendance(prisma, existing.id);
    return;
  }

  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'standard' } });
  const { createAccount } = await import('../../src/modules/platform/platform.service.js');
  const [owner, ...others] = DEMO_USERS;
  const { account, admin } = await createAccount({
    name: 'Iglesia Demo',
    slug: DEMO_SLUG,
    planId: plan.id,
    status: 'active',
    trialDays: 30,
    defaultLocale: 'es',
    timezone: 'America/Argentina/Buenos_Aires',
    currency: 'ARS',
    sendAccessEmail: false,
    admin: { email: owner.email, firstName: owner.firstName, lastName: owner.lastName },
  });

  const passwordHash = await hashPassword(password);
  await prisma.user.update({ where: { id: admin.id }, data: { passwordHash, mustChangePassword: false } });

  const roles = await prisma.role.findMany({ where: { accountId: account.id } });
  for (const u of others) {
    const role = roles.find((r) => r.systemKey === u.role)!;
    await prisma.user.create({
      data: {
        accountId: account.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        passwordHash,
        mustChangePassword: false,
        roles: { create: { roleId: role.id } },
      },
    });
  }
  console.log(`✔ Iglesia demo creada con ${DEMO_USERS.length} usuarios (contraseña: SEED_DEMO_PASSWORD)`);
  await seedDemoPeople(prisma, account.id);
  await seedDemoCells(prisma, account.id);
  await seedDemoReports(prisma, account.id);
  await seedDemoConsolidation(prisma, account.id);
  await seedDemoFinance(prisma, account.id);
  await seedDemoOfferings(prisma, account.id);
  await seedDemoPeriods(prisma, account.id);
  await seedDemoCalendar(prisma, account.id);
  await seedDemoRegistrations(prisma, account.id);
  await seedDemoAttendance(prisma, account.id);
}

/**
 * Casos de consolidación de ejemplo para visitantes y nuevos: algunos asignados a demo-pastor,
 * con pasos avanzados y uno vencido. Idempotente.
 */
/**
 * Libro de caja de ejemplo (~3 meses): diezmos nominales y ofrendas de los domingos, alquiler y
 * servicios mensuales, depósitos de la caja al banco y una caja en dólares. Idempotente.
 */
async function seedDemoFinance(prisma: PrismaClient, accountId: number) {
  if ((await prisma.financeMovement.count({ where: { accountId } })) > 0) return;
  const { CATEGORY_KINDS, DEFAULT_CATEGORIES } = await import('../../src/modules/finance/finance.service.js');
  const { addDays, dayOfWeek, todayIn, toDate } = await import('../../src/core/time/local-date.js');
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
  console.log(`✔ ${rows.length} movimientos y ${transfers} transferencias de ejemplo en 3 cajas`);
}

/**
 * Pendientes y arqueos de ejemplo: las ofrendas de célula de las últimas dos semanas quedan
 * pendientes (las anteriores, confirmadas en la caja general), un arqueo confirmado de la reunión de
 * oración del miércoles y un borrador del último domingo con billetes y sobres nominales. Idempotente.
 */
async function seedDemoOfferings(prisma: PrismaClient, accountId: number) {
  if ((await prisma.offeringCount.count({ where: { accountId } })) > 0) return;
  const { addDays, dayOfWeek, todayIn, toDate } = await import('../../src/core/time/local-date.js');
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
  console.log(`✔ ${reports.length} ofrendas de célula (pendientes las recientes) y 2 arqueos de ejemplo`);
}

/** Las 19 h de Argentina (22 h UTC) del día + days: hora creíble para las fechas de confirmación. */
const eveningOf = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000 + 22 * 3_600_000);

/**
 * Cierres de ejemplo: los meses viejos quedan cerrados y el anterior al actual abierto (para probar el
 * cierre). Usa el mismo servicio que la API, con un contexto armado a mano. Idempotente.
 */
async function seedDemoPeriods(prisma: PrismaClient, accountId: number) {
  if ((await prisma.financePeriod.count({ where: { accountId } })) > 0) return;
  const { runInContext } = await import('../../src/core/context.js');
  const { closePeriod, listPeriods } = await import('../../src/modules/finance/periods.service.js');
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
  console.log(`✔ ${closed} meses cerrados de ejemplo`);
}

/**
 * Calendario de ejemplo: cultos de los domingos (10 y 18 h), reunión de oración de los miércoles,
 * reunión de líderes el primer sábado de cada mes, un miércoles feriado cancelado, un culto con
 * horario especial y dos eventos especiales. Usa el servicio de la API. Idempotente.
 */
async function seedDemoCalendar(prisma: PrismaClient, accountId: number) {
  if ((await prisma.calendarEvent.count({ where: { accountId } })) > 0) return;
  const { runInContext } = await import('../../src/core/context.js');
  const { addDays, dayOfWeek, todayIn } = await import('../../src/core/time/local-date.js');
  const calendar = await import('../../src/modules/calendar/calendar.service.js');
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
  console.log('✔ Calendario de ejemplo: 4 series, 2 excepciones y 2 eventos especiales');
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
  console.log('✔ Inscripciones de ejemplo: retiro (11 de 12, público) y bautismos');
}

/**
 * Asistencia de ejemplo de los cultos de los últimos 3 meses (con una tendencia en alza y alguna
 * semana floja). Deja sin cargar el último culto, para ver los pendientes. Idempotente.
 */
async function seedDemoAttendance(prisma: PrismaClient, accountId: number) {
  if ((await prisma.serviceAttendance.count({ where: { accountId } })) > 0) return;
  const { runInContext } = await import('../../src/core/context.js');
  const { addDays, todayIn } = await import('../../src/core/time/local-date.js');
  const attendance = await import('../../src/modules/calendar/attendance.service.js');
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
  console.log(`✔ Asistencia de ejemplo: ${saved} cultos cargados y el último pendiente`);
}

async function seedDemoConsolidation(prisma: PrismaClient, accountId: number) {
  if ((await prisma.consolidationCase.count({ where: { accountId } })) > 0) return;
  const { DEFAULT_STEPS } = await import('../../src/modules/consolidation/consolidation.service.js');
  const { addDays, todayIn, toDate } = await import('../../src/core/time/local-date.js');
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
  console.log(`✔ ${people.length} casos de consolidación de ejemplo`);
}

/**
 * Reportes de las últimas 4 semanas para las células demo (una célula sin reportar la semana
 * pasada y una reunión suspendida), para que el semáforo tenga colores. Idempotente.
 */
async function seedDemoReports(prisma: PrismaClient, accountId: number) {
  if ((await prisma.cellReport.count({ where: { accountId } })) > 0) return;
  const { addDays, meetingDateInWeek, todayIn, toDate, weekStart } =
    await import('../../src/core/time/local-date.js');
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
  console.log(`✔ ${created} reportes de célula de ejemplo`);
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
  console.log(`✔ ${cells.length} células de ejemplo en ${zones.length} zonas`);
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
  const { searchTextOf } = await import('../../src/modules/people/people.service.js');
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
  console.log(`✔ ${n} personas de ejemplo en la iglesia demo`);
}
