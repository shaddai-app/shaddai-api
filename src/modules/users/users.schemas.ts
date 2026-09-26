import { z } from 'zod';
import { PaginationQuery } from '../../core/http/pagination.js';

const email = z.string().trim().toLowerCase().pipe(z.email().max(150));
const name = z.string().trim().min(1).max(80);
const roleIds = z.array(z.number().int().positive()).max(20);

export const IdParam = z.object({ id: z.coerce.number().int().positive() });

export const ListUsersQuery = PaginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  roleId: z.coerce.number().int().positive().optional(),
});

export const CreateUserSchema = z
  .object({
    email,
    firstName: name,
    lastName: name,
    locale: z.enum(['es', 'en', 'pt']).nullable().optional(),
    roleIds: roleIds.default([]),
    sendAccessEmail: z.boolean().default(false),
  })
  .strict();

export const UpdateUserSchema = z
  .object({
    firstName: name,
    lastName: name,
    locale: z.enum(['es', 'en', 'pt']).nullable(),
    roleIds,
  })
  .partial()
  .strict();

export const ResetPasswordSchema = z.object({ sendAccessEmail: z.boolean().default(false) }).strict();
