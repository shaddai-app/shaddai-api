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

const EnvSchema = z.object({
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

  // console: loguea el mail (dev sin SMTP) · smtp: envío real · memory: tests
  MAIL_TRANSPORT: z.enum(['console', 'smtp', 'memory']).default('console'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('Shaddai <no-reply@shaddai.local>'),
});

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
