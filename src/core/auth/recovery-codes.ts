import { randomInt } from 'node:crypto';
import { hashToken } from './tokens.js';

// Códigos de recuperación de la verificación en dos pasos: 10 por usuario, formato "abcd-2345", sin
// caracteres que se confunden al copiarlos a mano (0/o, 1/l/i). Cada uno tiene ~40 bits; además, los
// intentos fallidos cuentan para el bloqueo de la cuenta y el rate limit del login.

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_COUNT = 10;
const PATTERN = /^[a-z2-9]{4}-?[a-z2-9]{4}$/;

export function generateRecoveryCode(): string {
  const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** Sin espacios ni mayúsculas, con guion: así se compara lo que tipea el usuario. */
export function normalizeRecoveryCode(input: string): string | null {
  const compact = input.trim().toLowerCase().replace(/[\s-]/g, '');
  if (!PATTERN.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export const hashRecoveryCode = (code: string) => hashToken(code);
