import { createHash, timingSafeEqual } from 'node:crypto';
import { isProd } from '../../../config/env.js';
import { audit } from '../../../core/audit/audit.js';
import { hashPassword } from '../../../core/auth/password.js';
import { wipeAccountData } from '../../../core/db/account-data.js';
import { prisma } from '../../../core/db/prisma.js';
import { AppError } from '../../../core/http/errors.js';
import { logger } from '../../../core/logger.js';
import { invalidateAllPermissions } from '../../../core/rbac/permission-cache.js';
import { applyAccountTemplate } from '../account-template.js';
import {
  DEMO_ACCOUNT_DEFAULTS,
  DEMO_ACCOUNT_ID,
  DEMO_ADMIN_EMAIL,
  DEMO_PASSWORD,
  DEMO_SLUG,
  DEMO_USERS,
  QA_USERS,
} from './constants.js';
import { seedDemoData } from './data.js';
import { syncDemoUsers } from './users.js';

const LOCK_KEY = 'demo-reset';
const LOCK_MS = 10 * 60_000;

export type DemoResetInput = { accountId: number; email: string; password: string };

/** Compara sin filtrar por tiempo cuántos caracteres coinciden. */
const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/**
 * Restablece la iglesia demo: borra todo lo que cargaron los visitantes y la deja como recién creada
 * (configuración, roles, catálogos, usuarios demo y datos de ejemplo con fechas relativas a hoy).
 *
 * Para no tocar nunca otra iglesia pide las credenciales de la demo (mail del admin demo y
 * DEMO_PASSWORD, no la de la base: un visitante puede cambiarla) y verifica
 * que el id de la pantalla, el del usuario de esas credenciales y la cuenta 1 con slug iglesia-demo
 * sean la misma cuenta. Sin transacción global (el seed usa servicios con su propio cliente): si se
 * corta, se vuelve a correr.
 */
export async function resetDemoAccount(input: DemoResetInput, actorUserId: number) {
  if (input.email.trim().toLowerCase() !== DEMO_ADMIN_EMAIL || !sameSecret(input.password, DEMO_PASSWORD)) {
    await audit({
      action: 'platform.demo.reset_denied',
      entity: 'Account',
      entityId: input.accountId,
      userId: actorUserId,
      // Sin lo tipeado: alguien puede pegar la contraseña en el campo del mail.
      after: { emailMatches: input.email.trim().toLowerCase() === DEMO_ADMIN_EMAIL },
    });
    throw AppError.forbidden('DEMO_CREDENTIALS_INVALID');
  }
  if (input.accountId !== DEMO_ACCOUNT_ID) throw AppError.badRequest('DEMO_CONFIRMATION_MISMATCH');

  const [account, foreignDemoUsers] = await Promise.all([
    prisma.account.findUnique({ where: { id: DEMO_ACCOUNT_ID }, select: { slug: true } }),
    // Los usuarios demo (empezando por el de las credenciales) que existan tienen que ser de la cuenta
    // demo. Si un visitante borró o renombró alguno, no está: se vuelve a crear. Se verifica antes de
    // borrar nada, para no dejar la demo vacía si después no se pudieran recrear.
    prisma.user.count({
      where: {
        email: { in: DEMO_USERS.map((u) => u.email) },
        OR: [{ accountId: null }, { accountId: { not: DEMO_ACCOUNT_ID } }],
      },
    }),
  ]);
  if (account?.slug !== DEMO_SLUG || foreignDemoUsers > 0) {
    throw AppError.conflict('DEMO_ACCOUNT_INVALID');
  }

  await acquireLock();
  const started = Date.now();
  try {
    const keepEmails = [...DEMO_USERS.map((u) => u.email), ...(isProd ? [] : Object.keys(QA_USERS))];
    const keep = await prisma.user.findMany({
      where: { accountId: DEMO_ACCOUNT_ID, email: { in: keepEmails } },
      select: { id: true },
    });
    const { files, rows } = await wipeAccountData(DEMO_ACCOUNT_ID, { keepUserIds: keep.map((u) => u.id) });

    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: DEMO_ACCOUNT_DEFAULTS.planCode } });
    await prisma.$transaction(
      async (tx) => {
        await tx.account.update({
          where: { id: DEMO_ACCOUNT_ID },
          data: {
            name: DEMO_ACCOUNT_DEFAULTS.name,
            status: 'active',
            planId: plan.id,
            userLimit: plan.userLimit,
            storageLimitMb: plan.storageLimitMb,
            storageUsedBytes: 0,
            trialEndsAt: null,
            paidUntil: null,
            defaultLocale: DEMO_ACCOUNT_DEFAULTS.defaultLocale,
            timezone: DEMO_ACCOUNT_DEFAULTS.timezone,
            currency: DEMO_ACCOUNT_DEFAULTS.currency,
            weekStartsOn: 1,
            primaryColor: 'slate',
            logoFileId: null,
            legalName: null,
            taxId: null,
            taxCondition: null,
            ccliLicense: null,
            email: null,
            phone: null,
            address: null,
            cellMultiplyTarget: 12,
            cellReportEditDays: 7,
            structureLabels: null,
            notes: null,
            closedAt: null,
            purgeAfter: null,
          },
        });
        await applyAccountTemplate(tx, DEMO_ACCOUNT_ID, DEMO_ACCOUNT_DEFAULTS.defaultLocale);
      },
      { timeout: 20_000 },
    );

    await syncDemoUsers(prisma, DEMO_ACCOUNT_ID, await hashPassword(DEMO_PASSWORD), { includeQa: !isProd });
    invalidateAllPermissions();
    await seedDemoData(prisma, DEMO_ACCOUNT_ID);

    const durationMs = Date.now() - started;
    await audit({
      action: 'platform.demo.reset',
      entity: 'Account',
      entityId: DEMO_ACCOUNT_ID,
      accountId: DEMO_ACCOUNT_ID,
      userId: actorUserId,
      after: { deletedRows: rows, deletedFiles: files, durationMs },
    });
    logger.info({ deletedRows: rows, deletedFiles: files, durationMs }, 'demo account reset');
    return { deletedRows: rows, durationMs };
  } finally {
    await prisma.platformLock.deleteMany({ where: { key: LOCK_KEY } });
  }
}

/** Fecha del último restablecimiento de la demo (de la auditoría), o null. */
export async function lastDemoResetAt(): Promise<Date | null> {
  const last = await prisma.auditLog.findFirst({
    where: { accountId: DEMO_ACCOUNT_ID, action: 'platform.demo.reset' },
    orderBy: { id: 'desc' },
    select: { createdAt: true },
  });
  return last?.createdAt ?? null;
}

/** Un solo restablecimiento a la vez entre réplicas. Una traba vencida (réplica caída) se retoma. */
async function acquireLock() {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + LOCK_MS);
  try {
    await prisma.platformLock.create({ data: { key: LOCK_KEY, lockedUntil } });
    return;
  } catch {
    // Ya hay una traba: solo se toma si venció.
  }
  const taken = await prisma.platformLock.updateMany({
    where: { key: LOCK_KEY, lockedUntil: { lt: now } },
    data: { lockedUntil },
  });
  if (taken.count === 0) throw AppError.conflict('DEMO_RESET_IN_PROGRESS');
}
