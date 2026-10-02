import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { runInContext } from '../../core/context.js';
import { tenantDb } from '../../core/db/tenant.js';
import { resolvePermissions } from '../../core/rbac/resolve.js';
import type { PermissionKey } from '../../core/rbac/catalog.js';
import {
  addDays,
  daysBetween,
  meetingDateInWeek,
  todayIn,
  toDate,
  weekStart,
} from '../../core/time/local-date.js';
import { REPORT_GRACE_DAYS } from '../cells/reports.service.js';
import { isoDate } from '../people/people.service.js';
import { notify } from './notifications.service.js';

// Aviso diario de vencidos de una iglesia: préstamos sin devolver, pasos de consolidación vencidos y
// células sin reporte. Cada hecho se avisa una sola vez (dedupeKey); si cambia (ej. se extiende el
// vencimiento y se vuelve a vencer) es otro hecho y se avisa de nuevo.

export const DAILY_NOTICES_JOB = 'daily-notices';

/** Usuarios activos de la cuenta con el permiso (cualquier alcance). */
async function usersWith(key: PermissionKey, cache: Map<string, number[]>) {
  const hit = cache.get(key);
  if (hit) return hit;
  const users = await tenantDb().user.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true },
  });
  const ids: number[] = [];
  for (const u of users) if ((await resolvePermissions(u.id))[key]) ids.push(u.id);
  cache.set(key, ids);
  return ids;
}

async function overdueLoans(today: string, cache: Map<string, number[]>) {
  const loans = await tenantDb().inventoryLoan.findMany({
    where: { returnedAt: null, dueAt: { lt: toDate(today) }, item: { deletedAt: null } },
    select: {
      id: true,
      dueAt: true,
      item: { select: { name: true, code: true } },
      borrower: { select: { firstName: true, lastName: true } },
    },
  });
  if (!loans.length) return 0;
  const lenders = await usersWith('inventario.prestamos', cache);
  let sent = 0;
  for (const loan of loans) {
    const dueAt = isoDate(loan.dueAt)!;
    sent += await notify({
      userIds: lenders,
      type: 'loan.overdue',
      params: {
        item: loan.item.name,
        code: loan.item.code,
        person: `${loan.borrower.firstName} ${loan.borrower.lastName}`,
        dueAt,
      },
      link: '/inventario/prestamos',
      dedupeKey: `loan.overdue:${loan.id}:${dueAt}`,
    });
  }
  return sent;
}

async function overdueConsolidation(today: string, cache: Map<string, number[]>) {
  const cases = await tenantDb().consolidationCase.findMany({
    where: {
      status: 'open',
      person: { deletedAt: null },
      steps: { some: { completedAt: null, dueAt: { lt: toDate(today) } } },
    },
    select: {
      id: true,
      currentStepId: true,
      consolidatorUserId: true,
      person: { select: { firstName: true, lastName: true } },
      steps: { select: { stepId: true, dueAt: true, completedAt: true } },
    },
  });
  let sent = 0;
  for (const c of cases) {
    // Solo cuenta el paso actual (como en el tablero): uno anterior sin completar no frena.
    const current = c.steps.find((s) => s.stepId === c.currentStepId);
    if (!current || current.completedAt) continue;
    const dueAt = isoDate(current.dueAt)!;
    if (dueAt >= today) continue;
    const unassigned = c.consolidatorUserId === null;
    const userIds = unassigned ? await usersWith('consolidacion.asignar', cache) : [c.consolidatorUserId!];
    sent += await notify({
      userIds,
      type: 'consolidation.overdue',
      params: {
        person: `${c.person.firstName} ${c.person.lastName}`,
        dueAt,
        unassigned: unassigned ? 1 : null,
      },
      link: `/consolidacion/${c.id}`,
      dedupeKey: `consolidation.overdue:${c.id}:${c.currentStepId}:${dueAt}`,
    });
  }
  return sent;
}

/** Reuniones de esta semana y la anterior que ya pasaron el margen y no tienen reporte. */
async function missingCellReports(today: string, weekStartsOn: number) {
  const db = tenantDb();
  const thisWeek = weekStart(today, weekStartsOn);
  const weeks = [addDays(thisWeek, -7), thisWeek];
  const cells = await db.cell.findMany({
    where: { status: 'active' },
    select: { id: true, name: true, meetingDay: true, startedAt: true, leaderPersonId: true },
  });
  if (!cells.length) return 0;
  const reports = await db.cellReport.findMany({
    where: { cellId: { in: cells.map((c) => c.id) }, meetingDate: { gte: toDate(weeks[0]!) } },
    select: { cellId: true, meetingDate: true },
  });
  const leaders = await db.user.findMany({
    where: { personId: { in: cells.map((c) => c.leaderPersonId) }, isActive: true, deletedAt: null },
    select: { id: true, personId: true },
  });
  const userOf = new Map(leaders.map((u) => [u.personId, u.id]));
  let sent = 0;
  for (const cell of cells) {
    const userId = userOf.get(cell.leaderPersonId);
    if (!userId) continue;
    for (const start of weeks) {
      const expected = meetingDateInWeek(start, weekStartsOn, cell.meetingDay);
      if (daysBetween(expected, today) <= REPORT_GRACE_DAYS) continue; // todavía está a tiempo
      if (cell.startedAt && expected < isoDate(cell.startedAt)!) continue;
      const end = addDays(start, 6);
      const reported = reports.some((r) => {
        const d = isoDate(r.meetingDate)!;
        return r.cellId === cell.id && d >= start && d <= end;
      });
      if (reported) continue;
      sent += await notify({
        userIds: [userId],
        type: 'cell.report_missing',
        params: { cell: cell.name, date: expected },
        link: '/mi-celula',
        dedupeKey: `cell.report_missing:${cell.id}:${expected}`,
      });
    }
  }
  return sent;
}

/**
 * Corre el aviso diario de una cuenta. Sin `force`, una sola vez por día local (traba en
 * DailyJobRun): devuelve null si ya corrió. Con `force` (script manual) corre igual; los avisos
 * no se repiten por la dedupeKey.
 */
export function runDailyNotices(accountId: number, opts: { force?: boolean; now?: Date } = {}) {
  return runInContext({ requestId: `job-${randomUUID()}`, accountId }, async () => {
    const db = tenantDb();
    const account = await db.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { timezone: true, weekStartsOn: true },
    });
    const today = todayIn(account.timezone, opts.now);
    let runId: number | null = null;
    if (!opts.force) {
      try {
        const run = await db.dailyJobRun.create({
          data: { accountId, job: DAILY_NOTICES_JOB, runDate: toDate(today) },
          select: { id: true },
        });
        runId = run.id;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
        throw err;
      }
    }
    const cache = new Map<string, number[]>();
    try {
      const notices =
        (await overdueLoans(today, cache)) +
        (await overdueConsolidation(today, cache)) +
        (await missingCellReports(today, account.weekStartsOn));
      if (runId) {
        await db.dailyJobRun.update({ where: { id: runId }, data: { finishedAt: new Date(), notices } });
      }
      return { today, notices };
    } catch (err) {
      if (runId) {
        await db.dailyJobRun.update({
          where: { id: runId },
          data: { finishedAt: new Date(), error: String(err).slice(0, 1000) },
        });
      }
      throw err;
    }
  });
}
