import { PrismaMssql } from '@prisma/adapter-mssql';
import { PrismaClient } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';

const adapter = new PrismaMssql({
  server: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  options: {
    encrypt: env.DB_ENCRYPT,
    trustServerCertificate: env.DB_TRUST_SERVER_CERTIFICATE,
  },
});

/**
 * Cliente base SIN filtro de tenant. Uso restringido a core/, módulo platform y seed.
 * Los módulos de negocio usan el cliente tenant-scoped (Fase 1: tenant-extension.ts).
 */
export const prisma = new PrismaClient({ adapter });

export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
