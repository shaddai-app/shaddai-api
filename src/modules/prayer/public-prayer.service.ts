import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { encryptSecret } from '../../core/auth/totp.js';
import { generateOpaqueToken, hashToken } from '../../core/auth/tokens.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { CONSENT_VERSION } from '../people/people.schemas.js';
import { normalizePhone } from '../people/people.service.js';
import { notify } from '../notifications/notifications.service.js';
import type { ReplySchema } from './prayer.service.js';
import { mailRequester, notifyTeamOfReply, pastors, presentReply, repliesOf } from './prayer.service.js';

// Pedidos de oración sin usuario: el formulario público (QR) y el enlace privado de quien pidió. Corre
// con la cuenta de la iglesia en el contexto (runInContext desde public.routes), sin sesión. Quien
// tiene el enlace ve su petición y las respuestas, contesta, la marca respondida o la retira; nunca
// cambia la visibilidad ni ve datos de otros.

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const PublicPrayerSchema = z
  .object({
    body: z.string().trim().min(1).max(1000),
    name: optional(150),
    phone: optional(30),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .transform((v) => (v === '' ? null : v))
      .pipe(z.email().max(150).nullable())
      .nullable()
      .optional(),
    wantsContact: z.boolean().default(false),
    /** Lo que permite para el muro: no compartirla, compartirla anónima o con su nombre. */
    wallShare: z.enum(['no', 'anonymous', 'named']).default('no'),
    consent: z.literal(true),
    locale: z.enum(['es', 'en', 'pt']).optional(),
    turnstileToken: z.string().max(2048).optional(),
    /** Trampa para bots: campo oculto que una persona nunca completa. */
    website: z.string().max(200).optional(),
  })
  .strict()
  .refine((d) => !d.wantsContact || Boolean(d.phone || d.email), {
    message: 'CONTACT_REQUIRED',
    path: ['phone'],
  });

export const PublicPrayerUpdateSchema = z
  .object({
    status: z.enum(['open', 'answered']),
    testimony: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

/** Token del enlace: 32 bytes en base64url (generateOpaqueToken). */
export const TokenParam = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Crea la petición y devuelve el token del enlace privado (solo esta vez: se guarda el hash). */
export async function submit(input: Omit<z.infer<typeof PublicPrayerSchema>, 'turnstileToken' | 'website'>) {
  const token = generateOpaqueToken();
  const name = input.name ?? null;
  const wallShare =
    input.wallShare === 'no' ? null : input.wallShare === 'named' && !name ? 'anonymous' : input.wallShare;
  const created = await tenantDb().prayerRequest.create({
    data: {
      accountId: currentAccountId(),
      body: input.body,
      visibility: 'pastors',
      source: 'form',
      requesterName: name,
      requesterPhone: normalizePhone(input.phone),
      requesterEmail: input.email ?? null,
      requesterLocale: input.locale ?? null,
      wantsContact: input.wantsContact,
      wallShare,
      consentVersion: CONSENT_VERSION,
      accessTokenHash: hashToken(token),
      accessTokenEnc: encryptSecret(token),
    },
    select: { id: true, requesterEmail: true, requesterName: true, requesterLocale: true },
  });
  await audit({
    action: 'prayer.public_submit',
    entity: 'PrayerRequest',
    entityId: created.id,
    userId: null,
  });
  await notify({
    userIds: await pastors(),
    type: 'prayer.public',
    params: { name, wantsContact: input.wantsContact ? 1 : 0 },
    link: `/oracion/${created.id}`,
    dedupeKey: `prayer:${created.id}`,
  });
  await mailRequester(created, 'link');
  return { token };
}

const linkSelect = {
  id: true,
  body: true,
  visibility: true,
  status: true,
  answeredAt: true,
  testimony: true,
  createdAt: true,
  requesterName: true,
  wantsContact: true,
  contactedAt: true,
  _count: { select: { prayers: true } },
} as const;

async function findByToken(token: string) {
  const row = await tenantDb().prayerRequest.findFirst({
    where: { accessTokenHash: hashToken(token), source: 'form', deletedAt: null },
    select: linkSelect,
  });
  if (!row) throw AppError.notFound('PRAYER_LINK_NOT_FOUND');
  return row;
}

/** Lo que ve quien pidió: su petición, cuántos oran y la conversación con la iglesia. */
export async function view(token: string) {
  const row = await findByToken(token);
  const request = { createdById: null, requesterName: row.requesterName };
  return {
    body: row.body,
    status: row.status,
    answeredAt: row.answeredAt,
    testimony: row.testimony,
    createdAt: row.createdAt,
    name: row.requesterName,
    wantsContact: row.wantsContact,
    contacted: Boolean(row.contactedAt),
    onWall: row.visibility === 'public',
    prayerCount: row._count.prayers,
    replies: (await repliesOf(row.id)).map((r) => presentReply(r, request, null)),
  };
}

export async function reply(token: string, input: z.infer<typeof ReplySchema>) {
  const row = await findByToken(token);
  const created = await tenantDb().prayerReply.create({
    data: { accountId: currentAccountId(), requestId: row.id, body: input.body, authorId: null },
    select: { id: true },
  });
  await audit({
    action: 'prayer.reply',
    entity: 'PrayerReply',
    entityId: created.id,
    after: { requestId: row.id },
    userId: null,
  });
  await notifyTeamOfReply(
    { id: row.id, visibility: row.visibility, createdById: null },
    row.requesterName,
    created.id,
  );
  return view(token);
}

/** Marcarla respondida (con testimonio) o reabrirla. */
export async function update(token: string, input: z.infer<typeof PublicPrayerUpdateSchema>) {
  const row = await findByToken(token);
  const answered = input.status === 'answered';
  await tenantDb().prayerRequest.update({
    where: { id: row.id },
    data: {
      status: input.status,
      answeredAt: answered ? (row.answeredAt ?? new Date()) : null,
      testimony: answered ? (input.testimony === undefined ? row.testimony : input.testimony || null) : null,
    },
  });
  await audit({ action: 'prayer.public_update', entity: 'PrayerRequest', entityId: row.id, userId: null });
  return view(token);
}

/** Retirarla: deja de verse en la app y el enlace deja de funcionar. */
export async function withdraw(token: string) {
  const row = await findByToken(token);
  await tenantDb().prayerRequest.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
  await audit({ action: 'prayer.public_withdraw', entity: 'PrayerRequest', entityId: row.id, userId: null });
}
