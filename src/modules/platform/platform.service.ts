import type { z } from 'zod';
import { env } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { generateTemporaryPassword, hashPassword } from '../../core/auth/password.js';
import { prisma } from '../../core/db/prisma.js';
import { AppError } from '../../core/http/errors.js';
import { paged, toSkipTake } from '../../core/http/pagination.js';
import { sendMail } from '../../core/mail/mailer.js';
import { resolveMailLocale, temporaryAccessMail } from '../../core/mail/templates.js';
import { ADMIN_ROLE_KEY } from '../../core/rbac/resolve.js';
import { applyAccountTemplate } from './account-template.js';
import { DEMO_ACCOUNT_ID, DEMO_SLUG } from './demo/constants.js';
import { lastDemoResetAt } from './demo/reset.service.js';
import type {
  AccountStatus,
  AuditQuery,
  ChangeStatusSchema,
  CreateAccountSchema,
  ListAccountsQuery,
  PlanSchema,
  UpdateAccountSchema,
} from './platform.schemas.js';

const RETENTION_DAYS_AFTER_CLOSE = 90;

/** "Iglesia Evangélica Monte Sión" → "iglesia-evangelica-monte-sion" */
export function slugify(value: string): string {
  return (
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/g, '') || 'iglesia'
  );
}

async function uniqueSlug(base: string): Promise<string> {
  const taken = new Set(
    (await prisma.account.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map(
      (a) => a.slug,
    ),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

const accountListSelect = {
  id: true,
  name: true,
  slug: true,
  status: true,
  userLimit: true,
  trialEndsAt: true,
  createdAt: true,
  plan: { select: { id: true, code: true, name: true } },
  _count: { select: { users: { where: { isActive: true, deletedAt: null } } } },
} as const;

export async function listAccounts(query: z.infer<typeof ListAccountsQuery>) {
  const where: Prisma.AccountWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.q ? { OR: [{ name: { contains: query.q } }, { slug: { contains: query.q } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.account.findMany({
      where,
      select: accountListSelect,
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(query),
    }),
    prisma.account.count({ where }),
  ]);
  const items = rows.map(({ _count, ...a }) => ({ ...a, activeUsers: _count.users }));
  return paged(items, total, query);
}

const isDemoAccount = (a: { id: number; slug: string }) => a.id === DEMO_ACCOUNT_ID && a.slug === DEMO_SLUG;

export async function getAccount(id: number) {
  const account = await prisma.account.findUnique({ where: { id }, include: { plan: true } });
  if (!account) throw AppError.notFound('ACCOUNT_NOT_FOUND');
  const isDemo = isDemoAccount(account);
  const [activeUsers, admins, lastReset] = await Promise.all([
    prisma.user.count({ where: { accountId: id, isActive: true, deletedAt: null } }),
    listAccountAdmins(id),
    isDemo ? lastDemoResetAt() : null,
  ]);
  const { storageUsedBytes, ...rest } = account;
  return {
    ...rest,
    isDemo,
    lastDemoResetAt: lastReset,
    usage: { activeUsers, userLimit: account.userLimit, storageUsedMb: Number(storageUsedBytes) / 1_048_576 },
    admins,
  };
}

/** Dueño de la cuenta + usuarios con el rol Administrador. */
export function listAccountAdmins(accountId: number) {
  return prisma.user.findMany({
    where: {
      accountId,
      deletedAt: null,
      OR: [
        { isAccountOwner: true },
        { roles: { some: { role: { systemKey: ADMIN_ROLE_KEY, isLocked: true } } } },
      ],
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      isAccountOwner: true,
      isActive: true,
      mustChangePassword: true,
      lockedUntil: true,
      lastLoginAt: true,
    },
    orderBy: [{ isAccountOwner: 'desc' }, { lastName: 'asc' }],
  });
}

async function maybeSendAccess(
  send: boolean,
  user: { email: string; firstName: string; locale: string | null },
  account: { name: string; defaultLocale: string },
  password: string,
) {
  if (!send) return;
  const locale = resolveMailLocale(user.locale, account.defaultLocale);
  await sendMail({
    to: user.email,
    ...temporaryAccessMail(locale, {
      name: user.firstName,
      church: account.name,
      password,
      url: `${env.APP_URL}/login`,
    }),
  });
}

/**
 * Alta de una iglesia: cuenta + sede principal + roles por defecto + catálogos + usuario admin con
 * contraseña temporal de un solo uso. Todo o nada. La contraseña se devuelve UNA vez.
 */
export async function createAccount(input: z.infer<typeof CreateAccountSchema>) {
  const plan = await prisma.plan.findUnique({ where: { id: input.planId } });
  if (!plan?.isActive) throw AppError.badRequest('PLAN_INVALID');
  if (await prisma.user.findUnique({ where: { email: input.admin.email }, select: { id: true } })) {
    throw AppError.conflict('EMAIL_IN_USE');
  }

  const slug = input.slug ?? (await uniqueSlug(slugify(input.name)));
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const { admin, sendAccessEmail, trialDays, ...accountData } = input;

  const result = await prisma.$transaction(
    async (tx) => {
      const account = await tx.account.create({
        data: {
          ...accountData,
          slug,
          userLimit: input.userLimit ?? plan.userLimit,
          storageLimitMb: input.storageLimitMb ?? plan.storageLimitMb,
          trialEndsAt: input.status === 'trial' ? new Date(Date.now() + trialDays * 86_400_000) : null,
        },
      });
      const { adminRoleId } = await applyAccountTemplate(tx, account.id, input.defaultLocale);
      const user = await tx.user.create({
        data: {
          accountId: account.id,
          email: admin.email,
          firstName: admin.firstName,
          lastName: admin.lastName,
          passwordHash,
          isAccountOwner: true,
          mustChangePassword: true,
          roles: { create: { roleId: adminRoleId } },
        },
      });
      return { account, user };
    },
    { timeout: 20_000 },
  );

  await audit({
    action: 'platform.account.create',
    entity: 'Account',
    entityId: result.account.id,
    accountId: result.account.id,
    after: {
      name: result.account.name,
      slug,
      planId: plan.id,
      status: result.account.status,
      admin: admin.email,
    },
  });
  await maybeSendAccess(sendAccessEmail, result.user, result.account, temporaryPassword);

  return {
    account: await getAccount(result.account.id),
    admin: { id: result.user.id, email: result.user.email },
    temporaryPassword,
  };
}

export async function updateAccount(id: number, input: z.infer<typeof UpdateAccountSchema>) {
  const before = await prisma.account.findUnique({ where: { id } });
  if (!before) throw AppError.notFound('ACCOUNT_NOT_FOUND');
  if (input.planId) {
    const plan = await prisma.plan.findUnique({ where: { id: input.planId } });
    if (!plan) throw AppError.badRequest('PLAN_INVALID');
  }
  const after = await prisma.account.update({ where: { id }, data: input });
  const changed = Object.fromEntries(
    Object.keys(input).map((k) => [
      k,
      { from: before[k as keyof typeof before], to: after[k as keyof typeof after] },
    ]),
  );
  await audit({
    action: 'platform.account.update',
    entity: 'Account',
    entityId: id,
    accountId: id,
    after: changed,
  });
  return getAccount(id);
}

export async function changeAccountStatus(id: number, input: z.infer<typeof ChangeStatusSchema>) {
  const before = await prisma.account.findUnique({
    where: { id },
    select: { id: true, slug: true, status: true },
  });
  if (!before) throw AppError.notFound('ACCOUNT_NOT_FOUND');
  const status: AccountStatus = input.status;
  // La demo existe siempre: no se suspende ni se da de baja (se restablece).
  if (isDemoAccount(before) && (status === 'suspended' || status === 'closed')) {
    throw AppError.conflict('DEMO_ACCOUNT_PROTECTED');
  }
  const closing = status === 'closed';

  await prisma.account.update({
    where: { id },
    data: {
      status,
      closedAt: closing ? new Date() : null,
      purgeAfter: closing ? new Date(Date.now() + RETENTION_DAYS_AFTER_CLOSE * 86_400_000) : null,
    },
  });
  // Suspender/cerrar corta todas las sesiones de la cuenta (authenticate ya las rechazaría igual).
  if (status === 'suspended' || closing) {
    await prisma.refreshToken.updateMany({
      where: { revokedAt: null, user: { accountId: id } },
      data: { revokedAt: new Date(), revokedReason: 'account_' + status },
    });
  }
  await audit({
    action: 'platform.account.status',
    entity: 'Account',
    entityId: id,
    accountId: id,
    before: { status: before.status },
    after: { status, reason: input.reason },
  });
  return getAccount(id);
}

/** Reset por el superadmin: nueva contraseña temporal, desbloqueo y cierre de sesiones. */
export async function resetAdminPassword(accountId: number, userId: number, sendAccessEmail: boolean) {
  const user = await prisma.user.findFirst({
    where: { id: userId, accountId, deletedAt: null },
    include: { account: true },
  });
  if (!user?.account) throw AppError.notFound('USER_NOT_FOUND');

  const temporaryPassword = generateTemporaryPassword();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      passwordChangedAt: new Date(), // invalida access tokens vigentes
      failedLoginCount: 0,
      lockoutLevel: 0,
      lockedUntil: null,
    },
  });
  await prisma.refreshToken.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'admin' },
  });
  await audit({ action: 'platform.admin.reset_password', entity: 'User', entityId: user.id, accountId });
  await maybeSendAccess(sendAccessEmail, user, user.account, temporaryPassword);
  return { user: { id: user.id, email: user.email }, temporaryPassword };
}

