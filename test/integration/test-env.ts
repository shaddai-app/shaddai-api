import 'dotenv/config';

/** Nunca se corre contra la base de desarrollo: siempre una base *_test separada. */
export function applyTestEnv(): void {
  const base = process.env.DB_NAME ?? 'Shaddai';
  process.env.DB_NAME = process.env.DB_NAME_TEST ?? (base.endsWith('_test') ? base : `${base}_test`);
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_ENABLED = 'false';
  process.env.MAIL_TRANSPORT = 'memory';
}
