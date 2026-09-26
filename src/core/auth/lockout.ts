export const MAX_FAILED_ATTEMPTS = 5;
const BASE_LOCK_MINUTES = 15;
const MAX_LOCK_MINUTES = 24 * 60;

/** Bloqueo progresivo: 15 min, 30, 60… hasta 24 h según cuántas veces se bloqueó antes. */
export function lockDurationMs(lockoutLevel: number): number {
  const minutes = Math.min(BASE_LOCK_MINUTES * 2 ** lockoutLevel, MAX_LOCK_MINUTES);
  return minutes * 60_000;
}

export function isLocked(lockedUntil: Date | null, now = new Date()): boolean {
  return lockedUntil !== null && lockedUntil > now;
}

export function retryAfterSeconds(lockedUntil: Date, now = new Date()): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
}
