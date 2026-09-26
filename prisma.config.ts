import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/** Escapa un valor para la connection string JDBC-like de SQL Server. */
function escapeValue(value: string): string {
  return /[;={}\s]/.test(value) ? `{${value.replaceAll('}', '}}')}}` : value;
}

function buildDatabaseUrl(): string {
  const env = process.env;
  const parts = [
    `sqlserver://${env.DB_HOST ?? 'localhost'}:${env.DB_PORT ?? '1433'}`,
    `database=${escapeValue(env.DB_NAME ?? 'Shaddai')}`,
    `user=${escapeValue(env.DB_USER ?? '')}`,
    `password=${escapeValue(env.DB_PASSWORD ?? '')}`,
    `encrypt=${env.DB_ENCRYPT ?? 'true'}`,
    `trustServerCertificate=${env.DB_TRUST_SERVER_CERTIFICATE ?? 'true'}`,
  ];
  return parts.join(';');
}

export default defineConfig({
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed/index.ts',
  },
  datasource: {
    url: buildDatabaseUrl(),
  },
});
