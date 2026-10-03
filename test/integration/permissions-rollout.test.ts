import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { seedPermissions } from '../../prisma/seed/permissions.js';
import { prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const grantsOf = async (roleId: number) =>
  (await prisma.rolePermission.findMany({ where: { roleId }, include: { permission: true } })).map(
    (rp) => rp.permission.key,
  );

describe('permisos nuevos en iglesias que ya existen', () => {
  it('el seed los da a los roles del sistema según la matriz, una sola vez', async () => {
    const church = await provisionChurch();
    const pastor = church.roleId('pastor');
    const treasurer = church.roleId('treasurer');
    // Simula que "anuncios.gestionar" es un permiso nuevo: no existía cuando se creó la iglesia.
    const permission = await prisma.permission.findUniqueOrThrow({ where: { key: 'anuncios.gestionar' } });
    await prisma.rolePermission.deleteMany({ where: { permissionId: permission.id } });
    await prisma.permission.delete({ where: { id: permission.id } });

    await seedPermissions(prisma);
    expect(await grantsOf(pastor)).toContain('anuncios.gestionar');
    expect(await grantsOf(treasurer)).not.toContain('anuncios.gestionar');

    // Si la iglesia se lo saca al pastor, el próximo seed no se lo vuelve a dar.
    const again = await prisma.permission.findUniqueOrThrow({ where: { key: 'anuncios.gestionar' } });
    await prisma.rolePermission.deleteMany({ where: { roleId: pastor, permissionId: again.id } });
    await seedPermissions(prisma);
    expect(await grantsOf(pastor)).not.toContain('anuncios.gestionar');
  });
});
