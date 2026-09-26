import { describe, expect, it } from 'vitest';
import { isLocked, lockDurationMs, retryAfterSeconds } from './lockout.js';

describe('lockout', () => {
  it('duplica la duración en cada bloqueo con tope de 24 h', () => {
    const minutes = [0, 1, 2, 3, 10].map((level) => lockDurationMs(level) / 60_000);
    expect(minutes).toEqual([15, 30, 60, 120, 1440]);
  });

  it('isLocked / retryAfterSeconds', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked(new Date('2025-12-31T23:59:00Z'), now)).toBe(false);
    expect(isLocked(new Date('2026-01-01T00:10:00Z'), now)).toBe(true);
    expect(retryAfterSeconds(new Date('2026-01-01T00:10:00Z'), now)).toBe(600);
  });
});
