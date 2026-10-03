import type { RequestHandler } from 'express';
import { DEMO_ACCOUNT_ID, DEMO_SLUG, DEMO_USERS } from '../modules/platform/demo/constants.js';
import { prisma } from './db/prisma.js';
import { AppError } from './http/errors.js';
import { authOf } from './middleware/authenticate.js';

/**
 * Bloqueos de la iglesia demo (cuenta 1, contraseña pública): se puede recorrer entera, pero no se
 * puede romper para el próximo visitante ni usar para abuso (mails, baja, cobros). Misma regla que el
 * restablecimiento: la cuenta 1 con slug iglesia-demo; si la cuenta 1 es otra, no se bloquea nada.
 */
const CACHE_MS = 60_000;
let cached: { isDemo: boolean; until: number } | null = null;

export async function isDemoAccount(accountId: number | null | undefined): Promise<boolean> {
  if (accountId !== DEMO_ACCOUNT_ID) return false;
  if (cached && cached.until > Date.now()) return cached.isDemo;
  const account = await prisma.account.findUnique({ where: { id: DEMO_ACCOUNT_ID }, select: { slug: true } });
  cached = { isDemo: account?.slug === DEMO_SLUG, until: Date.now() + CACHE_MS };
  return cached.isDemo;
}

/** Para los tests: olvida el slug cacheado. */
export function forgetDemoAccountCache() {
  cached = null;
}

export async function assertNotDemo(accountId: number | null | undefined) {
  if (await isDemoAccount(accountId)) throw AppError.forbidden('DEMO_ACTION_BLOCKED');
}

/** Ruta bloqueada para los usuarios de la demo. Va después de authenticate(). */
export const forbidInDemo: RequestHandler = (req, _res, next) => {
  assertNotDemo(authOf(req).accountId).then(() => next(), next);
};

const DEMO_EMAILS = new Set<string>(DEMO_USERS.map((u) => u.email));

/** Los 4 usuarios demo: compartidos por todos los visitantes, no se editan ni desactivan. */
export const isDemoUserEmail = (email: string) => DEMO_EMAILS.has(email.toLowerCase());

/** ¿Es uno de los 4 usuarios demo de la cuenta demo? */
export async function isSharedDemoUser(userId: number, accountId: number | null | undefined) {
  if (!(await isDemoAccount(accountId))) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return Boolean(user && isDemoUserEmail(user.email));
}

/**
 * Seguridad de la cuenta propia (contraseña, 2FA, sesiones) bloqueada para los 4 usuarios demo: si
 * un visitante la cambia, deja afuera a los demás. Los usuarios que crean los visitantes sí pueden
 * (nacen con contraseña temporal y la tienen que cambiar). Va después de authenticate().
 */
export const forbidForDemoUsers: RequestHandler = (req, _res, next) => {
  const { userId, accountId } = authOf(req);
  isSharedDemoUser(userId, accountId).then(
    (blocked) => next(blocked ? AppError.forbidden('DEMO_ACTION_BLOCKED') : undefined),
    next,
  );
};
