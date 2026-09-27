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
}

/**
 * Casos de consolidación de ejemplo para visitantes y nuevos: algunos asignados a demo-pastor,
 * con pasos avanzados y uno vencido. Idempotente.
 */
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
