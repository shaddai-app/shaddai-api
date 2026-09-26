// Recuperación del 2FA del superadmin si pierde el celular. Requiere acceso a la PC/servidor con .env,
// por eso no hay un endpoint equivalente. Uso: npm run admin:reset-2fa -- email@dominio.com
import { audit } from '../src/core/audit/audit.js';
import { prisma } from '../src/core/db/prisma.js';
import { revokeAllSessions } from '../src/modules/auth/session.service.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Uso: npm run admin:reset-2fa -- email@dominio.com');
  process.exit(1);
}

const user = await prisma.user.findUnique({ where: { email } });
if (!user?.isPlatformAdmin) {
  console.error(`No existe un superadmin con email ${email}.`);
  process.exit(1);
}

await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecretEnc: null } });
await revokeAllSessions(user.id, 'admin');
await audit({
  action: 'auth.totp.reset_cli',
  entity: 'User',
  entityId: user.id,
  userId: user.id,
  accountId: null,
});
console.log(`✔ 2FA reseteado para ${email}. En el próximo login deberá enrolarlo de nuevo.`);
await prisma.$disconnect();
