import { describe, expect, it } from 'vitest';
import { localToDate, dateToLocal } from '../../src/core/time/local-date.js';
import {
  endBefore,
  fromRule,
  isOccurrence,
  occurrences,
  toRule,
} from '../../src/modules/calendar/recurrence.js';

const between = (rule: string, start: string, from: string, to: string) =>
  occurrences(rule, localToDate(start), localToDate(from), localToDate(to)).map(dateToLocal);

describe('recurrencias', () => {
  it('semanal: los domingos a las 10 (hora local, sin corrimientos)', () => {
    const rule = toRule({ freq: 'weekly', interval: 1 }, '2026-09-06T10:00');
    expect(rule).toBe('FREQ=WEEKLY;BYDAY=SU');
    expect(between(rule, '2026-09-06T10:00', '2026-10-01T00:00', '2026-10-31T23:59')).toEqual([
      '2026-10-04T10:00',
      '2026-10-11T10:00',
      '2026-10-18T10:00',
      '2026-10-25T10:00',
    ]);
  });

  it('varios días de la semana, cada dos semanas y con fecha de fin', () => {
    const rule = toRule(
      { freq: 'weekly', interval: 2, weekdays: [3, 1], until: '2026-10-07' },
      '2026-09-07T20:00',
    );
    expect(between(rule, '2026-09-07T20:00', '2026-09-01T00:00', '2026-12-31T00:00')).toEqual([
      '2026-09-07T20:00',
      '2026-09-09T20:00',
      '2026-09-21T20:00',
      '2026-09-23T20:00',
      '2026-10-05T20:00',
      '2026-10-07T20:00',
    ]);
    expect(fromRule(rule)).toEqual({ freq: 'weekly', interval: 2, weekdays: [1, 3], until: '2026-10-07' });
  });

  it('mensual: el mismo día o el mismo día de la semana (primer domingo, último viernes)', () => {
    const byDay = toRule({ freq: 'monthly', interval: 1 }, '2026-09-15T19:00');
    expect(between(byDay, '2026-09-15T19:00', '2026-10-01T00:00', '2026-11-30T00:00')).toEqual([
      '2026-10-15T19:00',
      '2026-11-15T19:00',
    ]);
    const firstSunday = toRule({ freq: 'monthly', interval: 1, monthlyBy: 'weekday' }, '2026-09-06T10:00');
    expect(between(firstSunday, '2026-09-06T10:00', '2026-10-01T00:00', '2026-12-31T00:00')).toEqual([
      '2026-10-04T10:00',
      '2026-11-01T10:00',
      '2026-12-06T10:00',
    ]);
    expect(fromRule(firstSunday)).toMatchObject({ freq: 'monthly', monthlyBy: 'weekday' });
    // El 25/09/2026 es el 4.º viernes: se repite el 4.º viernes de cada mes.
    const fourth = toRule({ freq: 'monthly', interval: 1, monthlyBy: 'weekday' }, '2026-09-25T20:00');
    expect(between(fourth, '2026-09-25T20:00', '2026-10-01T00:00', '2026-10-31T23:59')).toEqual([
      '2026-10-23T20:00',
    ]);
    // El 30/10/2026 es el 5.º viernes (no todos los meses tienen): queda "el último".
    const last = toRule({ freq: 'monthly', interval: 1, monthlyBy: 'weekday' }, '2026-10-30T20:00');
    expect(between(last, '2026-10-30T20:00', '2026-11-01T00:00', '2026-12-31T23:59')).toEqual([
      '2026-11-27T20:00',
      '2026-12-25T20:00',
    ]);
  });

  it('valida fechas de la serie y la corta antes de una fecha', () => {
    const rule = toRule({ freq: 'weekly', interval: 1 }, '2026-09-06T10:00');
    const start = localToDate('2026-09-06T10:00');
    expect(isOccurrence(rule, start, localToDate('2026-10-11T10:00'))).toBe(true);
    expect(isOccurrence(rule, start, localToDate('2026-10-11T11:00'))).toBe(false);
    const cut = endBefore(rule, localToDate('2026-10-11T10:00'));
    expect(between(cut, '2026-09-06T10:00', '2026-10-01T00:00', '2026-12-31T00:00')).toEqual([
      '2026-10-04T10:00',
    ]);
  });
});
