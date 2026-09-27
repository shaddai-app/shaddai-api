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
