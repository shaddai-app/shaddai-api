import { Router, type RequestHandler } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import {
  requireAccountUser,
  requirePermission,
  requirePlatformAdmin,
  requireWritableAccount,
} from '../middleware/authorize.js';
import type { PermissionKey } from '../rbac/catalog.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Qué exige una ruta de cuenta:
 * - una o más claves de permiso (basta una), o
 * - 'account-user': cualquier usuario de la cuenta (ej. listar sedes para un selector).
 */
export type TenantAccess = PermissionKey | PermissionKey[] | 'account-user';

export interface RegisteredRoute {
  scope: 'tenant' | 'platform';
  method: Method;
  path: string;
  access: TenantAccess | 'platform-admin';
}

/** Todas las rutas protegidas registradas: el test de permisos las recorre una por una. */
export const routeRegistry: RegisteredRoute[] = [];

type Register = (path: string, access: TenantAccess, ...handlers: RequestHandler[]) => void;

/**
 * Router de negocio: no se puede registrar un endpoint sin declarar su permiso. Encadena
 * autenticación → usuario de cuenta → (escrituras) cuenta no en solo lectura → permiso.
 * `allowReadOnly`: sus escrituras también funcionan con la cuenta en solo lectura (ej. pagar).
 */
export function tenantRouter(options: { allowReadOnly?: boolean } = {}) {
  const router = Router();
  const register =
    (method: Method): Register =>
    (path, access, ...handlers) => {
      routeRegistry.push({ scope: 'tenant', method, path, access });
      const guards: RequestHandler[] = [authenticate(), requireAccountUser];
      if (method !== 'get' && !options.allowReadOnly) guards.push(requireWritableAccount);
      if (access !== 'account-user')
        guards.push(requirePermission(...([] as PermissionKey[]).concat(access)));
      router[method](path, ...guards, ...handlers);
    };
  return {
    router,
    get: register('get'),
    post: register('post'),
    put: register('put'),
    patch: register('patch'),
    delete: register('delete'),
  };
}

type PlatformRegister = (path: string, ...handlers: RequestHandler[]) => void;

/** Router del panel de plataforma: solo superadmin con sesión completa (TOTP ya enrolado). */
export function platformRouter() {
  const router = Router();
  const register =
    (method: Method): PlatformRegister =>
    (path, ...handlers) => {
      routeRegistry.push({ scope: 'platform', method, path, access: 'platform-admin' });
      router[method](path, authenticate(), requirePlatformAdmin, ...handlers);
    };
  return {
    router,
    get: register('get'),
    post: register('post'),
    put: register('put'),
    patch: register('patch'),
    delete: register('delete'),
  };
}
