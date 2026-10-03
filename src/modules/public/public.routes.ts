import { Router, type Request } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { audit } from '../../core/audit/audit.js';
import { prisma } from '../../core/db/prisma.js';
import { tenantClientFor } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { parse } from '../../core/http/validate.js';
import { publicFormLimiter, publicReadLimiter } from '../../core/middleware/rate-limit.js';
import { verifyTurnstile } from '../../core/security/turnstile.js';
import { storage } from '../../core/storage/storage.js';
import { CONSENT_VERSION, dateOnly } from '../people/people.schemas.js';
import { normalizePhone } from '../people/people.service.js';
import { createRegistration, publicEvent } from '../calendar/registrations.service.js';
import { runInContext } from '../../core/context.js';
import { DEFAULT_TRIAL_DAYS } from '../platform/platform.schemas.js';

/** Endpoints sin sesión. Nunca revelan si una iglesia existe pero está suspendida. */
export const publicRouter = Router();

const SlugParam = z.object({ slug: z.string().regex(/^[a-z0-9-]{3,60}$/) });

/** Iglesias que reciben formularios: activas, en prueba o morosas (no suspendidas ni cerradas). */
async function publicAccount(req: Request) {
  const { slug } = parse(SlugParam, req.params);
  const account = await prisma.account.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      logoFileId: true,
      defaultLocale: true,
      primaryColor: true,
    },
  });
  if (!account || !['active', 'trial', 'past_due'].includes(account.status)) {
    throw AppError.notFound('PUBLIC_FORM_NOT_FOUND');
  }
  return account;
}

/** Planes para la landing: solo lo que se muestra al público (nada de ids ni precio en dólares). */
publicRouter.get('/public/plans', publicReadLimiter, async (_req, res) => {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: [{ userLimit: 'asc' }, { id: 'asc' }],
    select: { code: true, name: true, userLimit: true, storageLimitMb: true, priceArs: true },
  });
  res.json({
    items: plans.map((p) => ({ ...p, priceArs: p.priceArs === null ? null : Number(p.priceArs) })),
    trialDays: DEFAULT_TRIAL_DAYS,
  });
});

publicRouter.get('/public/:slug/newcomer-form', publicReadLimiter, async (req, res) => {
  const account = await publicAccount(req);
  res.json({
    church: {
      name: account.name,
      slug: account.slug,
      logoUrl: account.logoFileId ? `/api/v1/public/${account.slug}/logo` : null,
      defaultLocale: account.defaultLocale,
      primaryColor: account.primaryColor,
    },
    consentVersion: CONSENT_VERSION,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
  });
});

publicRouter.get('/public/:slug/logo', publicReadLimiter, async (req, res) => {
  const account = await publicAccount(req);
  const file = account.logoFileId
    ? await prisma.fileObject.findFirst({
        where: { id: account.logoFileId, accountId: account.id, purpose: 'logo', deletedAt: null },
      })
    : null;
  if (!file) throw AppError.notFound('FILE_NOT_FOUND');
  const data = await storage.get(file.storageKey);
  res.set({
    'Content-Type': file.mimeType,
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.end(data);
});

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const NewcomerSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    phone: optional(30),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .transform((v) => (v === '' ? null : v))
      .pipe(z.email().max(150).nullable())
      .nullable()
      .optional(),
    address: optional(250),
    city: optional(100),
    birthDate: dateOnly
      .refine((d) => d.getTime() <= Date.now() && d.getUTCFullYear() >= 1900, { message: 'DATE_INVALID' })
      .nullable()
      .optional(),
    howHeard: optional(200),
    prayer: optional(1000),
    wantsVisit: z.boolean().default(false),
    consent: z.literal(true),
    locale: z.enum(['es', 'en', 'pt']).optional(),
    turnstileToken: z.string().max(2048).optional(),
    /** Trampa para bots: campo oculto que una persona nunca completa. */
    website: z.string().max(200).optional(),
  })
  .strict()
  .refine((d) => Boolean(d.phone || d.email), { message: 'CONTACT_REQUIRED', path: ['phone'] });

publicRouter.post('/public/:slug/newcomer', publicFormLimiter, async (req, res) => {
  const account = await publicAccount(req);
  const input = parse(NewcomerSchema, req.body);

  // Bot: se responde como si hubiera salido bien para no darle pistas.
  if (input.website) {
    res.status(201).json({ ok: true });
    return;
  }
  if (!(await verifyTurnstile(input.turnstileToken, req.ip))) throw AppError.badRequest('CAPTCHA_FAILED');

  const { turnstileToken: _t, website: _w, consent, ...data } = input;
  const submission = await tenantClientFor(account.id).newcomerSubmission.create({
    data: {
      ...data,
      accountId: account.id,
      phone: normalizePhone(data.phone),
      consent,
      consentVersion: CONSENT_VERSION,
      ip: req.ip ?? null,
    },
    select: { id: true },
  });
  await audit({
    action: 'newcomers.submit',
    entity: 'NewcomerSubmission',
    entityId: submission.id,
    accountId: account.id,
    userId: null,
  });
  res.status(201).json({ ok: true });
});

// ───────────── Inscripción pública a eventos ─────────────

const EventParams = SlugParam.extend({ id: z.coerce.number().int().positive() });

const PublicRegistrationSchema = z
  .object({
    occurrence: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    name: z.string().trim().min(2).max(150),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .transform((v) => (v === '' ? null : v))
      .pipe(z.email().max(150).nullable())
      .nullable()
      .optional(),
    phone: optional(30),
    notes: optional(500),
    turnstileToken: z.string().max(2048).optional(),
    /** Trampa para bots. */
    website: z.string().max(200).optional(),
  })
  .strict()
  .refine((d) => Boolean(d.phone || d.email), { message: 'CONTACT_REQUIRED', path: ['phone'] });

/** Corre el servicio del calendario con la cuenta de la iglesia (no hay sesión). */
const asChurch = <T>(req: Request, accountId: number, fn: () => Promise<T>) =>
  runInContext({ requestId: String(req.id), ip: req.ip, accountId }, fn);

publicRouter.get('/public/:slug/events/:id', publicReadLimiter, async (req, res) => {
  const account = await publicAccount(req);
  const { id } = parse(EventParams, req.params);
  const event = await asChurch(req, account.id, () => publicEvent(id));
  const { currency } = await prisma.account.findUniqueOrThrow({
    where: { id: account.id },
    select: { currency: true },
  });
  res.json({
    church: {
      name: account.name,
      slug: account.slug,
      logoUrl: account.logoFileId ? `/api/v1/public/${account.slug}/logo` : null,
      defaultLocale: account.defaultLocale,
      primaryColor: account.primaryColor,
      currency,
    },
    event,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
  });
});

publicRouter.post('/public/:slug/events/:id/register', publicFormLimiter, async (req, res) => {
  const account = await publicAccount(req);
  const { id } = parse(EventParams, req.params);
  const input = parse(PublicRegistrationSchema, req.body);
  // Bot: se responde como si hubiera salido bien.
  if (input.website) {
    res.status(201).json({ status: 'confirmed' });
    return;
  }
  if (!(await verifyTurnstile(input.turnstileToken, req.ip))) throw AppError.badRequest('CAPTCHA_FAILED');
  const { turnstileToken: _t, website: _w, ...data } = input;
  const registration = await asChurch(req, account.id, () =>
    createRegistration(null, id, { ...data, personId: null }, 'public'),
  );
  // Solo lo necesario: no se devuelven datos de otros inscriptos.
  res.status(201).json({ status: registration.status });
});
