import type { Request, RequestHandler } from 'express';
import { AppError } from '../http/errors.js';
import type { PermissionKey, PermissionScope } from '../rbac/catalog.js';
import { getPermissions } from '../rbac/permission-cache.js';
import { authOf } from './authenticate.js';

/** Rutas de negocio: solo usuarios de una cuenta (el superadmin entra a una cuenta impersonando). */
export const requireAccountUser: RequestHandler = (req, _res, next) => {
  if (authOf(req).accountId === null) throw AppError.forbidden('ACCOUNT_USER_REQUIRED');
  next();
};

export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  if (!authOf(req).isPlatformAdmin) throw AppError.forbidden('PLATFORM_ADMIN_REQUIRED');
  next();
};

/** Cuenta morosa o con prueba vencida: solo lectura. */
export const requireWritableAccount: RequestHandler = (req, _res, next) => {
  if (authOf(req).accountReadOnly) throw AppError.forbidden('ACCOUNT_READ_ONLY');
  next();
};

/** Exige al menos uno de los permisos (OR). */
export function requirePermission(...keys: PermissionKey[]): RequestHandler {
  return async (req, _res, next) => {
    const auth = authOf(req);
    auth.permissions ??= await getPermissions(auth.userId);
    if (!keys.some((k) => auth.permissions![k])) {
      throw AppError.forbidden('PERMISSION_DENIED', { required: keys });
    }
    next();
  };
}

/** Alcance con el que el usuario tiene el permiso ("all" gana si lo tiene por algún rol). */
export function scopeOf(req: Request, key: PermissionKey): PermissionScope | undefined {
  return authOf(req).permissions?.[key];
}

/** Para chequeos finos dentro de un handler (ej. mostrar campos sensibles). */
export async function hasPermission(req: Request, key: PermissionKey): Promise<boolean> {
  const auth = authOf(req);
  auth.permissions ??= await getPermissions(auth.userId);
  return Boolean(auth.permissions[key]);
}
