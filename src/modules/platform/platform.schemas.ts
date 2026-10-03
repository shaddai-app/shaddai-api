import { z } from 'zod';
import { PaginationQuery } from '../../core/http/pagination.js';

export const ACCOUNT_STATUSES = ['trial', 'active', 'past_due', 'suspended', 'closed'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

const locale = z.enum(['es', 'en', 'pt']);
const email = z.string().trim().toLowerCase().pipe(z.email().max(150));
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** Días de prueba gratis por defecto al dar de alta una iglesia (también los muestra la landing). */
export const DEFAULT_TRIAL_DAYS = 30;

export const IdParam = z.object({ id: z.coerce.number().int().positive() });
export const AccountUserParams = z.object({
  id: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
});

const accountFields = {
  name: z.string().trim().min(2).max(150),
  planId: z.number().int().positive(),
  userLimit: z.number().int().min(1).max(10_000),
  storageLimitMb: z.number().int().min(0).max(1_000_000),
  defaultLocale: locale,
  timezone: z.string().trim().min(1).max(50),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((c) => c.toUpperCase()),
  legalName: optionalText(150),
  taxId: z
    .string()
    .trim()
    .regex(/^\d{2}-?\d{8}-?\d$/, 'CUIT inválido')
    .nullable()
    .optional(),
  taxCondition: optionalText(30),
  email: email.nullable().optional(),
  phone: optionalText(30),
  address: optionalText(250),
  notes: optionalText(4000),
};

export const CreateAccountSchema = z
  .object({
    ...accountFields,
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(60)
      .optional(),
    // Si faltan, se toman del plan.
    userLimit: accountFields.userLimit.optional(),
    storageLimitMb: accountFields.storageLimitMb.optional(),
    defaultLocale: locale.default('es'),
    timezone: accountFields.timezone.default('America/Argentina/Buenos_Aires'),
    currency: accountFields.currency.default('ARS'),
    status: z.enum(['trial', 'active']).default('trial'),
    trialDays: z.number().int().min(1).max(365).default(DEFAULT_TRIAL_DAYS),
    admin: z.object({
      email,
      firstName: z.string().trim().min(1).max(80),
      lastName: z.string().trim().min(1).max(80),
    }),
    sendAccessEmail: z.boolean().default(false),
  })
  .strict();

export const UpdateAccountSchema = z
  .object({ ...accountFields, trialEndsAt: z.coerce.date().nullable() })
  .partial()
  .strict();

export const ChangeStatusSchema = z
  .object({ status: z.enum(ACCOUNT_STATUSES), reason: z.string().trim().min(3).max(500) })
  .strict();

export const ResetAdminSchema = z.object({ sendAccessEmail: z.boolean().default(false) }).strict();

/** Restablecer la demo: el id que ve la pantalla y las credenciales de la cuenta demo. */
export const DemoResetSchema = z
  .object({
    accountId: z.number().int().positive(),
    email: z.string().trim().max(150),
    password: z.string().min(1).max(200),
  })
  .strict();

export const ListAccountsQuery = PaginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
});

export const PlanSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_-]+$/)
      .max(30),
    name: z.string().trim().min(1).max(80),
    userLimit: z.number().int().min(1).max(10_000),
    storageLimitMb: z.number().int().min(0).max(1_000_000),
    priceUsd: z.number().min(0).max(100_000),
    // Precio mensual en pesos del débito automático; sin precio, la iglesia no puede suscribirse.
    priceArs: z.number().min(0).max(100_000_000).nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

export const AuditQuery = PaginationQuery.extend({
  accountId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  action: z.string().trim().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const ImpersonateSchema = z
  .object({ userId: z.number().int().positive(), reason: z.string().trim().min(5).max(500) })
  .strict();
