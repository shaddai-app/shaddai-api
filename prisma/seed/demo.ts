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
