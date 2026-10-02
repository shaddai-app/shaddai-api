// Corre el aviso diario de vencidos ya mismo, sin esperar la hora (soporte o pruebas). No repite
// avisos ya enviados. Uso: npm run jobs:daily-notices [-- slug-de-la-iglesia]
import { prisma } from '../src/core/db/prisma.js';
import { runDailyNotices } from '../src/modules/notifications/daily.js';
import { emailsSettled } from '../src/modules/notifications/notifications.service.js';

const slug = process.argv[2]?.trim();
const accounts = await prisma.account.findMany({
  where: slug ? { slug } : { status: { in: ['trial', 'active', 'past_due'] } },
  select: { id: true, slug: true },
});
if (!accounts.length) {
  console.error(slug ? `No existe una iglesia con slug ${slug}.` : 'No hay iglesias activas.');
  process.exit(1);
}
for (const account of accounts) {
  const result = await runDailyNotices(account.id, { force: true });
  console.log(`✔ ${account.slug}: ${result?.notices ?? 0} avisos (${result?.today})`);
}
await emailsSettled();
await prisma.$disconnect();
