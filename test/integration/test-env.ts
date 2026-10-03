import 'dotenv/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_DEMO_PASSWORD = 'demo-de-prueba-solo-tests';

/** Nunca se corre contra la base de desarrollo: siempre una base *_test separada. */
export function applyTestEnv(): void {
  const base = process.env.DB_NAME ?? 'Shaddai';
  process.env.DB_NAME = process.env.DB_NAME_TEST ?? (base.endsWith('_test') ? base : `${base}_test`);
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_ENABLED = 'false';
  process.env.MAIL_TRANSPORT = 'memory';
  process.env.STORAGE_LOCAL_PATH = join(tmpdir(), 'shaddai-test-storage');
  // Contraseña propia de los tests: la del .env de desarrollo no se usa.
  process.env.SEED_DEMO_PASSWORD = TEST_DEMO_PASSWORD;
}
