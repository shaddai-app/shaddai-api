import type { Prisma } from '../../generated/prisma/client.js';
import { PERMISSIONS, type PermissionScope } from '../../core/rbac/catalog.js';
import { ADMIN_ROLE_KEY } from '../../core/rbac/resolve.js';
import { DEFAULT_ROLES } from '../../core/rbac/default-roles.js';
import { DEFAULT_STEPS } from '../consolidation/consolidation.service.js';

type Locale = 'es' | 'en' | 'pt';
type Tx = Prisma.TransactionClient;

/** Catálogos iniciales. name = null → el front los muestra traducidos por systemKey. */
export const DEFAULT_CATALOGS: Record<string, string[]> = {
  person_status: ['visitor', 'new', 'attendee', 'member', 'inactive', 'transferred', 'deceased'],
  milestone: ['conversion', 'water_baptism', 'membership', 'encounter', 'leaders_school', 'ordination'],
  position: ['pastor', 'elder', 'deacon', 'leader'],
  inventory_category: ['audio', 'video', 'lighting', 'instruments', 'computers', 'cables', 'furniture'],
  event_type: ['sunday_service', 'prayer_meeting', 'youth', 'conference', 'retreat'],
};

const MAIN_CAMPUS_NAME: Record<Locale, string> = {
  es: 'Sede principal',
  en: 'Main campus',
  pt: 'Sede principal',
};

const supportsScope = new Map(PERMISSIONS.map((p) => [p.key, p.supportsScope]));

/**
 * Crea todo lo que una cuenta nueva necesita para funcionar: sede principal, roles por defecto
 * y catálogos. Devuelve el id del rol Administrador. Corre dentro de la transacción de alta.
 */
export async function applyAccountTemplate(
  tx: Tx,
  accountId: number,
  locale: Locale,
): Promise<{ adminRoleId: number }> {
  await tx.campus.create({ data: { accountId, name: MAIN_CAMPUS_NAME[locale], isMain: true } });

  const permissionIds = new Map(
    (await tx.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]),
  );

  let adminRoleId = 0;
  for (const role of DEFAULT_ROLES) {
    const permissions = Object.entries(role.grants).map(([key, scope]) => {
      const permissionId = permissionIds.get(key);
      if (!permissionId) throw new Error(`Permiso ${key} no sembrado: corré el seed.`);
      // Un permiso sin alcance "own" se guarda como "all".
      const finalScope: PermissionScope = supportsScope.get(key as never) ? scope! : 'all';
      return { permissionId, scope: finalScope };
    });
    const created = await tx.role.create({
      data: {
        accountId,
        name: role.names[locale],
        description: role.description[locale],
        systemKey: role.systemKey,
        isLocked: role.isLocked ?? false,
        permissions: { create: permissions },
      },
    });
    if (role.systemKey === ADMIN_ROLE_KEY) adminRoleId = created.id;
  }

  await tx.catalogItem.createMany({
    data: Object.entries(DEFAULT_CATALOGS).flatMap(([type, keys]) =>
      keys.map((systemKey, i) => ({ accountId, type, systemKey, sortOrder: (i + 1) * 10 })),
    ),
  });

  await tx.consolidationStep.createMany({
    data: DEFAULT_STEPS.map(([systemKey, dueDays], i) => ({
      accountId,
      systemKey,
      dueDays,
      sortOrder: (i + 1) * 10,
    })),
  });

  return { adminRoleId };
}
