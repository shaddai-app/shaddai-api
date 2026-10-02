import { env } from '../config/env.js';
import { prisma } from '../core/db/prisma.js';
import { purgeExpiredRateLimits } from '../core/db/rate-limit-store.js';
import { logger } from '../core/logger.js';
import { reportError } from '../core/observability/sentry.js';
import { runDailyNotices } from '../modules/notifications/daily.js';

// Procesos programados dentro de la API (sin cron externo). Cada 10 minutos revisa qué iglesias ya
// pasaron la hora del aviso diario en su zona horaria; la traba en la base evita correrlo dos veces
// el mismo día, aunque haya varias instancias. También limpia los contadores vencidos del rate limit.

const EVERY_MS = 10 * 60_000;
/** Cuentas que usan el sistema (no las suspendidas ni cerradas). */
const LIVE_STATUSES = ['trial', 'active', 'past_due'];

export function localHour(timeZone: string, now = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now);
  return Number(hour);
}

export async function tickDailyNotices(now = new Date()) {
  const accounts = await prisma.account.findMany({
    where: { status: { in: LIVE_STATUSES } },
    select: { id: true, timezone: true },
  });
  for (const account of accounts) {
    if (localHour(account.timezone, now) < env.DAILY_NOTICES_HOUR) continue;
    try {
      const result = await runDailyNotices(account.id, { now });
      if (result) logger.info({ accountId: account.id, ...result }, 'daily notices');
    } catch (err) {
      logger.error({ err, accountId: account.id }, 'daily notices failed');
      reportError(err, { job: 'daily-notices', accountId: account.id });
    }
  }
}

/** Arranca los procesos programados; devuelve una función para detenerlos. */
export function startJobs(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // una vuelta lenta no se superpone con la siguiente
    running = true;
    try {
      await tickDailyNotices();
      await purgeExpiredRateLimits();
    } catch (err) {
      logger.error({ err }, 'jobs tick failed');
      reportError(err, { job: 'tick' });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), EVERY_MS);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
