import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  dayOfWeek,
  meetingDateInWeek,
  todayIn,
  weekStart,
} from '../../src/core/time/local-date.js';

describe('fechas locales de la cuenta', () => {
  it('hoy depende de la zona horaria', () => {
    // 02:30 UTC del 1/10 todavía es 30/9 en Buenos Aires (UTC−3).
    const now = new Date('2026-10-01T02:30:00Z');
    expect(todayIn('America/Argentina/Buenos_Aires', now)).toBe('2026-09-30');
    expect(todayIn('UTC', now)).toBe('2026-10-01');
  });

  it('semana que empieza el lunes o el domingo', () => {
    expect(dayOfWeek('2026-09-27')).toBe(0); // domingo
    expect(weekStart('2026-09-27', 1)).toBe('2026-09-21');
    expect(weekStart('2026-09-27', 0)).toBe('2026-09-27');
    expect(weekStart('2026-09-21', 1)).toBe('2026-09-21');
  });

  it('fecha de la reunión dentro de la semana', () => {
    // Semana lunes 21/9: miércoles = 23/9, domingo = 27/9.
    expect(meetingDateInWeek('2026-09-21', 1, 3)).toBe('2026-09-23');
    expect(meetingDateInWeek('2026-09-21', 1, 0)).toBe('2026-09-27');
    // Semana domingo 20/9: sábado = 26/9.
    expect(meetingDateInWeek('2026-09-20', 0, 6)).toBe('2026-09-26');
  });

  it('suma y resta días cruzando meses', () => {
    expect(addDays('2026-09-28', 5)).toBe('2026-10-03');
    expect(daysBetween('2026-09-28', '2026-10-03')).toBe(5);
  });
});
