import { createRequire } from 'node:module';
import type * as RRuleModule from 'rrule';
import { z } from 'zod';
import { dateToLocal, localToDate } from '../../core/time/local-date.js';

// Recurrencias: la UI manda una forma simple (cada N días/semanas/meses, días de la semana, hasta
// cuándo) y acá se traduce a una RRULE (RFC 5545). Todo en hora local "flotante": las fechas son
// Date "UTC" que en realidad representan la hora de reloj de la iglesia.

// rrule 2.8.1 no expone bien sus exports para ESM en Node: se carga con require (con sus tipos).
const { RRule, Weekday } = createRequire(import.meta.url)('rrule') as typeof RRuleModule;
type RRuleT = InstanceType<typeof RRule>;

/** 0 = domingo … 6 = sábado (como Cell.meetingDay y Date.getUTCDay). */
const WEEKDAYS = [RRule.SU, RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA];
const toSundayFirst = (rruleDay: number) => (rruleDay + 1) % 7; // rrule: 0 = lunes

export const Recurrence = z
  .object({
    freq: z.enum(['daily', 'weekly', 'monthly']),
    interval: z.number().int().min(1).max(12).default(1),
    /** Semanal: días de la semana (por defecto, el del inicio). */
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    /** Mensual: el mismo número de día (12) o el mismo día de la semana (el primer domingo). */
    monthlyBy: z.enum(['day', 'weekday']).optional(),
    /** Última fecha (incluida); sin fecha = sin fin. */
    until: z.iso.date().nullable().optional(),
  })
  .strict();
export type Recurrence = z.infer<typeof Recurrence>;

const FREQ = { daily: RRule.DAILY, weekly: RRule.WEEKLY, monthly: RRule.MONTHLY } as const;

/** Número de semana del día en el mes (1…4) o -1 si es la última (el 5.º domingo = "último"). */
const nthOfMonth = (day: number) => {
  const n = Math.ceil(day / 7);
  return n >= 5 ? -1 : n;
};

/** Recurrencia simple → texto RRULE (sin DTSTART). */
export function toRule(rec: Recurrence, start: string): string {
  const startDate = localToDate(start);
  const weekday = startDate.getUTCDay();
  const options: ConstructorParameters<typeof RRule>[0] = {
    freq: FREQ[rec.freq],
    ...(rec.interval > 1 ? { interval: rec.interval } : {}),
  };
  if (rec.freq === 'weekly') {
    const days = rec.weekdays?.length ? [...new Set(rec.weekdays)].sort() : [weekday];
    options.byweekday = days.map((d) => WEEKDAYS[d]!);
  }
  if (rec.freq === 'monthly') {
    if (rec.monthlyBy === 'weekday') {
      options.byweekday = [WEEKDAYS[weekday]!.nth(nthOfMonth(startDate.getUTCDate()))];
    } else {
      options.bymonthday = [startDate.getUTCDate()];
    }
  }
  if (rec.until) options.until = localToDate(`${rec.until}T23:59`);
  const line = new RRule(options)
    .toString()
    .split('\n')
    .find((l) => l.startsWith('RRULE:'))!;
  return line.slice('RRULE:'.length);
}

/** Texto RRULE guardado → recurrencia simple (para editarla en la UI). */
export function fromRule(rule: string): Recurrence {
  const o = RRule.parseString(rule);
  const freq = o.freq === RRule.DAILY ? 'daily' : o.freq === RRule.MONTHLY ? 'monthly' : 'weekly';
  const days = (Array.isArray(o.byweekday) ? o.byweekday : o.byweekday != null ? [o.byweekday] : []).map(
    (d) => (d instanceof Weekday ? d : new Weekday(Number(d))),
  );
  return {
    freq,
    interval: o.interval ?? 1,
    ...(freq === 'weekly' ? { weekdays: days.map((d) => toSundayFirst(d.weekday)) } : {}),
    ...(freq === 'monthly' ? { monthlyBy: days.length ? ('weekday' as const) : ('day' as const) } : {}),
    until: o.until ? dateToLocal(o.until).slice(0, 10) : null,
  };
}

function ruleFor(rule: string, start: Date): RRuleT {
  return new RRule({ ...RRule.parseString(rule), dtstart: start });
}

/** Inicios (hora local) de la serie entre from y to, incluidos. */
export function occurrences(rule: string, start: Date, from: Date, to: Date): Date[] {
  return ruleFor(rule, start).between(from, to, true);
}

/** ¿Esa hora local es una fecha de la serie? */
export function isOccurrence(rule: string, start: Date, at: Date): boolean {
  return occurrences(rule, start, at, at).length > 0;
}

/** Misma regla pero terminando justo antes de `before` (para partir una serie en dos). */
export function endBefore(rule: string, before: Date): string {
  const o = RRule.parseString(rule);
  delete o.count;
  o.until = new Date(before.getTime() - 60_000);
  const line = new RRule(o)
    .toString()
    .split('\n')
    .find((l) => l.startsWith('RRULE:'))!;
  return line.slice('RRULE:'.length);
}

/**
 * Fecha de la serie a la que corresponde `at` después de un cambio de horario: la misma si sigue
 * siendo una fecha de la serie, la del mismo día si cambió la hora, o null si ese día ya no hay.
 * Sin regla, el evento es de una sola fecha (`start`).
 */
export function alignOccurrence(rule: string | null, start: Date, at: Date): Date | null {
  const valid = rule ? isOccurrence(rule, start, at) : at.getTime() === start.getTime();
  if (valid) return at;
  const day = dateToLocal(at).slice(0, 10);
  if (!rule) return dateToLocal(start).slice(0, 10) === day ? start : null;
  return occurrences(rule, start, localToDate(`${day}T00:00`), localToDate(`${day}T23:59`))[0] ?? null;
}
