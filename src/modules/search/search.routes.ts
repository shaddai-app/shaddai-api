import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { tenantDb } from '../../core/db/tenant.js';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { peopleWhereFor, scopeOf, viewerOf } from '../people/people.scope.js';
import { catalogRef, peopleListWhere } from '../people/people.service.js';

const t = tenantRouter();
export const searchRouter = t.router;

const LIMIT = 6;

/**
 * Búsqueda global (Ctrl+K). Cualquier usuario puede llamarla; cada grupo solo aparece si tiene el
 * permiso correspondiente y respeta su alcance. Cada módulo nuevo (células, canciones…) suma su grupo.
 */
t.get('/search', 'account-user', async (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
  const viewer = await viewerOf(req);
  const db = tenantDb();
  // Hogares y usuarios no tienen columna plegada: se busca tal cual se escribió (CI_AS distingue
  // acentos). Las personas sí ignoran acentos (searchText).
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, 5);

  const people = scopeOf(viewer, 'personas.ver')
    ? db.person.findMany({
        where: peopleListWhere(viewer, { q, sort: 'name' }),
        select: {
          id: true,
          firstName: true,
          lastName: true,
          preferredName: true,
          photoFileId: true,
          status: { select: catalogRef },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: LIMIT,
      })
    : Promise.resolve([]);

  const peopleScope = peopleWhereFor(viewer, 'personas.ver');
  const householdScope: Prisma.HouseholdWhereInput | null = !peopleScope
    ? null
    : Object.keys(peopleScope).length === 0
      ? {}
      : { members: { some: { AND: [{ deletedAt: null }, peopleScope] } } };
  const households = householdScope
    ? db.household.findMany({
        where: { AND: [householdScope, ...tokens.map((tk) => ({ name: { contains: tk } }))] },
        select: { id: true, name: true, city: true },
        orderBy: { name: 'asc' },
        take: LIMIT,
      })
    : Promise.resolve([]);

  const users = scopeOf(viewer, 'usuarios.ver')
    ? db.user.findMany({
        where: {
          deletedAt: null,
          AND: tokens.map((tk) => ({
            OR: [
              { firstName: { contains: tk } },
              { lastName: { contains: tk } },
              { email: { contains: tk } },
            ],
          })),
        },
        select: { id: true, firstName: true, lastName: true, email: true, isActive: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: LIMIT,
      })
    : Promise.resolve([]);

  const [p, h, u] = await Promise.all([people, households, users]);
  res.json({ people: p, households: h, users: u });
});
