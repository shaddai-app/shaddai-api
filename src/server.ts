import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './core/db/prisma.js';
import { logger } from './core/logger.js';
import { startJobs } from './jobs/scheduler.js';

const server = createApp().listen(env.PORT, () => {
  logger.info(`Shaddai API escuchando en http://localhost:${env.PORT}/api/v1`);
});
const stopJobs = env.JOBS_ENABLED ? startJobs() : () => undefined;

async function shutdown(signal: string) {
  logger.info({ signal }, 'Cerrando servidor');
  stopJobs();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
