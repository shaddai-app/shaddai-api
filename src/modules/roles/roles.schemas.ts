import { z } from 'zod';

export const IdParam = z.object({ id: z.coerce.number().int().positive() });

/** { "celulas.ver": "own", "finanzas.ver": "all" }. Permiso ausente = sin permiso. */
const grants = z.record(z.string().regex(/^[a-z]+\.[a-z_]+$/), z.enum(['all', 'own']));

export const CreateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(250).nullable().optional(),
    grants: grants.default({}),
  })
  .strict();

export const UpdateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(250).nullable(),
    grants,
  })
  .partial()
  .strict();

export const MatrixSchema = z.object({ grants: z.record(z.string().regex(/^\d+$/), grants) }).strict();
