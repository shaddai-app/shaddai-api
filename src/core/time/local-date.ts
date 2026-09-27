/**
 * Fechas "puras" (YYYY-MM-DD) en la zona horaria de la cuenta. Los reportes y el semáforo trabajan
 * con días del calendario local de la iglesia, no con instantes UTC.
 */

/** Hoy en la zona horaria dada, como "YYYY-MM-DD". */
export function todayIn(timeZone: string, now = new Date()): string {
  // en-CA formatea como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
export const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/** 0 = domingo … 6 = sábado. */
export const dayOfWeek = (iso: string) => toDate(iso).getUTCDay();

/** Primer día de la semana que contiene `iso` (weekStartsOn: 0 domingo, 1 lunes). */
export function weekStart(iso: string, weekStartsOn: number): string {
  return addDays(iso, -((dayOfWeek(iso) - weekStartsOn + 7) % 7));
}

/** Fecha de la reunión de esa semana para una célula que se reúne el día `meetingDay`. */
export function meetingDateInWeek(weekStartIso: string, weekStartsOn: number, meetingDay: number): string {
  return addDays(weekStartIso, (meetingDay - weekStartsOn + 7) % 7);
}

/** Diferencia en días (b − a). */
export const daysBetween = (a: string, b: string) =>
  Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
