import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { audit } from '../../core/audit/audit.js';
import { verifyPassword } from '../../core/auth/password.js';
import { ACCOUNT_DATA, exportAccountRecord, exportFileName, exportRows } from '../../core/db/account-data.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { forbidInDemo } from '../../core/demo.js';
import { AppError } from '../../core/http/errors.js';
import { routeRegistry, tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { logger } from '../../core/logger.js';
import { sendMail } from '../../core/mail/mailer.js';
import { accountClosureMail, resolveMailLocale } from '../../core/mail/templates.js';
import { authenticate, authOf, forbidImpersonation } from '../../core/middleware/authenticate.js';
import { requireAccountUser } from '../../core/middleware/authorize.js';
import { exportLimiter } from '../../core/middleware/rate-limit.js';
import { storage } from '../../core/storage/storage.js';
import { changeAccountStatus } from '../platform/platform.service.js';

// Datos de la iglesia: exportación completa y baja de la cuenta (borrado definitivo a los 90 días).

const t = tenantRouter();
export const accountDataRouter = t.router;

const json = (value: unknown) =>
  new TextEncoder().encode(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );

/** Nombre de archivo seguro dentro del ZIP. */
const safeName = (name: string) => name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120);

const readme = {
  es: 'Exportación completa de {church} en Shaddai ({date}).\n\n- datos/: un JSON por tabla (los ids relacionan las tablas entre sí).\n- archivos/: logo, fotos y comprobantes, con el id del registro de datos/file-object.json.\n\nNo incluye contraseñas, sesiones ni claves de verificación en dos pasos.\n',
  en: 'Full export of {church} from Shaddai ({date}).\n\n- datos/: one JSON per table (ids link the tables).\n- archivos/: logo, photos and receipts, named with the id from datos/file-object.json.\n\nPasswords, sessions and two-step verification keys are not included.\n',
  pt: 'Exportação completa de {church} no Shaddai ({date}).\n\n- datos/: um JSON por tabela (os ids relacionam as tabelas).\n- archivos/: logo, fotos e comprovantes, com o id de datos/file-object.json.\n\nNão inclui senhas, sessões nem chaves de verificação em duas etapas.\n',
} as const;

// Todo lo de la iglesia en un ZIP: datos en JSON y archivos. Datos sensibles (diezmos, notas pastorales):
// solo quien configura la cuenta, nunca en una sesión de soporte, y queda auditado.
t.get(
  '/account/export',
  'cuenta.configurar',
  forbidImpersonation,
  forbidInDemo,
  exportLimiter,
  async (req, res) => {
    const accountId = currentAccountId();
    const { account, audit: auditRows } = await exportAccountRecord(accountId);
    const today = new Date().toISOString().slice(0, 10);
    await audit({ action: 'account.export', entity: 'Account', entityId: accountId });

    res.attachment(`shaddai-${account.slug}-${today}.zip`).type('application/zip');
    res.setHeader('Cache-Control', 'no-store');
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        logger.error({ err, accountId }, 'account export failed');
        res.destroy(err);
        return;
      }
      res.write(chunk);
      if (final) res.end();
    });
    const add = (name: string, data: Uint8Array, compress = true) => {
      const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
      zip.add(entry);
      entry.push(data, true);
    };

    try {
      const locale = resolveMailLocale(account.defaultLocale);
      add(
        'LEEME.txt',
        new TextEncoder().encode(readme[locale].replace('{church}', account.name).replace('{date}', today)),
      );
      add('datos/account.json', json(account));
      add('datos/audit-log.json', json(auditRows));
      for (const { model } of ACCOUNT_DATA.filter((d) => d.export)) {
        add(`datos/${exportFileName(model)}`, json(await exportRows(accountId, model)));
      }
      const files = await tenantDb().fileObject.findMany({
        where: { deletedAt: null },
        orderBy: { id: 'asc' },
      });
      for (const file of files) {
        try {
          // Imágenes y PDF ya vienen comprimidos: se guardan tal cual.
          add(
            `archivos/${file.id}-${safeName(file.originalName)}`,
            await storage.get(file.storageKey),
            false,
          );
        } catch (err) {
          logger.warn({ err, fileId: file.id }, 'export: file missing in storage');
        }
      }
      zip.end();
    } catch (err) {
      zip.terminate();
      if (!res.headersSent) throw err;
      // Ya salió parte del ZIP: se corta la descarga para que no quede un archivo incompleto que parezca bueno.
      logger.error({ err, accountId }, 'account export failed');
      res.destroy(err as Error);
    }
  },
);

const ClosureSchema = z
  .object({ password: z.string().min(1).max(200), confirm: z.string().trim().min(1) })
  .strict();

// Baja pedida por la propia iglesia. Solo el dueño de la cuenta, con su contraseña y escribiendo el
// nombre de la iglesia. Se permite aunque la cuenta esté en solo lectura (morosa): irse siempre se puede.
routeRegistry.push({ scope: 'tenant', method: 'post', path: '/account/closure', access: 'account-user' });
accountDataRouter.post(
  '/account/closure',
  authenticate(),
  requireAccountUser,
  forbidImpersonation,
  forbidInDemo,
  async (req, res) => {
    const input = parse(ClosureSchema, req.body);
    const db = tenantDb();
    const user = await db.user.findUniqueOrThrow({
      where: { id: authOf(req).userId },
      select: { firstName: true, email: true, locale: true, passwordHash: true, isAccountOwner: true },
    });
    if (!user.isAccountOwner) throw AppError.forbidden('ACCOUNT_OWNER_REQUIRED');
    const account = await db.account.findUniqueOrThrow({
      where: { id: currentAccountId() },
      select: { id: true, name: true, email: true, timezone: true, defaultLocale: true },
    });
    if (input.confirm.toLocaleLowerCase() !== account.name.trim().toLocaleLowerCase()) {
      throw AppError.badRequest('CLOSURE_CONFIRM_MISMATCH');
    }
    if (!(await verifyPassword(user.passwordHash, input.password))) {
      throw AppError.badRequest('PASSWORD_CURRENT_INVALID');
    }

    const closed = await changeAccountStatus(account.id, {
      status: 'closed',
      reason: 'Baja pedida por la iglesia',
    });
    await audit({ action: 'account.closure', entity: 'Account', entityId: account.id });

    const purgeAfter = closed.purgeAfter!;
    const recipients = [...new Set([user.email, account.email].filter((e): e is string => Boolean(e)))];
    const locale = resolveMailLocale(user.locale, account.defaultLocale);
    const mail = accountClosureMail(locale, {
      name: user.firstName,
      church: account.name,
      purgeAfter,
      timezone: account.timezone,
      supportEmail: env.SUPPORT_EMAIL,
    });
    for (const to of recipients) {
      await sendMail({ to, ...mail }).catch((err: unknown) => logger.error({ err }, 'closure mail failed'));
    }
    res.json({ status: 'closed', purgeAfter });
  },
);
