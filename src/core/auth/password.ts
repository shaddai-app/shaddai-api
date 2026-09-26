import { randomInt } from 'node:crypto';
import argon2 from 'argon2';

// OWASP: argon2id, m=19 MiB, t=2, p=1 como mínimo.
const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTIONS);
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

// Sin caracteres ambiguos (0/O, 1/l/I) para dictar o copiar a mano.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const ALL = UPPER + LOWER + DIGITS;

/** Contraseña temporal de un solo uso (siempre con mayúscula, minúscula y dígito). */
export function generateTemporaryPassword(length = 16): string {
  const pick = (set: string) => set[randomInt(set.length)]!;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)];
  while (chars.length < length) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
