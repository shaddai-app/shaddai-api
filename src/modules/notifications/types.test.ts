import { describe, expect, it } from 'vitest';
import { formatters, NOTIFICATION_TYPES } from './types.js';

describe('formato de fechas de los mails', () => {
  it('fecha del día y fecha con hora, en el idioma del mail', () => {
    expect(formatters('es').date('2026-10-01')).toBe('1 de octubre');
    expect(formatters('en').date('2026-10-01')).toBe('October 1');
    expect(formatters('es').dateTime('2026-10-04T10:00')).toMatch(/domingo, 4 de octubre.*10:00/);
  });

  it('un valor con otro formato no rompe el mail', () => {
    expect(formatters('es').date('01/10/2026')).toBe('');
    expect(formatters('es').date(undefined)).toBe('');
  });

  it('el mail de préstamo vencido incluye la fecha', () => {
    const body = NOTIFICATION_TYPES['loan.overdue'].mail.es.body(
      { item: 'Parlante', code: 'EQ-0003', person: 'Marta', dueAt: '2026-10-01' },
      formatters('es'),
    );
    expect(body.join(' ')).toContain('1 de octubre');
  });
});
