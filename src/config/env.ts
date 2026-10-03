import 'dotenv/config';
import { z } from 'zod';

const bool = (fallback: 'true' | 'false' = 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Variable vacía (`X=`) o en blanco (Container Apps no admite secretos vacíos) = sin definir. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    APP_URL: z.url(),
    CORS_ORIGINS: csv,

    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().int().positive().default(1433),
    DB_NAME: z.string().min(1),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),
    DB_ENCRYPT: bool(),
    DB_TRUST_SERVER_CERTIFICATE: bool(),

    JWT_ACCESS_SECRET: z.string().min(64, 'JWT_ACCESS_SECRET debe tener al menos 64 caracteres'),
    JWT_ACCESS_TTL_MIN: z.coerce.number().int().positive().default(15),
    REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
    REFRESH_REMEMBER_TTL_DAYS: z.coerce.number().int().positive().default(30),
    TOTP_ENC_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'TOTP_ENC_KEY debe ser 32 bytes en base64'),
    RATE_LIMIT_ENABLED: bool('true'),
    // memory: una sola instancia · db: contadores compartidos en SQL Server (por defecto en producción)
    RATE_LIMIT_STORE: optional(z.enum(['memory', 'db'])),

    // local: carpeta del servidor · s3: bucket compatible con S3 (Cloudflare R2 en producción)
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./storage'),
    S3_ENDPOINT: optional(z.url()), // R2: https://<cuenta>.r2.cloudflarestorage.com
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    // console: loguea el mail (dev sin SMTP) · smtp: envío real · memory: tests
    MAIL_TRANSPORT: z.enum(['console', 'smtp', 'memory']).default('console'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().default('Shaddai <no-reply@shaddai.local>'),
    // Contacto que ven las iglesias (baja de cuenta, política de privacidad).
    SUPPORT_EMAIL: z.email().default('soporte@shaddai.local'),

    // Procesos programados (aviso diario de vencidos). En una instancia sola o en todas: se trancan
    // por cuenta y día en la base. Hora local de cada iglesia a partir de la cual corre.
    JOBS_ENABLED: bool('true'),
    DAILY_NOTICES_HOUR: z.coerce.number().int().min(0).max(23).default(8),

    // Sentry: errores no previstos (sin DSN no se envía nada). Release = commit desplegado.
    SENTRY_DSN: optional(z.url()),
    SENTRY_ENVIRONMENT: optional(z.string()),
    SENTRY_RELEASE: optional(z.string()),

    // Cloudflare Turnstile para formularios públicos. Sin secreto (solo fuera de producción) no se verifica.
    TURNSTILE_SECRET: z.string().optional(),
    TURNSTILE_SITE_KEY: z.string().optional(),

    // Geocodificación de direcciones (células, personas). none = solo carga manual del punto en el mapa.
    GEOCODING_PROVIDER: z.enum(['none', 'locationiq', 'geoapify']).default('none'),
    GEOCODING_API_KEY: optional(z.string()),
    GEOCODING_COUNTRY: z.string().length(2).default('ar'),

    // Cobro del servicio: fake (desarrollo y tests, sin dinero real) | mercadopago | none (sin cobro
    // automático: la plataforma registra los pagos a mano).
    // Sin valor: fake en desarrollo y tests, none en producción (ver billingProviderName).
    BILLING_PROVIDER: optional(z.enum(['none', 'fake', 'mercadopago'])),
    MP_ACCESS_TOKEN: optional(z.string()),
    MP_WEBHOOK_SECRET: optional(z.string()),
    /** Días después de vencido el pago antes de pasar la cuenta a "morosa" (solo lectura). */
    BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(5),

    // Contraseña de los usuarios de la iglesia demo (cuenta 1). La usan el seed y el restablecimiento
    // de la demo desde el panel de plataforma, que además la pide como credencial de confirmación.
    SEED_DEMO_PASSWORD: optional(z.string().min(12)),
  })
  .refine((e) => e.NODE_ENV !== 'production' || Boolean(e.TURNSTILE_SECRET), {
    message: 'TURNSTILE_SECRET es obligatorio en producción',
    path: ['TURNSTILE_SECRET'],
  })
  // En producción el mail sale por SMTP: "console" escribiría en el log los enlaces de recuperación.
  .refine((e) => e.NODE_ENV !== 'production' || e.MAIL_TRANSPORT === 'smtp', {
    message: 'MAIL_TRANSPORT debe ser smtp en producción',
    path: ['MAIL_TRANSPORT'],
  })
  .refine((e) => e.NODE_ENV !== 'production' || e.BILLING_PROVIDER !== 'fake', {
    message: 'BILLING_PROVIDER=fake no se usa en producción (mercadopago o none)',
    path: ['BILLING_PROVIDER'],
  })
  .refine((e) => e.BILLING_PROVIDER !== 'mercadopago' || Boolean(e.MP_ACCESS_TOKEN && e.MP_WEBHOOK_SECRET), {
    message: 'Con BILLING_PROVIDER=mercadopago hacen falta MP_ACCESS_TOKEN y MP_WEBHOOK_SECRET',
    path: ['MP_ACCESS_TOKEN'],
  })
  .refine(
    (e) => e.STORAGE_DRIVER !== 's3' || Boolean(e.S3_BUCKET && e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY),
    {
      message: 'Con STORAGE_DRIVER=s3 hacen falta S3_BUCKET, S3_ACCESS_KEY_ID y S3_SECRET_ACCESS_KEY',
      path: ['S3_BUCKET'],
    },
  );

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Configuración inválida en .env:\n' + z.prettifyError(parsed.error));
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === 'production';
export const rateLimitStore = env.RATE_LIMIT_STORE ?? (isProd ? 'db' : 'memory');
export const billingProviderName = env.BILLING_PROVIDER ?? (isProd ? 'none' : 'fake');