export const listPlans = () => prisma.plan.findMany({ orderBy: { userLimit: 'asc' } });

export async function createPlan(input: z.infer<typeof PlanSchema>) {
  const plan = await prisma.plan.create({ data: input });
  await audit({ action: 'platform.plan.create', entity: 'Plan', entityId: plan.id, after: input });
  return plan;
}

export async function updatePlan(id: number, input: Partial<z.infer<typeof PlanSchema>>) {
  const plan = await prisma.plan.update({ where: { id }, data: input });
  await audit({ action: 'platform.plan.update', entity: 'Plan', entityId: id, after: input });
  return plan;
}

export async function platformStats() {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [byStatus, activeUsers, newAccounts] = await Promise.all([
    prisma.account.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.user.count({ where: { accountId: { not: null }, isActive: true, deletedAt: null } }),
    prisma.account.count({ where: { createdAt: { gte: since } } }),
  ]);
  return {
    accountsByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    activeUsers,
    newAccountsLast30Days: newAccounts,
  };
}

export async function listAudit(query: z.infer<typeof AuditQuery>) {
  const where: Prisma.AuditLogWhereInput = {
    ...(query.accountId ? { accountId: query.accountId } : {}),
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.action ? { action: { startsWith: query.action } } : {}),
    ...(query.from || query.to ? { createdAt: { gte: query.from, lte: query.to } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, ...toSkipTake(query) }),
    prisma.auditLog.count({ where }),
  ]);
  const parseJson = (v: string | null) => (v === null ? null : (JSON.parse(v) as unknown));
  const items = rows.map((r) => ({
    ...r,
    id: r.id.toString(),
    before: parseJson(r.before),
    after: parseJson(r.after),
  }));
  return paged(items, total, query);
}
