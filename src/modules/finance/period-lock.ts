import { tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';

/** "2026-09-14" → { year: 2026, month: 9 } */
export const monthOf = (iso: string) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) });

/**
 * Candado del cierre mensual: si alguna de las fechas cae en un mes cerrado, 409 PERIOD_CLOSED.
 * Se llama antes de todo lo que cambia saldos (altas, ediciones, anulaciones, confirmaciones y la
 * apertura de las cajas).
 */
export async function assertPeriodOpen(...dates: (string | null | undefined)[]) {
  const months = [
    ...new Map(
      dates.filter((d): d is string => Boolean(d)).map((d) => [d.slice(0, 7), monthOf(d)] as const),
    ).values(),
  ];
  if (months.length === 0) return;
  const closed = await tenantDb().financePeriod.findFirst({
    where: { status: 'closed', OR: months },
    select: { year: true, month: true },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });
  if (closed) throw AppError.conflict('PERIOD_CLOSED', closed);
}

/** Último día del último mes cerrado (null si no hay ninguno): antes de eso no se toca nada. */
export async function lastClosedDay() {
  const last = await tenantDb().financePeriod.findFirst({
    where: { status: 'closed' },
    select: { year: true, month: true },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
  });
  if (!last) return null;
  const end = new Date(Date.UTC(last.year, last.month, 0));
  return end.toISOString().slice(0, 10);
}
